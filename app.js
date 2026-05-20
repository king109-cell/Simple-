const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const app = express();
const PORT = 3000;

// ─── Config ────────────────────────────────────────────────────────────────
const PASSWORD = process.env.APP_PASSWORD || "vivek";
const LEADS_FILE = path.join(__dirname, "leads.json");
const INBOXES_FILE = path.join(__dirname, "inboxes.json");
const MAX_DAILY_SEND = 30;

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage() });

// ─── State ──────────────────────────────────────────────────────────────────
let state = {
  running: false,
  sent: 0,
  failed: [],
  subject: "",
  template: "",
  batchSize: 10,
  stopFlag: false,
  sendLog: [],
};

// ─── Persistence helpers ─────────────────────────────────────────────────────
function loadLeads() {
  try {
    if (fs.existsSync(LEADS_FILE)) return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
  } catch {}
  return [];
}

function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function loadInboxes() {
  try {
    if (fs.existsSync(INBOXES_FILE)) return JSON.parse(fs.readFileSync(INBOXES_FILE, "utf8"));
  } catch {}
  return [];
}

function saveInboxes(inboxes) {
  fs.writeFileSync(INBOXES_FILE, JSON.stringify(inboxes, null, 2));
}

// ─── Daily reset at midnight ─────────────────────────────────────────────────
function scheduleDailyReset() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight - now;

  setTimeout(() => {
    const inboxes = loadInboxes();
    inboxes.forEach((inbox) => {
      inbox.sentToday = 0;
      inbox.lastReset = new Date().toISOString();
    });
    saveInboxes(inboxes);
    console.log("[RESET] Daily send counters reset at midnight");
    scheduleDailyReset();
  }, msUntilMidnight);
}

scheduleDailyReset();

// ─── Auth middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (token !== PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── SMTP verify helper ──────────────────────────────────────────────────────
async function verifySmtp(email, password) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: email, pass: password },
  });
  await transporter.verify();
  return transporter;
}

// ─── Send one email ──────────────────────────────────────────────────────────
async function sendEmail(inbox, to, subject, html, attempts = 0) {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: inbox.email, pass: inbox.password },
    });
    await transporter.sendMail({ from: inbox.email, to, subject, html });
    return { success: true };
  } catch (err) {
    if (attempts < 2) {
      await delay(5000);
      return sendEmail(inbox, to, subject, html, attempts + 1);
    }
    return { success: false, error: err.message };
  }
}

// ─── Delay helper ────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  const ms = (30 + Math.random() * 60) * 1000;
  return delay(ms);
}

// ─── Pick best inbox (lowest sentToday, under limit) ─────────────────────────
function pickInbox(inboxes) {
  const available = inboxes.filter((i) => i.sentToday < MAX_DAILY_SEND);
  if (!available.length) return null;
  return available.sort((a, b) => a.sentToday - b.sentToday)[0];
}

// ─── Build email body from template ──────────────────────────────────────────
function buildEmail(template, lead) {
  return template
    .replace(/\{\{name\}\}/gi, lead.name || "")
    .replace(/\{\{icebreaker\}\}/gi, lead.icebreaker || "")
    .replace(/\{\{email\}\}/gi, lead.email || "")
    .replace(/\n/g, "<br>");
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /login
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.json({ success: true, token: PASSWORD });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

// POST /add-inbox
app.post("/add-inbox", requireAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  try {
    await verifySmtp(email, password);
    const inboxes = loadInboxes();
    if (inboxes.find((i) => i.email === email))
      return res.status(400).json({ error: "Inbox already exists" });

    inboxes.push({ email, password, sentToday: 0, lastReset: new Date().toISOString() });
    saveInboxes(inboxes);
    res.json({ success: true, message: `${email} verified and added` });
  } catch (err) {
    res.status(400).json({ error: `SMTP verification failed: ${err.message}` });
  }
});

// POST /remove-inbox
app.post("/remove-inbox", requireAuth, (req, res) => {
  const { index } = req.body;
  const inboxes = loadInboxes();
  if (index < 0 || index >= inboxes.length) return res.status(400).json({ error: "Invalid index" });
  const removed = inboxes.splice(index, 1)[0];
  saveInboxes(inboxes);
  res.json({ success: true, message: `${removed.email} removed` });
});

// POST /clear-inboxes
app.post("/clear-inboxes", requireAuth, (req, res) => {
  saveInboxes([]);
  res.json({ success: true });
});

