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

const upload = multer({ dest: "uploads/" });

const LEADS_FILE = "leads.json";
const INBOX_FILE = "inboxes.json";

const LOGIN_PASSWORD = "dwarkadhishxvivek";

let state = {
  running: false,
  sentCount: 0,
  total: 0,
  subject: "",
  template: "",
  batchSize: 10,
  failed: []
};

function ensureFiles() {
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, JSON.stringify([]));
  }

  if (!fs.existsSync(INBOX_FILE)) {
    fs.writeFileSync(INBOX_FILE, JSON.stringify([]));
  }

  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }
}

ensureFiles();

function loadLeads() {
  return JSON.parse(fs.readFileSync(LEADS_FILE));
}

function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function loadInboxes() {
  return JSON.parse(fs.readFileSync(INBOX_FILE));
}

function saveInboxes(inboxes) {
  fs.writeFileSync(INBOX_FILE, JSON.stringify(inboxes, null, 2));
}

function resetDailyCounts() {
  const inboxes = loadInboxes();
  const today = new Date().toDateString();

  let changed = false;

  inboxes.forEach((inbox) => {
    if (inbox.lastReset !== today) {
      inbox.sentToday = 0;
      inbox.lastReset = today;
      changed = true;
    }
  });

  if (changed) {
    saveInboxes(inboxes);
  }
}

setInterval(resetDailyCounts, 60000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
}

function getBestInbox() {
  const inboxes = loadInboxes();

  const available = inboxes.filter((i) => i.sentToday < 30);

  if (available.length === 0) return null;

  available.sort((a, b) => a.sentToday - b.sentToday);

  return available[0];
}

async function sendEmailWithRetry(mailOptions, inbox, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
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

      await transporter.sendMail(mailOptions);

      return true;
    } catch (err) {
      console.log(`Attempt ${i} failed:`, err.message);

      if (i === retries) {
        return false;
      }

      await delay(3000);
    }
  }
}

async function runSender() {
  if (state.running) return;

  state.running = true;

  while (state.running) {
    let leads = loadLeads();

    if (leads.length === 0) {
      state.running = false;
      break;
    }

    if (state.sentCount >= state.batchSize) {
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

    const personalized = state.template
      .replace(/{{name}}/g, lead.name || "")
      .replace(/{{icebreaker}}/g, lead.icebreaker || "");

    const mailOptions = {
      from: inbox.email,
      to: lead.email,
      subject: state.subject,
      html: personalized
    };

    const success = await sendEmailWithRetry(mailOptions, inbox);

    if (success) {
      inbox.sentToday += 1;

      const inboxes = loadInboxes().map((i) => {
        if (i.email === inbox.email) {
          i.sentToday = inbox.sentToday;
        }
        return i;
      });

      saveInboxes(inboxes);

      state.sentCount++;

      leads.shift();

      saveLeads(leads);

      console.log(`Sent to ${lead.email}`);
    } else {
      state.failed.push({
        lead,
        time: new Date().toISOString()
      });

      leads.shift();

      saveLeads(leads);

      console.log(`Failed ${lead.email}`);
    }

    const wait = randomDelay();

    console.log(`Waiting ${wait / 1000}s`);

    await delay(wait);
  }
}

app.post("/login", (req, res) => {
  const { password } = req.body;

  if (password === LOGIN_PASSWORD) {
    return res.json({ success: true });
  }

  res.status(401).json({
    success: false,
    message: "Invalid password"
  });
});

app.post("/add-inbox", async (req, res) => {
  try {
    const { email, password } = req.body;

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

    const inboxes = loadInboxes();

    inboxes.push({
      email,
      password,
      sentToday: 0,
      lastReset: new Date().toDateString()
    });

    saveInboxes(inboxes);

    res.json({
      success: true,
      message: "Inbox added"
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

app.post("/remove-inbox", (req, res) => {
  const { index } = req.body;

  const inboxes = loadInboxes();

  inboxes.splice(index, 1);

  saveInboxes(inboxes);

  res.json({ success: true });
});

app.post("/clear-inboxes", (req, res) => {
  saveInboxes([]);
  res.json({ success: true });
});

app.post("/upload-leads", upload.single("file"), (req, res) => {
  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => {
      if (data.email) {
        results.push({
          name: data.name || "",
          email: data.email || "",
          icebreaker: data.icebreaker || ""
        });
      }
    })
    .on("end", () => {
      saveLeads(results);

      fs.unlinkSync(req.file.path);

      res.json({
        success: true,
        total: results.length
      });
    });
});

app.post("/remove-lead", (req, res) => {
  const { index } = req.body;

  const leads = loadLeads();

  leads.splice(index, 1);

  saveLeads(leads);

  res.json({ success: true });
});

app.post("/clear-leads", (req, res) => {
  saveLeads([]);
  res.json({ success: true });
});

app.post("/run", async (req, res) => {
  const { subject, template, batch } = req.body;

  state.subject = subject;
  state.template = template;
  state.batchSize = Number(batch) || 10;
  state.sentCount = 0;
  state.total = loadLeads().length;
  state.failed = [];

  runSender();

  res.json({
    success: true
  });
});

app.post("/stop", (req, res) => {
  state.running = false;

  res.json({
    success: true
  });
});

app.get("/status", (req, res) => {
  res.json({
    running: state.running,
    sentCount: state.sentCount,
    total: state.total,
    inboxes: loadInboxes().map((i) => ({
      email: i.email,
      sentToday: i.sentToday
    })),
    leads: loadLeads(),
    failed: state.failed
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});