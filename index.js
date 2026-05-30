const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Database — retry on startup instead of crashing
let dbReady = false;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    phone VARCHAR(50) DEFAULT '',
    message TEXT DEFAULT '',
    lead_source VARCHAR(100) DEFAULT 'Website',
    property_interest VARCHAR(255) DEFAULT '',
    preferred_location VARCHAR(255) DEFAULT '',
    budget_min INTEGER,
    budget_max INTEGER,
    timeline VARCHAR(100) DEFAULT '1-3 Months',
    stage VARCHAR(50) DEFAULT 'new_lead',
    ai_score INTEGER DEFAULT 50,
    notes TEXT DEFAULT '',
    last_contacted VARCHAR(100) DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS communications (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    channel VARCHAR(50) DEFAULT 'Note',
    direction VARCHAR(20) DEFAULT 'outbound',
    content TEXT DEFAULT '',
    ai_generated INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    title VARCHAR(255) DEFAULT '',
    appt_type VARCHAR(100) DEFAULT 'Showing',
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    status VARCHAR(50) DEFAULT 'scheduled',
    notes TEXT DEFAULT '',
    lead_name VARCHAR(255) DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) DEFAULT '',
    campaign_type VARCHAR(50) DEFAULT 'email',
    subject VARCHAR(255) DEFAULT '',
    content TEXT DEFAULT '',
    status VARCHAR(50) DEFAULT 'draft',
    sent_count INTEGER DEFAULT 0,
    opened_count INTEGER DEFAULT 0,
    clicked_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
  CREATE INDEX IF NOT EXISTS idx_comms_lead ON communications(lead_id);
  CREATE INDEX IF NOT EXISTS idx_appts_lead ON appointments(lead_id);
