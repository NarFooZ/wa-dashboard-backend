// routes/members.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import db, { creditMember, debitMember } from '../db/database.js';

const router = Router();

// GET /api/members — All members with balances
router.get('/', requireAuth, (req, res) => {
  const members = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM transactions t WHERE t.member_id = m.id) as tx_count,
      (SELECT SUM(amount) FROM transactions t WHERE t.member_id = m.id AND t.type = 'debit') as total_debited,
      (SELECT SUM(amount) FROM transactions t WHERE t.member_id = m.id AND t.type = 'credit') as total_credited
    FROM members m
    ORDER BY m.name ASC
  `).all();
  res.json(members);
});

// GET /api/members/:id — Single member with transactions
router.get('/:id', requireAuth, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  const transactions = db.prepare(`
    SELECT * FROM transactions WHERE member_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(member.id);

  res.json({ ...member, transactions });
});

// POST /api/members — Add member manually
router.post('/', requireAuth, (req, res) => {
  const { phone, name, balance = 0 } = req.body;
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });

  try {
    const result = db.prepare(`
      INSERT INTO members (phone, name, balance, wa_id) VALUES (?, ?, ?, ?)
    `).run(phone, name || phone, balance, `${phone}@c.us`);

    if (balance > 0) {
      creditMember(result.lastInsertRowid, balance, 'رصيد أولي');
    }

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'الرقم مسجل مسبقاً' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/members/:id — Update member info
router.patch('/:id', requireAuth, (req, res) => {
  const { name, is_blocked } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  db.prepare(`
    UPDATE members SET
      name = COALESCE(?, name),
      is_blocked = COALESCE(?, is_blocked),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name ?? null, is_blocked ?? null, req.params.id);

  res.json({ success: true });
});

// POST /api/members/:id/credit — Add credit to member
router.post('/:id/credit', requireAuth, (req, res) => {
  const { amount, description } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });

  try {
    const newBalance = creditMember(
      parseInt(req.params.id),
      parseFloat(amount),
      description || 'شحن يدوي'
    );
    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/members/:id/debit — Manual debit from member
router.post('/:id/debit', requireAuth, (req, res) => {
  const { amount, description } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  try {
    const newBalance = debitMember(
      parseInt(req.params.id),
      parseFloat(amount),
      description || 'خصم يدوي',
      null
    );
    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/members/:id/transactions — Transaction history
router.get('/:id/transactions', requireAuth, (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE member_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, parseInt(limit), parseInt(offset));

  res.json(transactions);
});

// DELETE /api/members/:id — Delete member
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM transactions WHERE member_id = ?').run(req.params.id);
  db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
