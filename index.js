const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('redis');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Redis connection (optional — fails gracefully if not configured)
let redis = null;
(async () => {
  try {
    if (process.env.REDIS_URL) {
      redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      console.log('Redis connected');
    }
  } catch (e) {
    console.warn('Redis not available, rate limiting disabled:', e.message);
  }
})();

// Create leads table on startup
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) DEFAULT '',
        email VARCHAR(255) DEFAULT '',
        phone VARCHAR(50) DEFAULT '',
        message TEXT DEFAULT '',
        source VARCHAR(100) DEFAULT 'website',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
      CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
    `);
    console.log('Database ready');
  } catch (e) {
    console.error('Database setup failed:', e.message);
    process.exit(1);
  }
})();

// Rate limiting via Redis (30 req/min per IP)
async function rateLimit(ip) {
  if (!redis) return true;
  const key = `ratelimit:${ip}`;
  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, 60);
  return current <= 30;
}

// POST /api/leads — capture a lead
app.post('/api/leads', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.ip;

    // Rate limit
    const allowed = await rateLimit(ip);
    if (!allowed) return res.status(429).json({ error: 'Too many requests' });

    const { name, email, phone, message, source } = req.body;

    // Basic validation
    if (!phone && !email) {
      return res.status(400).json({ error: 'Phone or email required' });
    }

    const result = await pool.query(
      `INSERT INTO leads (name, email, phone, message, source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [name || '', email || '', phone || '', message || '', source || 'website']
    );

    console.log(`New lead: ${result.rows[0].id} — ${email || phone}`);

    res.status(201).json({
      success: true,
      id: result.rows[0].id,
      created_at: result.rows[0].created_at
    });
  } catch (e) {
    console.error('Lead capture error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/leads — list leads (public for now, add auth later)
app.get('/api/leads', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, phone, message, source, created_at FROM leads ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ leads: rows, count: rows.length });
  } catch (e) {
    console.error('Leads query error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Landing page
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Leadflow API</title>
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:20px;background:#0d1117;color:#c9d1d9}h1{color:#58a6ff}code{background:#161b22;padding:2px 8px;border-radius:4px;font-size:14px}a{color:#58a6ff}</style></head>
<body>
<h1>✓ Leadflow API</h1>
<p><strong>Status:</strong> Running</p>
<p>POST leads to <code>/api/leads</code> — GET them at <code>/api/leads</code></p>
<p><a href="/api/health">/api/health</a> · <a href="/api/leads">/api/leads</a></p>
</body></html>`);
});

app.listen(PORT, () => console.log(`Lead flow API running on port ${PORT}`));
