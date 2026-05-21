const express = require('express');
const nodemailer = require('nodemailer');
const csv = require('csv-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

// File paths
const LEADS_FILE = 'leads.json';
const INBOXES_FILE = 'inboxes.json';

// State
let state = {
  authenticated: false,
  password: 'admin123',
  leads: [],
  inboxes: [],
  sending: false,
  sentCount: 0,
  subject: '',
  template: '',
  batchSize: 10,
  currentBatchIndex: 0,
  failedEmails: []
};

// Initialize data files
function initializeFiles() {
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync(INBOXES_FILE)) {
    fs.writeFileSync(INBOXES_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
  }
  
  state.leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  state.inboxes = JSON.parse(fs.readFileSync(INBOXES_FILE, 'utf8'));
  
  // Reset daily sent counts at midnight
  resetDailyCounts();
}

function resetDailyCounts() {
  state.inboxes.forEach(inbox => {
    const lastReset = new Date(inbox.lastReset || 0);
    const now = new Date();
    
    if (lastReset.getDate() !== now.getDate() ||
        lastReset.getMonth() !== now.getMonth() ||
        lastReset.getFullYear() !== now.getFullYear()) {
      inbox.sentToday = 0;
      inbox.lastReset = now.toISOString();
    }
  });
  saveInboxes();
}

function saveLeads() {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(state.leads, null, 2));
}

function saveInboxes() {
  fs.writeFileSync(INBOXES_FILE, JSON.stringify(state.inboxes, null, 2));
}

// Login
app.post('/login', (req, res) => {
  const { password } = req.body;
  
  if (password === state.password) {
    state.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Add inbox
app.post('/add-inbox', async (req, res) => {
  const { email, appPassword } = req.body;
  
  if (!email || !appPassword) {
    return res.status(400).json({ error: 'Email and app password required' });
  }
  
  // Verify SMTP connection
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: email,
      pass: appPassword
    }
  });
  
  try {
    await transporter.verify();
    
    // Check if inbox already exists
    if (state.inboxes.some(inbox => inbox.email === email)) {
      return res.status(400).json({ error: 'Inbox already added' });
    }
    
    state.inboxes.push({
      email,
      appPassword,
      sentToday: 0,
      lastReset: new Date().toISOString()
    });
    
    saveInboxes();
    res.json({ success: true, message: 'Inbox added successfully' });
  } catch (error) {
    res.status(400).json({ error: `SMTP verification failed: ${error.message}` });
  }
});

// Remove inbox
app.post('/remove-inbox', (req, res) => {
  const { index } = req.body;
  
  if (index >= 0 && index < state.inboxes.length) {
    state.inboxes.splice(index, 1);
    saveInboxes();
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid index' });
  }
});

// Clear all inboxes
app.post('/clear-inboxes', (req, res) => {
  state.inboxes = [];
  saveInboxes();
  res.json({ success: true });
});

// Upload leads
app.post('/upload-leads', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const leads = [];
  
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => {
      if (row.name && row.email) {
        leads.push({ name: row.name, email: row.email });
      }
    })
    .on('end', () => {
      state.leads = leads;
      saveLeads();
      fs.unlinkSync(req.file.path); // Delete temp file
      res.json({ success: true, count: leads.length });
    })
    .on('error', (error) => {
      res.status(400).json({ error: `CSV parsing error: ${error.message}` });
    });
});

// Remove single lead
app.post('/remove-lead', (req, res) => {
  const { index } = req.body;
  
  if (index >= 0 && index < state.leads.length) {
    state.leads.splice(index, 1);
    saveLeads();
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid index' });
  }
});

// Clear all leads
app.post('/clear-leads', (req, res) => {
  state.leads = [];
  state.sentCount = 0;
  saveLeads();
  res.json({ success: true });
});

// Get status
app.get('/status', (req, res) => {
  resetDailyCounts();
  
  res.json({
    sentCount: state.sentCount,
    totalLeads: state.leads.length,
    running: state.sending,
    inboxes: state.inboxes.map(inbox => ({
      email: inbox.email,
      sentToday: inbox.sentToday
    })),
    leads: state.leads.slice(0, 10),
    failedEmails: state.failedEmails
  });
});

// Run batch sending
app.post('/run', (req, res) => {
  const { subject, template, batchSize } = req.body;
  
  if (!subject || !template) {
    return res.status(400).json({ error: 'Subject and template required' });
  }
  
  if (state.inboxes.length === 0) {
    return res.status(400).json({ error: 'No inboxes configured' });
  }
  
  if (state.leads.length === 0) {
    return res.status(400).json({ error: 'No leads uploaded' });
  }
  
  state.sending = true;
  state.subject = subject;
  state.template = template;
  state.batchSize = batchSize || 10;
  state.sentCount = 0;
  state.currentBatchIndex = 0;
  state.failedEmails = [];
  
  // Start sending in background
  sendBatch();
  
  res.json({ success: true, message: 'Batch sending started' });
});

// Stop sending
app.post('/stop', (req, res) => {
  state.sending = false;
  res.json({ success: true, message: 'Sending stopped' });
});

async function sendBatch() {
  while (state.sending && state.sentCount < state.leads.length) {
    resetDailyCounts();
    
    // Find inbox with lowest sent count
    const inbox = state.inboxes.reduce((prev, current) => 
      prev.sentToday < current.sentToday ? prev : current
    );
    
    // Check daily limit
    if (inbox.sentToday >= 30) {
      console.log(`Inbox ${inbox.email} has reached daily limit`);
      await sleep(60000); // Wait 1 minute and check again
      continue;
    }
    
    const lead = state.leads[state.sentCount];
    if (!lead) break;
    
    let success = false;
    let attempts = 0;
    
    while (attempts < 3 && !success) {
      try {
        await sendEmail(inbox, lead);
        inbox.sentToday++;
        state.sentCount++;
        saveInboxes();
        success = true;
        console.log(`Email sent to ${lead.email}`);
      } catch (error) {
        attempts++;
        console.log(`Attempt ${attempts} failed for ${lead.email}: ${error.message}`);
        
        if (attempts === 3) {
          state.failedEmails.push({
            email: lead.email,
            name: lead.name,
            error: error.message
          });
        }
        
        if (attempts < 3) {
          await sleep(5000); // Wait 5 seconds before retry
        }
      }
    }
    
    // Random delay between emails (30-90 seconds)
    const delay = Math.random() * 60000 + 30000;
    await sleep(delay);
  }
  
  state.sending = false;
  console.log('Batch sending completed');
}

async function sendEmail(inbox, lead) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: inbox.email,
      pass: inbox.appPassword
    }
  });
  
  // Replace variables in template
  const icebreaker = generateIcebreaker();
  let body = state.template
    .replace(/{{name}}/g, lead.name)
    .replace(/{{icebreaker}}/g, icebreaker);
  
  const mailOptions = {
    from: inbox.email,
    to: lead.email,
    subject: state.subject,
    text: body,
    html: body.replace(/\n/g, '<br>')
  };
  
  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        reject(error);
      } else {
        resolve(info);
      }
    });
  });
}

function generateIcebreaker() {
  const icebreakers = [
    'Quick question',
    'One thing I noticed',
    'Thought you might find this interesting',
    'Came across your profile',
    'Saw your recent work',
    'Really impressed by',
    'Found something relevant'
  ];
  return icebreakers[Math.floor(Math.random() * icebreakers.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize and start server
initializeFiles();

app.listen(PORT, () => {
  console.log(`Cold Email Tool running on http://localhost:${PORT}`);
});
