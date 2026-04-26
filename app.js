const express = require("express");
const fs = require("fs");
const multer = require("multer");
const csv = require("csv-parser");
const nodemailer = require("nodemailer");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.static("public"));

const TOOL_PASSWORD = "dwarkadhish@vivek"; // change this
const MAX_PER_INBOX = 30;

let leads = [];
let inboxes = [];
let state = { index: 0, sent: 0, running: false };
let failed = [];

// LOAD
if (fs.existsSync("leads.json")) leads = JSON.parse(fs.readFileSync("leads.json"));
if (fs.existsSync("inboxes.json")) inboxes = JSON.parse(fs.readFileSync("inboxes.json"));
if (fs.existsSync("state.json")) state = JSON.parse(fs.readFileSync("state.json"));

// SAVE
function save() {
  fs.writeFileSync("leads.json", JSON.stringify(leads));
  fs.writeFileSync("inboxes.json", JSON.stringify(inboxes));
  fs.writeFileSync("state.json", JSON.stringify(state));
}

// 🔥 DAILY RESET FUNCTION
function resetIfNewDay(inbox) {
  const today = new Date().toDateString();

  if (inbox.lastReset !== today) {
    inbox.sentToday = 0;
    inbox.lastReset = today;
  }
}

// LOGIN
app.post("/login", (req, res) => {
  res.json({ success: req.body.password === TOOL_PASSWORD });
});

// ADD INBOX
app.post("/add-inbox", async (req, res) => {
  const { email, password } = req.body;

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: email, pass: password }
  });

  try {
    await transporter.verify();

    inboxes.push({
      email,
      password,
      sentToday: 0,
      lastReset: new Date().toDateString()
    });

    save();

    res.json({ success: true });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// REMOVE INBOX
app.post("/remove-inbox", (req, res) => {
  inboxes.splice(req.body.index, 1);
  save();
  res.send("ok");
});

// CLEAR INBOXES
app.post("/clear-inboxes", (req, res) => {
  inboxes = [];
  save();
  res.send("ok");
});

// UPLOAD LEADS
app.post("/upload-leads", upload.single("file"), (req, res) => {
  leads = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", row => leads.push(row))
    .on("end", () => {
      state.index = 0;
      state.sent = 0;
      failed = [];
      save();
      res.send("loaded");
    });
});

// CLEAR LEADS
app.post("/clear-leads", (req, res) => {
  leads = [];
  state = { index: 0, sent: 0, running: false };
  failed = [];
  save();
  res.send("ok");
});

// REMOVE LEAD
app.post("/remove-lead", (req, res) => {
  leads.splice(req.body.index, 1);
  save();
  res.send("ok");
});

// BUILD EMAIL
function build(template, lead) {
  return template
    .replaceAll("{{name}}", lead.name || "")
    .replaceAll("{{icebreaker}}", lead.icebreaker || "");
}

// GET INBOX (WITH DAILY RESET)
function getInbox() {

  inboxes.forEach(i => resetIfNewDay(i));
  save();

  return inboxes
    .filter(i => i.sentToday < MAX_PER_INBOX)
    .sort((a, b) => a.sentToday - b.sentToday)[0];
}

// SEND EMAIL
async function sendEmail(inbox, lead, subject, template) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: inbox.email, pass: inbox.password }
  });

  await transporter.sendMail({
    from: inbox.email,
    to: lead.email,
    subject,
    text: build(template, lead)
  });

  inbox.sentToday++;
  save();
}

// RETRY
async function sendWithRetry(inbox, lead, subject, template) {
  for (let i = 0; i < 3; i++) {
    try {
      await sendEmail(inbox, lead, subject, template);
      return true;
    } catch {}
  }
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// SENDER
async function start() {
  while (state.running && state.index < leads.length && state.sent < state.batch) {

    const inbox = getInbox();
    if (!inbox) break;

    const lead = leads[state.index];

    const ok = await sendWithRetry(inbox, lead, state.subject, state.template);

    if (!ok) failed.push(lead);

    state.index++;
    state.sent++;
    save();

    await sleep(30000 + Math.random() * 60000);
  }

  state.running = false;
  save();
}

// RUN
app.post("/run", (req, res) => {
  if (state.running) return res.send("running");

  state.running = true;
  state.subject = req.body.subject;
  state.template = req.body.template;
  state.batch = req.body.batch;

  save();
  start();

  res.send("started");
});

// STOP
app.post("/stop", (req, res) => {
  state.running = false;
  save();
  res.send("stopped");
});

// STATUS
app.get("/status", (req, res) => {
  res.json({
    sent: state.sent,
    total: leads.length,
    running: state.running,
    inboxes,
    leads
  });
});

// AUTO RESUME
if (state.running) start();

app.listen(process.env.PORT || 3000);