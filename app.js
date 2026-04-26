const express = require("express");
const fs = require("fs");
const multer = require("multer");
const csv = require("csv-parser");
const nodemailer = require("nodemailer");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.static("public"));

const TOOL_PASSWORD = "mysecret123";
const MAX_PER_INBOX = 30;

let leads = [];
let inboxes = [];
let state = { index: 0, sent: 0, running: false };
let failed = [];

// LOAD DATA
if (fs.existsSync("leads.json")) leads = JSON.parse(fs.readFileSync("leads.json"));
if (fs.existsSync("inboxes.json")) inboxes = JSON.parse(fs.readFileSync("inboxes.json"));
if (fs.existsSync("state.json")) state = JSON.parse(fs.readFileSync("state.json"));

// SAVE
function saveData() {
  fs.writeFileSync("leads.json", JSON.stringify(leads));
  fs.writeFileSync("inboxes.json", JSON.stringify(inboxes));
  fs.writeFileSync("state.json", JSON.stringify(state));
}

// LOGIN
app.post("/login", (req, res) => {
  res.json({ success: req.body.password === TOOL_PASSWORD });
});

// LOAD CSV → SAVE
function loadLeads(path) {
  leads = [];
  fs.createReadStream(path)
    .pipe(csv())
    .on("data", (row) => leads.push(row))
    .on("end", () => saveData());
}

// REMOVE LEAD
app.post("/remove-lead", (req, res) => {
  const { index } = req.body;
  leads.splice(index, 1);
  saveData();
  res.send("removed");
});

// CLEAR LEADS
app.post("/clear-leads", (req, res) => {
  leads = [];
  state = { index: 0, sent: 0, running: false };
  failed = [];
  saveData();
  res.send("cleared");
});

// INBOX ROTATION
function getInbox() {
  return inboxes
    .filter(i => i.sentToday < MAX_PER_INBOX)
    .sort((a, b) => a.sentToday - b.sentToday)[0];
}

// REMOVE INBOX
app.post("/remove-inbox", (req, res) => {
  const { index } = req.body;
  inboxes.splice(index, 1);
  saveData();
  res.send("removed");
});

// CLEAR INBOXES
app.post("/clear-inboxes", (req, res) => {
  inboxes = [];
  saveData();
  res.send("cleared");
});

// BUILD
function build(template, lead) {
  return template
    .replaceAll("{{name}}", lead.name || "")
    .replaceAll("{{icebreaker}}", lead.icebreaker || "");
}

// SEND
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
  saveData();
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

// DELAY
const sleep = ms => new Promise(r => setTimeout(r, ms));

// SENDER
async function startSending() {
  while (state.running && state.index < leads.length && state.sent < state.batch) {

    const inbox = getInbox();
    if (!inbox) break;

    const lead = leads[state.index];

    const ok = await sendWithRetry(inbox, lead, state.subject, state.template);

    if (!ok) {
      failed.push(lead);
      fs.writeFileSync("failed.csv",
        "name,email\n" +
        failed.map(f => `${f.name},${f.email}`).join("\n")
      );
    }

    state.index++;
    state.sent++;
    saveData();

    await sleep(30000 + Math.random() * 60000);
  }

  state.running = false;
  saveData();
}

// ROUTES
app.post("/upload-leads", upload.single("file"), (req, res) => {
  loadLeads(req.file.path);
  state.index = 0;
  state.sent = 0;
  failed = [];
  res.send("loaded");
});

app.post("/run", (req, res) => {
  if (state.running) return res.send("running");

  state.running = true;
  state.subject = req.body.subject;
  state.template = req.body.template;
  state.batch = req.body.batch;

  saveData();
  startSending();

  res.send("started");
});

app.post("/stop", (req, res) => {
  state.running = false;
  saveData();
  res.send("stopped");
});

app.get("/status", (req, res) => {
  res.json({
    sent: state.sent,
    total: leads.length,
    running: state.running,
    inboxes,
    leads
  });
});

app.get("/download-failed", (req, res) => {
  res.download(__dirname + "/failed.csv");
});

// AUTO RESUME
if (state.running) startSending();

app.listen(process.env.PORT || 3000);