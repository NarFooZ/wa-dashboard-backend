// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import db from './db/database.js';
import { initAdmin } from './middleware/auth.js';
import { processWebhook } from './lib/webhookProcessor.js';

import authRoutes from './routes/auth.js';
import groupRoutes from './routes/group.js';
import membersRoutes from './routes/members.js';
import billingRoutes from './routes/billing.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api', rateLimit({ windowMs: 1 * 60 * 1000, max: 200 }));

// ─── Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/group', groupRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/billing', billingRoutes);

// ─── Webhook (Green API sends here) ──────────────────────
app.post('/webhook', async (req, res) => {
  // Respond immediately to Green API (required within 5s)
  res.status(200).json({ status: 'ok' });

  // Process asynchronously
  try {
    await processWebhook(req.body);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// ─── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  const memberCount = db.prepare('SELECT COUNT(*) as c FROM members').get();
  res.json({
    status: 'ok',
    members: memberCount.c,
    timestamp: new Date().toISOString(),
    group: process.env.GROUP_ID || 'not configured',
  });
});

// ─── 404 ──────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

// ─── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'خطأ في السيرفر' });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  initAdmin();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Group ID: ${process.env.GROUP_ID || 'NOT SET - add to .env'}`);
  console.log(`🔗 Webhook URL: POST /webhook`);
});
