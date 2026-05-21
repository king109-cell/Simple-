const express = require("express");
const fs = require("fs");
const multer = require("multer");
const csv = require("csv-parser");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const LOGIN_PASSWORD = "dwarkadhishxvivek";

const LEADS_FILE = "leads.json";
const INBOXES_FILE = "inboxes.json";

if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, "[]");
if (!fs.existsSync(INBOXES_FILE)) fs.writeFileSync(INBOXES_FILE, "[]");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({ dest: "uploads/" });

let state = {
  running: false,
  sent: 0,
  batch: 10,
  subject: "",
  template: ""
};

// ---------- HELPERS ----------
function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
}

// ---------- CORE DATA ----------
const getLeads = () => read(LEADS_FILE);
const saveLeads = (d) => write(LEADS_FILE, d);

const getInboxes = () => read(INBOXES_FILE);
const saveInboxes = (d) => write(INBOXES_FILE, d);

// ---------- INBOX ROTATION ----------
function getBestInbox() {
  const inboxes = getInboxes();

  const valid = inboxes.filter(i => i.sentToday < 30);

  if (!valid.length) return null;

  valid.sort((a, b) => a.sentToday - b.sentToday);

  return valid[0];
}

// ---------- EMAIL ----------
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

  const html = template
    .replace(/{{name}}/g, lead.name || "")
    .replace(/{{icebreaker}}/g, lead.icebreaker || "");

  await transporter.sendMail({
    from: inbox.email,
    to: lead.email,
    subject,
    html
  });
}

// ---------- SENDING ENGINE ----------
async function startSending() {

  console.log("START SENDING TRIGGERED");

  while (state.running) {

    const leads = getLeads();

    if (!leads.length) {
      console.log("NO LEADS LEFT");
      state.running = false;
      break;
    }

    if (state.sent >= state.batch) {
      console.log("BATCH COMPLETE");
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
      console.log("NO INBOX AVAILABLE");
      state.running = false;
      break;
    }

    let success = false;

    for (let i = 1; i <= 3; i++) {
      try {

        console.log(`SENDING TO ${lead.email} (TRY ${i})`);

        await sendEmail(inbox, lead, state.subject, state.template);

        console.log("SENT SUCCESS:", lead.email);

        inbox.sentToday += 1;

        const inboxes = getInboxes().map(x =>
          x.email === inbox.email ? inbox : x
        );

        saveInboxes(inboxes);

        leads.shift();
        saveLeads(leads);

        state.sent++;

        success = true;
        break;

      } catch (err) {

        console.log("EMAIL ERROR:", err.message);

        if (i === 3) {
          console.log("FAILED FINAL:", lead.email);

          leads.shift();
          saveLeads(leads);
        }

        await delay(3000);
      }
    }

    if (!state.running) break;

    await delay(randomDelay());
  }

  state.running = false;
}

// ---------- AUTH ----------
app.post("/login", (req, res) => {
  if (req.body.password === LOGIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

// ---------- INBOX ----------
app.post("/add-inbox", async (req, res) => {
  try {

    const { email, password } = req.body;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: email, pass: password }
    });

    await transporter.verify();

    const inboxes = getInboxes();

    if (inboxes.find(i => i.email === email)) {
      return res.json({ success: false, message: "Already exists" });
    }

    inboxes.push({
      email,
      password,
      sentToday: 0,
      lastReset: new Date().toDateString()
    });

    saveInboxes(inboxes);

    res.json({ success: true });

  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- LEADS ----------
app.post("/upload-leads", upload.single("file"), (req, res) => {

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", row => {
      if (row.email) {
        results.push({
          name: row.name || "",
          email: row.email,
          icebreaker: row.icebreaker || ""
        });
      }
    })
    .on("end", () => {
      const leads = getLeads();
      saveLeads([...leads, ...results]);
      fs.unlinkSync(req.file.path);
      res.json({ success: true, count: results.length });
    });
});

// ---------- RUN ----------
app.post("/run", async (req, res) => {

  if (state.running) {
    return res.json({ success: false, message: "Already running" });
  }

  state.running = true;
  state.sent = 0;
  state.subject = req.body.subject;
  state.template = req.body.template;
  state.batch = Number(req.body.batch || 10);

  startSending();

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  state.running = false;
  res.json({ success: true });
});

// ---------- STATUS ----------
app.get("/status", (req, res) => {
  res.json({
    running: state.running,
    sent: state.sent,
    total: getLeads().length,
    inboxes: getInboxes(),
    leads: getLeads().slice(0, 10)
  });
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});