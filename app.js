const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const nodemailer = require('nodemailer');
const net = require('net');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = 'dwarkadhishxvivek';
const DAILY_LIMIT = 30;
const MIN_DELAY = 30000;
const MAX_DELAY = 90000;
const MAX_RETRIES = 3;

['uploads', 'public'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const LEADS_FILE = path.join(__dirname, 'leads.json');
const INBOXES_FILE = path.join(__dirname, 'inboxes.json');
const STATE_FILE = path.join(__dirname, 'state.json');

function readJSON(file, defaultValue = []) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  return defaultValue;
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let leads = readJSON(LEADS_FILE);
let inboxes = readJSON(INBOXES_FILE);
let state = readJSON(STATE_FILE, { running: false, subject: '', template: '', batchSize: 10 });
if (state.running) { state.running = false; writeJSON(STATE_FILE, state); }
let failedEmails = [];

app.use(express.json());
app.use(express.static('public'));
const upload = multer({ dest: 'uploads/' });

// ---------- TCP connectivity test ----------
function testTCP(host, port, timeout = 10000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// Diagnostic endpoint – open this in your browser
app.get('/test-smtp', async (req, res) => {
  const r587 = await testTCP('smtp.gmail.com', 587);
  const r465 = await testTCP('smtp.gmail.com', 465);
  res.json({
    port_587: r587,
    port_465: r465,
    smtp_possible: r587 || r465,
    message: (r587 || r465) ? 'At least one port works' : 'All SMTP ports blocked by host'
  });
});

// ---------- Daily reset ----------
function resetDailyCountersIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;
  inboxes.forEach(inbox => {
    if (!inbox.lastReset || inbox.lastReset !== today) {
      inbox.sentToday = 0;
      inbox.lastReset = today;
      changed = true;
    }
  });
  if (changed) writeJSON(INBOXES_FILE, inboxes);
}

function getBestInbox() {
  resetDailyCountersIfNeeded();
  const eligible = inboxes.filter(i => i.sentToday < DAILY_LIMIT);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.sentToday - b.sentToday);
  return eligible[0];
}