// POST /upload-leads  (CSV with columns: name, email, icebreaker)
app.post("/upload-leads", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const results = [];
  const readable = Readable.from(req.file.buffer.toString("utf8"));

  readable
    .pipe(csv())
    .on("data", (row) => {
      const email = (row.email || row.Email || "").trim();
      const name = (row.name || row.Name || "").trim();
      const icebreaker = (row.icebreaker || row.Icebreaker || "").trim();
      if (email && email.includes("@")) {
        results.push({ name, email, icebreaker });
      }
    })
    .on("end", () => {
      const existing = loadLeads();
      const combined = [...existing, ...results];
      // dedupe by email
      const deduped = Array.from(new Map(combined.map((l) => [l.email, l])).values());
      saveLeads(deduped);
      res.json({ success: true, added: results.length, total: deduped.length });
    })
    .on("error", (err) => {
      res.status(500).json({ error: err.message });
    });
});

// POST /remove-lead
app.post("/remove-lead", requireAuth, (req, res) => {
  const { email } = req.body;
  let leads = loadLeads();
  leads = leads.filter((l) => l.email !== email);
  saveLeads(leads);
  res.json({ success: true });
});

// POST /clear-leads
app.post("/clear-leads", requireAuth, (req, res) => {
  saveLeads([]);
  res.json({ success: true });
});

// POST /run
app.post("/run", requireAuth, async (req, res) => {
  if (state.running) return res.status(400).json({ error: "Already running" });

  const { subject, template, batchSize } = req.body;
  if (!subject || !template) return res.status(400).json({ error: "Subject and template required" });

  const leads = loadLeads();
  if (!leads.length) return res.status(400).json({ error: "No leads loaded" });

  const inboxes = loadInboxes();
  if (!inboxes.length) return res.status(400).json({ error: "No inboxes configured" });

  state.running = true;
  state.stopFlag = false;
  state.sent = 0;
  state.failed = [];
  state.subject = subject;
  state.template = template;
  state.batchSize = parseInt(batchSize) || 10;
  state.sendLog = [];

  res.json({ success: true, message: "Sending started", total: Math.min(leads.length, state.batchSize) });

  // ── Async send loop ──────────────────────────────────────────────────────
  (async () => {
    const batch = leads.slice(0, state.batchSize);
    const remaining = leads.slice(state.batchSize);

    for (let i = 0; i < batch.length; i++) {
      if (state.stopFlag) break;

      const lead = batch[i];
      const currentInboxes = loadInboxes();
      const inbox = pickInbox(currentInboxes);

      if (!inbox) {
        console.log("[STOP] All inboxes hit daily limit");
        break;
      }

      const body = buildEmail(state.template, lead);
      const result = await sendEmail(inbox, lead.email, state.subject, body);

      if (result.success) {
        state.sent++;
        inbox.sentToday++;
        state.sendLog.push({ email: lead.email, name: lead.name, inbox: inbox.email, time: new Date().toISOString(), status: "sent" });
        console.log(`[SENT] ${lead.email} via ${inbox.email} (${i + 1}/${batch.length})`);
      } else {
        state.failed.push({ email: lead.email, error: result.error });
        state.sendLog.push({ email: lead.email, name: lead.name, inbox: inbox.email, time: new Date().toISOString(), status: "failed", error: result.error });
        console.log(`[FAIL] ${lead.email} — ${result.error}`);
      }

      // Update inbox sentToday in file
      const updatedInboxes = loadInboxes();
      const idx = updatedInboxes.findIndex((x) => x.email === inbox.email);
      if (idx !== -1) {
        updatedInboxes[idx].sentToday = inbox.sentToday;
        saveInboxes(updatedInboxes);
      }

      // Remove sent lead (whether success or fail)
      const allLeads = loadLeads();
      const updatedLeads = allLeads.filter((l) => l.email !== lead.email);
      saveLeads(updatedLeads);

      // Random delay between emails (skip after last)
      if (i < batch.length - 1 && !state.stopFlag) {
        await randomDelay();
      }
    }

    state.running = false;
    console.log(`[DONE] Sent: ${state.sent}, Failed: ${state.failed.length}`);
  })();
});

// POST /stop
app.post("/stop", requireAuth, (req, res) => {
  state.stopFlag = true;
  res.json({ success: true, message: "Stop signal sent" });
});

// GET /status
app.get("/status", requireAuth, (req, res) => {
  const leads = loadLeads();
  const inboxes = loadInboxes();

  res.json({
    running: state.running,
    sent: state.sent,
    totalLeads: leads.length,
    batchSize: state.batchSize,
    failed: state.failed,
    inboxes: inboxes.map((i) => ({ email: i.email, sentToday: i.sentToday, lastReset: i.lastReset })),
    leads: leads.slice(0, 10),
    sendLog: state.sendLog.slice(-20),
  });
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Cold Email Tool running at http://localhost:${PORT}`);
  console.log(`🔑 Password: ${PASSWORD}`);
  console.log(`📬 Max daily per inbox: ${MAX_DAILY_SEND}\n`);
});