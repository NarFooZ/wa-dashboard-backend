// routes/billing.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import db from '../db/database.js';

const router = Router();

// GET /api/billing/rules — All billing rules
router.get('/rules', requireAuth, (req, res) => {
  const rules = db.prepare('SELECT * FROM billing_rules ORDER BY created_at DESC').all();
  res.json(rules);
});

// POST /api/billing/rules — Create new billing rule
router.post('/rules', requireAuth, (req, res) => {
  const { keyword, emoji, amount, description } = req.body;
  if (!keyword || !amount) return res.status(400).json({ error: 'الكلمة والمبلغ مطلوبان' });

  const result = db.prepare(`
    INSERT INTO billing_rules (keyword, emoji, amount, description)
    VALUES (?, ?, ?, ?)
  `).run(keyword, emoji || null, parseFloat(amount), description || '');

  res.json({ success: true, id: result.lastInsertRowid });
});

// PATCH /api/billing/rules/:id — Update billing rule
router.patch('/rules/:id', requireAuth, (req, res) => {
  const { keyword, emoji, amount, description, is_active } = req.body;
  db.prepare(`
    UPDATE billing_rules SET
      keyword = COALESCE(?, keyword),
      emoji = COALESCE(?, emoji),
      amount = COALESCE(?, amount),
      description = COALESCE(?, description),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(keyword, emoji, amount ? parseFloat(amount) : null, description, is_active, req.params.id);

  res.json({ success: true });
});

// DELETE /api/billing/rules/:id — Delete billing rule
router.delete('/rules/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM billing_rules WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/billing/stats — Overall billing stats
router.get('/stats', requireAuth, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT member_id) as active_members,
      SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END) as total_credited,
      SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END) as total_debited,
      COUNT(*) as total_transactions
    FROM transactions
  `).get();

  const totalBalance = db.prepare('SELECT SUM(balance) as total FROM members').get();
  const recentTx = db.prepare(`
    SELECT t.*, m.name as member_name, m.phone
    FROM transactions t
    JOIN members m ON m.id = t.member_id
    ORDER BY t.created_at DESC LIMIT 10
  `).all();

  res.json({ ...stats, totalBalance: totalBalance.total || 0, recentTransactions: recentTx });
});

// GET /api/billing/transactions — All transactions
router.get('/transactions', requireAuth, (req, res) => {
  const { limit = 50, offset = 0, type } = req.query;
  const typeFilter = type ? `AND t.type = '${type}'` : '';

  const transactions = db.prepare(`
    SELECT t.*, m.name as member_name, m.phone
    FROM transactions t
    JOIN members m ON m.id = t.member_id
    WHERE 1=1 ${typeFilter}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(parseInt(limit), parseInt(offset));

  res.json(transactions);
});

export default router;
