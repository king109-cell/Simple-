const express = require("express");
const fs = require("fs");
const multer = require("multer");
const csv = require("csv-parser");
const nodemailer = require("nodemailer");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.static("public"));

const MAX_PER_INBOX = 30;

let leads = [];
let inboxes = [];
let state = { index: 0, sent: 0, running: false };
let failed = [];

// LOAD LEADS
function loadLeads(path) {
  leads = [];
  fs.createReadStream(path)
    .pipe(csv())
    .on("data", (row) => leads.push(row));
}

// GET INBOX
function getInbox() {
  return inboxes
    .filter(i => i.sentToday < MAX_PER_INBOX)
    .sort((a, b) => a.sentToday - b.sentToday)[0];
}

// BUILD EMAIL
function build(template, lead) {
  return template
    .replaceAll("{{name}}", lead.name)
    .replaceAll("{{icebreaker}}", lead.icebreaker);
}

// SEND EMAIL
async function sendEmail(inbox, lead, subject, template) {
  const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    auth: {
      user: inbox.email,
      pass: inbox.password
    }
  });

  await transporter.sendMail({
    from: inbox.email,
    to: lead.email,
    subject: subject || "Quick question",
    text: build(template, lead)
  });

  inbox.sentToday++;
}

// RETRY
async function sendWithRetry(inbox, lead, subject, template) {
  let tries = 0;

  while (tries < 3) {
    try {
      await sendEmail(inbox, lead, subject, template);
      return true;
    } catch {
      tries++;
    }
  }
  return false;
}

// DELAY
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ADD INBOX (WITH ERROR MESSAGE)
app.post("/add-inbox", async (req, res) => {
  const { email, password } = req.body;

  const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    auth: { user: email, pass: password }
  });

  try {
    await transporter.verify();

    inboxes.push({
      email,
      password,
      sentToday: 0
    });

    res.json({ success: true });

  } catch (e) {
    res.json({
      success: false,
      error: e.message
    });
  }
});

// UPLOAD LEADS
app.post("/upload-leads", upload.single("file"), (req, res) => {
  loadLeads(req.file.path);
  state.index = 0;
  state.sent = 0;
  failed = [];
  res.send("Leads loaded");
});

// RUN
app.post("/run", async (req, res) => {

  if (state.running) return res.send("Already running");

  state.running = true;

  const { subject, template, batch } = req.body;

  while (state.index < leads.length && state.sent < batch) {

    const inbox = getInbox();
    if (!inbox) break;

    const lead = leads[state.index];

    const ok = await sendWithRetry(inbox, lead, subject, template);

    if (!ok) {
      failed.push(lead);
      fs.writeFileSync(
        "failed.csv",
        "name,email\n" +
        failed.map(f => `${f.name},${f.email}`).join("\n")
      );
    }

    state.index++;
    state.sent++;

    await sleep(30000 + Math.random() * 60000);
  }

  state.running = false;
  res.send("Done");
});

// STATUS API
app.get("/status", (req, res) => {
  res.json({
    sent: state.sent,
    total: leads.length,
    running: state.running,
    failed
  });
});

// DOWNLOAD FAILED
app.get("/download-failed", (req, res) => {
  res.download(__dirname + "/failed.csv");
});

app.listen(process.env.PORT || 3000);