`;

async function initDB(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(SCHEMA);
      dbReady = true;
      console.log('Database ready (CRM schema)');
      return;
    } catch (e) {
      console.error(`DB attempt ${i + 1}/${retries} failed:`, e.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('DB never came up — running without database');
}
initDB();

// Middleware: require DB for data routes
function requireDB(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Database unavailable — retrying' });
  next();
}

// ── Serve CRM frontend ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Auth ──
app.get('/api/auth/me', (req, res) => {
  res.json({ id: 1, full_name: 'Alex Morgan', email: 'demo@leadflow.ai', role: 'agent', plan: 'professional', subscription: { plan: 'professional', status: 'active' } });
});

// ── Leads CRUD ──
app.get('/api/leads', requireDB, async (req, res) => {
  try {
    const { search, stage } = req.query;
    let q = 'SELECT * FROM leads WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
    if (stage) { params.push(stage); q += ` AND stage = $${params.length}`; }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', requireDB, async (req, res) => {
  try {
    const { rows: [lead] } = await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const { rows: comms } = await pool.query('SELECT * FROM communications WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.id]);
    const { rows: appts } = await pool.query('SELECT * FROM appointments WHERE lead_id=$1 ORDER BY start_time', [req.params.id]);
    res.json({ ...lead, communications: comms, appointments: appts });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', requireDB, async (req, res) => {
  try {
    const d = req.body;
    const { rows: [lead] } = await pool.query(
      `INSERT INTO leads (name,email,phone,lead_source,property_interest,preferred_location,budget_min,budget_max,timeline,stage,notes,ai_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,50) RETURNING *`,
      [d.name||'', d.email||'', d.phone||'', d.lead_source||'Website', d.property_interest||'', d.preferred_location||'', d.budget_min||null, d.budget_max||null, d.timeline||'1-3 Months', d.stage||'new_lead', d.notes||'']
    );
    res.status(201).json(lead);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', requireDB, async (req, res) => {
  try {
    const d = req.body;
    const { rows: [lead] } = await pool.query(
      `UPDATE leads SET name=$1,email=$2,phone=$3,lead_source=$4,property_interest=$5,preferred_location=$6,budget_min=$7,budget_max=$8,timeline=$9,stage=$10,notes=$11,updated_at=NOW() WHERE id=$12 RETURNING *`,
      [d.name||'', d.email||'', d.phone||'', d.lead_source||'', d.property_interest||'', d.preferred_location||'', d.budget_min||null, d.budget_max||null, d.timeline||'', d.stage||'', d.notes||'', req.params.id]
    );
    if (!lead) return res.status(404).json({ error: 'Not found' });
    res.json(lead);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireDB, async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id/stage', requireDB, async (req, res) => {
  try {
    const { rows: [lead] } = await pool.query('UPDATE leads SET stage=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [req.body.stage, req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    res.json(lead);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/score', requireDB, async (req, res) => {
  try {
    const score = Math.floor(Math.random() * 30) + 65;
    const { rows: [lead] } = await pool.query('UPDATE leads SET ai_score=$1 WHERE id=$2 RETURNING *', [score, req.params.id]);
    res.json(lead);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Communications ──
app.post('/api/leads/:id/communications', requireDB, async (req, res) => {
  try {
    const d = req.body;
    await pool.query('INSERT INTO communications (lead_id,channel,direction,content,ai_generated) VALUES ($1,$2,$3,$4,$5)', [req.params.id, d.channel||'Note', d.direction||'outbound', d.content||'', d.ai_generated||0]);
    await pool.query('UPDATE leads SET last_contacted=$1, updated_at=NOW() WHERE id=$2', [new Date().toISOString().split('T')[0], req.params.id]);
    res.status(201).json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Appointments ──
app.get('/api/appointments', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, l.name as lead_name FROM appointments a LEFT JOIN leads l ON a.lead_id = l.id ORDER BY a.start_time DESC LIMIT 100
    `);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments', requireDB, async (req, res) => {
  try {
    const d = req.body;
    const { rows: [lead] } = await pool.query('SELECT name FROM leads WHERE id=$1', [d.lead_id]);
    const { rows: [appt] } = await pool.query(
      'INSERT INTO appointments (lead_id,title,appt_type,start_time,end_time,notes,lead_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [d.lead_id, d.title||'', d.appt_type||'Showing', d.start_time, d.end_time, d.notes||'', lead?.name||'']
    );
    res.status(201).json(appt);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/appointments/:id', requireDB, async (req, res) => {
  try {
    const { rows: [appt] } = await pool.query('UPDATE appointments SET status=$1 WHERE id=$2 RETURNING *', [req.body.status, req.params.id]);
    res.json(appt);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Campaigns ──
app.get('/api/campaigns', requireDB, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/campaigns', requireDB, async (req, res) => {
  try {
    const d = req.body;
    const { rows: [camp] } = await pool.query(
      'INSERT INTO campaigns (name,campaign_type,subject,content) VALUES ($1,$2,$3,$4) RETURNING *',
      [d.name||'', d.campaign_type||'email', d.subject||'', d.content||'']
    );
    res.status(201).json(camp);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/campaigns/:id', requireDB, async (req, res) => {
  try {
    const d = req.body;
    const { rows: [camp] } = await pool.query(
      'UPDATE campaigns SET status=$1, sent_count=$2 WHERE id=$3 RETURNING *',
      [d.status||'sent', d.sent_count||0, req.params.id]
    );
    res.json(camp);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── AI Generate ──
app.post('/api/ai/generate', (req, res) => {
  const { type, tone, lead_context } = req.body;
  const name = lead_context?.name || 'there';
  const templates = {
    sms_followup: { professional: `Hi ${name}, following up on our conversation about your property search. Let me know if you'd like to schedule a showing this week. - Alex Morgan`, friendly: `Hey ${name}! 👋 Just checking in — any properties catch your eye? Happy to set up a showing whenever you're ready! 😊`, urgent: `Hi ${name}, a property matching your criteria just hit the market. Would you like to see it today? - Alex`, casual: `Hey ${name}, what's up? Got any questions about the listings I sent over? ✌️` },
    email_followup: { professional: `Dear ${name},\n\nI wanted to follow up regarding your real estate needs. Please let me know if you have any questions or would like to explore additional options.\n\nBest regards,\nAlex Morgan`, friendly: `Hi ${name}!\n\nHope you're doing well! 😊 Just wanted to check in and see how your search is going. Let me know if I can help with anything!\n\nCheers,\nAlex` },
    call_script: { professional: `Opening: "Hi ${name}, this is Alex Morgan with LeadFlow Realty. How are you today?"\n\nPurpose: Check in on their property search timeline\n\nKey questions:\n1. Have you viewed any properties recently?\n2. Has your budget or location preference changed?\n3. Would you like to schedule showings this weekend?\n\nClose: Set next contact date` },
    cold_reengage: { professional: `Hi ${name}, it's been a while since we last connected. I wanted to share some new listings in your preferred area that you might find interesting. Are you still in the market? - Alex` },
    appointment_reminder: { professional: `Hi ${name}, this is a reminder about your upcoming showing tomorrow. Please confirm you'll be able to make it. Let me know if you need to reschedule! - Alex` },
    property_update: { professional: `Hi ${name}, I wanted to let you know about a new listing at ${lead_context?.preferred_location || 'your preferred area'} that matches your criteria. ${lead_context?.budget_max ? 'It\'s within your budget range.' : ''} Would you like more details? - Alex` }
  };
  const content = (templates[type] || templates.sms_followup)[tone || 'professional'] || Object.values(templates.sms_followup)[0];
  res.json({ content, ai_generated: true, type, tone });
});

// ── Analytics ──
app.get('/api/analytics/dashboard', requireDB, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows: [{ count: total }] } = await pool.query('SELECT COUNT(*)::int as count FROM leads');
    const { rows: [{ count: todayCount }] } = await pool.query('SELECT COUNT(*)::int as count FROM leads WHERE created_at::date = $1', [today]);
    const { rows: stageRows } = await pool.query('SELECT stage, COUNT(*)::int as count FROM leads GROUP BY stage');
    const dist = {};
    for (const r of stageRows) dist[r.stage] = r.count;
    res.json({
      new_leads_today: todayCount, active_conversations: total, upcoming_followups: 0,
      appointments_scheduled: 0, listings_under_contract: dist.under_contract || 0,
      closed_transactions: dist.closed || 0, monthly_revenue: (dist.closed || 0) * 350000,
      conversion_rate: total > 0 ? Math.round((dist.closed || 0) / total * 100) : 0,
      total_leads: total, ai_score_avg: 72, stage_distribution: dist
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/performance', requireDB, async (req, res) => {
  try {
    const { rows: sources } = await pool.query(`
      SELECT lead_source, COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE stage='closed')::int as closed
      FROM leads GROUP BY lead_source
    `);
    res.json({
      lead_sources: sources,
      response_metrics: { total_comms: 10, inbound: 3 }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Health ──
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: dbReady ? 'connected' : 'retrying', timestamp: new Date().toISOString() }));

app.listen(PORT, () => console.log(`LeadFlow CRM running on port ${PORT}`));
