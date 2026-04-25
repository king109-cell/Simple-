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
let state = JSON.parse(fs.readFileSync("state.json"));
let failed = [];

// LOAD LEADS
function loadLeads(path) {
  leads = [];
  fs.createReadStream(path)
    .pipe(csv())
    .on("data", (row) => leads.push(row));
}

// SAVE STATE
function saveState() {
  fs.writeFileSync("state.json", JSON.stringify(state));
}

// GET INBOX
function getInbox() {
  return inboxes
    .filter(i => i.sentToday < MAX_PER_INBOX)
    .sort((a, b) => a.sentToday - b.sentToday)[0];
}

// EMAIL BODY
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

// RETRY LOGIC
async function sendWithRetry(inbox, lead, subject, template) {

  let tries = 0;

  while (tries < 3) {
    try {
      await sendEmail(inbox, lead, subject, template);
      return true;
    } catch (e) {
      tries++;
    }
  }

  return false;
}

// DELAY
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ADD INBOX
app.post("/add-inbox", (req, res) => {
  inboxes.push({
    email: req.body.email,
    password: req.body.password,
    sentToday: 0
  });

  res.send("Inbox added");
});

// UPLOAD LEADS
app.post("/upload-leads", upload.single("file"), (req, res) => {
  loadLeads(req.file.path);
  res.send("Leads loaded");
});

// RUN CAMPAIGN
app.post("/run", async (req, res) => {

  const { subject, template, batch } = req.body;
  let sent = 0;

  while (state.index < leads.length && sent < batch) {

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
    sent++;

    await sleep(30000 + Math.random() * 60000);
    saveState();
  }

  res.send(`Sent: ${sent}`);
});

// DOWNLOAD FAILED
app.get("/download-failed", (req, res) => {
  res.download(__dirname + "/failed.csv");
});

app.listen(process.env.PORT || 3000);