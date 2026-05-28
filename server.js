const express = require("express");
const cron = require("node-cron");
const fetch = require("node-fetch");
const fse = require("fs-extra");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Data persistence ─────────────────────────────────────────
async function loadData() {
  try {
    return await fse.readJson(DATA_FILE);
  } catch {
    return { alarms: [], settings: {}, logs: [] };
  }
}

async function saveData(data) {
  await fse.writeJson(DATA_FILE, data, { spaces: 2 });
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function addLog(data, msg) {
  const now = new Date();
  const time = now.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });
  data.logs = [{ time, msg, ts: Date.now() }, ...(data.logs || [])].slice(0, 30);
  console.log(`[${time}] ${msg}`);
}

// ── API — Alarms ─────────────────────────────────────────────
app.get("/api/alarms", async (req, res) => {
  const data = await loadData();
  res.json(data.alarms || []);
});

app.post("/api/alarms", async (req, res) => {
  const data = await loadData();
  const alarm = { id: uid(), ...req.body, fired: false, enabled: true };
  data.alarms = [...(data.alarms || []), alarm];
  await saveData(data);
  res.json(alarm);
});

app.patch("/api/alarms/:id", async (req, res) => {
  const data = await loadData();
  data.alarms = (data.alarms || []).map(a =>
    a.id === req.params.id ? { ...a, ...req.body } : a
  );
  await saveData(data);
  res.json({ ok: true });
});

app.delete("/api/alarms/:id", async (req, res) => {
  const data = await loadData();
  data.alarms = (data.alarms || []).filter(a => a.id !== req.params.id);
  await saveData(data);
  res.json({ ok: true });
});

// ── API — Settings ───────────────────────────────────────────
app.get("/api/settings", async (req, res) => {
  const data = await loadData();
  res.json(data.settings || {});
});

app.post("/api/settings", async (req, res) => {
  const data = await loadData();
  data.settings = req.body;
  await saveData(data);
  res.json({ ok: true });
});

// ── API — Logs ───────────────────────────────────────────────
app.get("/api/logs", async (req, res) => {
  const data = await loadData();
  res.json(data.logs || []);
});

// ── Alarm firing logic ───────────────────────────────────────
async function fireAlarm(alarm) {
  const data = await loadData();
  const settings = data.settings || {};
  const dt = new Date(alarm.datetime);
  const timeLabel = dt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });

  addLog(data, `⏰ שעון מעורר ${timeLabel} פועל!`);

  // Mark as fired immediately
  data.alarms = data.alarms.map(a => a.id === alarm.id ? { ...a, fired: true } : a);
  await saveData(data);

  if (!settings.openaiKey) {
    addLog(data, "❌ חסר OpenAI API Key — לך להגדרות");
    await saveData(data);
    return;
  }

  // Call OpenAI
  let gptResponse = "";
  try {
    addLog(data, "🤖 שולח ל-ChatGPT...");
    await saveData(data);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.openaiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: alarm.prompt }],
        max_tokens: 800
      })
    });

    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    gptResponse = json.choices?.[0]?.message?.content;
    if (!gptResponse) throw new Error("אין תשובה מ-GPT");

    addLog(data, "✅ קיבלתי תשובה מ-ChatGPT");
    await saveData(data);
  } catch (err) {
    addLog(data, `❌ שגיאת ChatGPT: ${err.message}`);
    await saveData(data);
    return;
  }

  // Send email via EmailJS
  const { emailjsServiceId, emailjsTemplateId, emailjsPublicKey, toEmail } = settings;
  if (emailjsServiceId && emailjsTemplateId && emailjsPublicKey && toEmail) {
    try {
      addLog(data, "📧 שולח אימייל...");
      await saveData(data);

      const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: emailjsServiceId,
          template_id: emailjsTemplateId,
          user_id: emailjsPublicKey,
          template_params: {
            to_email: toEmail,
            alarm_time: timeLabel,
            alarm_prompt: alarm.prompt,
            gpt_response: gptResponse
          }
        })
      });

      if (r.ok) {
        addLog(data, "✅ אימייל נשלח בהצלחה!");
      } else {
        addLog(data, `❌ שגיאה בשליחת אימייל: ${await r.text()}`);
      }
    } catch (err) {
      addLog(data, `❌ שגיאת אימייל: ${err.message}`);
    }
  } else {
    addLog(data, "⚠️ הגדר EmailJS בהגדרות כדי לקבל אימייל");
  }

  await saveData(data);
}

// ── Cron: check every minute ─────────────────────────────────
cron.schedule("* * * * *", async () => {
  const now = new Date();
  const data = await loadData();
  const alarms = data.alarms || [];

  const toFire = alarms.filter(a => {
    if (!a.enabled || a.fired) return false;
    const dt = new Date(a.datetime);
    return (
      dt.getFullYear() === now.getFullYear() &&
      dt.getMonth() === now.getMonth() &&
      dt.getDate() === now.getDate() &&
      dt.getHours() === now.getHours() &&
      dt.getMinutes() === now.getMinutes()
    );
  });

  for (const alarm of toFire) {
    await fireAlarm(alarm);
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AlarmGPT שרת פועל על פורט ${PORT}`);
});