async function sendEmail(inbox, lead, subject, template) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: inbox.email, pass: inbox.password },
  });

  const body = template
    .replace(/{{name}}/g, lead.name || '')
    .replace(/{{icebreaker}}/g, lead.icebreaker || '');

  const mailOptions = {
    from: inbox.email,
    to: lead.email,
    subject: subject,
    text: body,
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      return true;
    } catch (err) {
      console.error(`Attempt ${attempt} failed for ${lead.email}: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

function randomDelay() {
  const ms = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runEmailBatch() {
  if (state.running) return;
  state.running = true;
  writeJSON(STATE_FILE, state);

  let batchSent = 0;
  const batchSize = state.batchSize;
  const subject = state.subject;
  const template = state.template;

  try {
    while (state.running && batchSent < batchSize) {
      const leadIndex = leads.findIndex(l => !l.sent);
      if (leadIndex === -1) break;
      const lead = leads[leadIndex];
      const inbox = getBestInbox();
      if (!inbox) break;

      try {
        await sendEmail(inbox, lead, subject, template);
        leads[leadIndex].sent = true;
        writeJSON(LEADS_FILE, leads);
        inbox.sentToday = (inbox.sentToday || 0) + 1;
        writeJSON(INBOXES_FILE, inboxes);
        batchSent++;
      } catch (err) {
        console.error(`Failed to send to ${lead.email}:`, err.message);
        failedEmails.push({ email: lead.email, error: err.message, time: new Date().toISOString() });
      }

      if (batchSent >= batchSize) break;
      if (state.running && batchSent < batchSize && leads.some(l => !l.sent)) {
        await randomDelay();
      }
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  } finally {
    state.running = false;
    writeJSON(STATE_FILE, state);
  }
}

// ---------- API Endpoints ----------
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Incorrect password' });
});

app.post('/add-inbox', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and App Password required' });

  if (inboxes.find(i => i.email === email)) {
    return res.status(400).json({ error: 'Inbox already added' });
  }

  // First, check which ports are actually reachable from this host
  const canUse465 = await testTCP('smtp.gmail.com', 465);
  const canUse587 = await testTCP('smtp.gmail.com', 587);

  if (!canUse465 && !canUse587) {
    // Both ports blocked – cannot verify, but add it anyway with a warning
    inboxes.push({
      email,
      password,
      sentToday: 0,
      lastReset: new Date().toISOString().slice(0, 10),
      verified: false,
    });
    writeJSON(INBOXES_FILE, inboxes);
    return res.json({
      success: true,
      message: 'Inbox added but SMTP ports are blocked by this host. Emails cannot be sent from here. Try a different hosting platform.',
    });
  }

  // Use the working port for verification
  const portToUse = canUse465 ? 465 : 587;
  const secure = portToUse === 465;

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: portToUse,
      secure,
      requireTLS: !secure,
      auth: { user: email, pass: password },
    });
    await transporter.verify();

    inboxes.push({
      email,
      password,
      sentToday: 0,
      lastReset: new Date().toISOString().slice(0, 10),
      verified: true,
    });
    writeJSON(INBOXES_FILE, inboxes);
    res.json({ success: true, message: `Inbox verified on port ${portToUse}` });
  } catch (err) {
    res.status(400).json({ error: `Verification failed: ${err.message}. Port ${portToUse} was reachable but login failed. Check App Password.` });
  }
});

app.post('/remove-inbox', (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number' || index < 0 || index >= inboxes.length)
    return res.status(400).json({ error: 'Invalid index' });
  inboxes.splice(index, 1);
  writeJSON(INBOXES_FILE, inboxes);
  res.json({ success: true });
});

app.post('/clear-inboxes', (req, res) => {
  inboxes = [];
  writeJSON(INBOXES_FILE, inboxes);
  res.json({ success: true });
});

app.post('/upload-leads', upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => {
      if (row.name && row.email) {
        results.push({
          name: row.name.trim(),
          email: row.email.trim(),
          icebreaker: row.icebreaker ? row.icebreaker.trim() : '',
          sent: false,
        });
      }
    })
    .on('end', () => {
      leads = leads.concat(results);
      writeJSON(LEADS_FILE, leads);
      fs.unlink(req.file.path, () => {});
      res.json({ success: true, added: results.length, total: leads.length });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'CSV parsing error: ' + err.message });
    });
});

app.post('/remove-lead', (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number' || index < 0 || index >= leads.length)
    return res.status(400).json({ error: 'Invalid index' });
  leads.splice(index, 1);
  writeJSON(LEADS_FILE, leads);
  res.json({ success: true });
});

app.post('/clear-leads', (req, res) => {
  leads = [];
  writeJSON(LEADS_FILE, leads);
  failedEmails = [];
  res.json({ success: true });
});

app.post('/run', (req, res) => {
  if (state.running) return res.status(400).json({ error: 'Already running' });
  const { subject, template, batchCount } = req.body;
  if (!subject || !template) return res.status(400).json({ error: 'Subject and template required' });
  const batch = parseInt(batchCount) || 10;
  if (batch < 1) return res.status(400).json({ error: 'Batch count must be at least 1' });

  state.subject = subject;
  state.template = template;
  state.batchSize = batch;
  state.running = true;
  writeJSON(STATE_FILE, state);

  runEmailBatch().catch(err => console.error('Batch failed:', err));
  res.json({ success: true, message: 'Sending started' });
});

app.post('/stop', (req, res) => {
  if (!state.running) return res.status(400).json({ error: 'Not running' });
  state.running = false;
  writeJSON(STATE_FILE, state);
  res.json({ success: true, message: 'Sending stopped' });
});

app.get('/status', (req, res) => {
  resetDailyCountersIfNeeded();
  const sentCount = leads.filter(l => l.sent).length;
  const totalLeads = leads.length;

  const inboxList = inboxes.map((ib, idx) => ({
    index: idx,
    email: ib.email,
    sentToday: ib.sentToday || 0,
  }));

  const leadList = leads.slice(0, 50).map((l, idx) => ({
    index: idx,
    name: l.name,
    email: l.email,
    icebreaker: l.icebreaker,
    sent: l.sent,
  }));

  res.json({
    running: state.running,
    sentCount,
    totalLeads,
    subject: state.subject,
    template: state.template,
    batchSize: state.batchSize,
    inboxes: inboxList,
    leads: leadList,
    totalLeadsCount: totalLeads,
    failedEmails: failedEmails.slice(-20),
  });
});

app.listen(PORT, () => {
  console.log(`Cold Email Tool running on port ${PORT}`);
});