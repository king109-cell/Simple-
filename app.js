const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const csv = require("csv-parser");
const nodemailer = require("nodemailer");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const LOGIN_PASSWORD = "dwarkadhishxvivek";

const LEADS_FILE = "leads.json";
const INBOXES_FILE = "inboxes.json";

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

if (!fs.existsSync(LEADS_FILE)) {
  fs.writeFileSync(LEADS_FILE, "[]");
}

if (!fs.existsSync(INBOXES_FILE)) {
  fs.writeFileSync(INBOXES_FILE, "[]");
}

const upload = multer({ dest: "uploads/" });

let state = {
  running: false,
  sent: 0,
  total: 0,
  subject: "",
  template: "",
  batch: 10,
  failed: []
};

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getLeads() {
  return readJSON(LEADS_FILE);
}

function saveLeads(leads) {
  writeJSON(LEADS_FILE, leads);
}

function getInboxes() {
  return readJSON(INBOXES_FILE);
}

function saveInboxes(inboxes) {
  writeJSON(INBOXES_FILE, inboxes);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
}

function resetDailyCounts() {
  const inboxes = getInboxes();
  const today = new Date().toDateString();

  let updated = false;

  inboxes.forEach(inbox => {
    if (inbox.lastReset !== today) {
      inbox.sentToday = 0;
      inbox.lastReset = today;
      updated = true;
    }
  });

  if (updated) {
    saveInboxes(inboxes);
  }
}

setInterval(resetDailyCounts, 60000);

function getBestInbox() {
  resetDailyCounts();

  const inboxes = getInboxes();

  const available = inboxes.filter(i => i.sentToday < 30);

  if (available.length === 0) return null;

  available.sort((a, b) => a.sentToday - b.sentToday);

  return available[0];
}

async function sendEmail(inbox, lead, subject, template) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: inbox.email,
      pass: inbox.password
    }
  });

  let html = template
    .replace(/{{name}}/g, lead.name || "")
    .replace(/{{icebreaker}}/g, lead.icebreaker || "");

  await transporter.sendMail({
    from: inbox.email,
    to: lead.email,
    subject,
    html
  });
}

async function startSending() {
  while (state.running) {
    let leads = getLeads();

    if (leads.length === 0) {
      state.running = false;
      break;
    }

    if (state.sent >= state.batch) {
      state.running = false;
      break;
    }

    const lead = leads[0];

    if (!lead || !lead.email) {
      leads.shift();
      saveLeads(leads);
      continue;
    }

    const inbox = getBestInbox();

    if (!inbox) {
      console.log("No inbox available.");
      state.running = false;
      break;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sendEmail(
          inbox,
          lead,
          state.subject,
          state.template
        );

        inbox.sentToday += 1;

        const inboxes = getInboxes().map(i =>
          i.email === inbox.email ? inbox : i
        );

        saveInboxes(inboxes);

        leads.shift();
        saveLeads(leads);

        state.sent += 1;

        console.log(`Sent to ${lead.email}`);

        break;

      } catch (err) {

        console.log(`Attempt ${attempt} failed`);
        console.log(err);

        if (attempt === 3) {
          state.failed.push({
            lead,
            error: err.message,
            time: new Date().toISOString()
          });

          leads.shift();
          saveLeads(leads);
        }

        await delay(3000);
      }
    }

    if (!state.running) break;

    const wait = randomDelay();

    console.log(`Waiting ${wait / 1000}s`);

    for (let i = 0; i < wait / 1000; i++) {

      if (!state.running) {
        break;
      }

      await delay(1000);
    }
  }

  state.running = false;
}

app.post("/login", (req, res) => {
  const { password } = req.body;

  if (password === LOGIN_PASSWORD) {
    return res.json({ success: true });
  }

  res.status(401).json({
    success: false,
    message: "Wrong password"
  });
});

app.post("/add-inbox", async (req, res) => {
  try {

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and app password required"
      });
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: email,
        pass: password
      }
    });

    await transporter.verify();

    const inboxes = getInboxes();

    if (inboxes.find(i => i.email === email)) {
      return res.status(400).json({
        success: false,
        message: "Inbox already added"
      });
    }

    inboxes.push({
      email,
      password,
      sentToday: 0,
      lastReset: new Date().toDateString()
    });

    saveInboxes(inboxes);

    console.log("Inbox added successfully:", email);

    res.json({
      success: true,
      message: "Inbox added successfully"
    });

  } catch (err) {

    console.log("========== SMTP ERROR ==========");
    console.log(err);
    console.log("================================");

    res.status(500).json({
      success: false,
      message: err.message,
      fullError: JSON.stringify(err, null, 2)
    });
  }
});

app.post("/remove-inbox", (req, res) => {
  const { index } = req.body;

  let inboxes = getInboxes();

  inboxes.splice(index, 1);

  saveInboxes(inboxes);

  res.json({ success: true });
});

app.post("/clear-inboxes", (req, res) => {
  saveInboxes([]);

  res.json({ success: true });
});

app.post("/upload-leads", upload.single("file"), (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "CSV file required"
    });
  }

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", data => {

      if (data.email) {

        results.push({
          id: Date.now() + Math.random().toString(36),
          name: data.name || "",
          email: data.email || "",
          icebreaker: data.icebreaker || ""
        });
      }
    })

    .on("end", () => {

      const leads = getLeads();

      saveLeads([...leads, ...results]);

      fs.unlinkSync(req.file.path);

      res.json({
        success: true,
        count: results.length
      });
    });
});

app.post("/remove-lead", (req, res) => {

  const { id } = req.body;

  let leads = getLeads();

  leads = leads.filter(
    lead => lead.id !== id
  );

  saveLeads(leads);

  res.json({ success: true });
});

app.post("/clear-leads", (req, res) => {
  saveLeads([]);

  res.json({ success: true });
});

app.post("/run", async (req, res) => {

  if (state.running) {
    return res.status(400).json({
      success: false,
      message: "Already running"
    });
  }

  const { subject, template, batch } = req.body;

  state.running = true;
  state.sent = 0;
  state.subject = subject;
  state.template = template;
  state.batch = parseInt(batch) || 10;
  state.total = getLeads().length;

  startSending();

  res.json({
    success: true,
    message: "Started"
  });
});

app.post("/stop", (req, res) => {
  state.running = false;

  res.json({
    success: true,
    message: "Stopped"
  });
});

app.get("/status", (req, res) => {
  res.json({
    running: state.running,
    sent: state.sent,
    total: getLeads().length,
    inboxes: getInboxes().map(i => ({
      email: i.email,
      sentToday: i.sentToday
    })),
    leads: getLeads().slice(0, 10),
    failed: state.failed
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});