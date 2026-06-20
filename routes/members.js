// routes/members.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import db, { creditMember, debitMember, archiveMember, restoreMember, recordSettlement, getSetting } from '../db/database.js';

const router = Router();

// GET /api/members — Active (non-archived) members with balances
router.get('/', requireAuth, (req, res) => {
  const members = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM transactions t WHERE t.member_id = m.id) as tx_count,
      (SELECT SUM(amount) FROM transactions t WHERE t.member_id = m.id AND t.type = 'debit') as total_debited,
      (SELECT SUM(amount) FROM transactions t WHERE t.member_id = m.id AND t.type = 'credit') as total_credited
    FROM members m
    WHERE m.is_archived = 0
    ORDER BY m.name ASC
  `).all();
  res.json(members);
});

// GET /api/members/archived — Archived members
router.get('/archived', requireAuth, (req, res) => {
  const members = db.prepare(`
    SELECT * FROM members WHERE is_archived = 1 ORDER BY archived_at DESC
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

// POST /api/members — Add member manually (with optional security deposit)
router.post('/', requireAuth, (req, res) => {
  const { phone, name, balance = 0, security_deposit_required, security_deposit_paid = 0 } = req.body;
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });

  const depositRequired = security_deposit_required ?? parseFloat(getSetting('security_deposit_amount') || '0');

  try {
    const result = db.prepare(`
      INSERT INTO members (phone, name, balance, wa_id, security_deposit_required, security_deposit_paid)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(phone, name || phone, balance, `${phone}@c.us`, depositRequired, security_deposit_paid);

    if (balance > 0) {
      creditMember(result.lastInsertRowid, balance, 'رصيد أولي');
    }
    if (security_deposit_paid > 0) {
      db.prepare(`
        INSERT INTO transactions (member_id, type, amount, balance_after, description)
        VALUES (?, 'deposit', ?, ?, ?)
      `).run(result.lastInsertRowid, security_deposit_paid, balance, 'دفعة رصيد أمان');
    }

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'الرقم مسجل مسبقاً' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/members/:id — Update member info (name, block status, security deposit)
router.patch('/:id', requireAuth, (req, res) => {
  const { name, is_blocked, security_deposit_required, security_deposit_paid } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  db.prepare(`
    UPDATE members SET
      name = COALESCE(?, name),
      is_blocked = COALESCE(?, is_blocked),
      security_deposit_required = COALESCE(?, security_deposit_required),
      security_deposit_paid = COALESCE(?, security_deposit_paid),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? null,
    is_blocked ?? null,
    security_deposit_required ?? null,
    security_deposit_paid ?? null,
    req.params.id
  );

  res.json({ success: true });
});

// POST /api/members/:id/deposit — Record a security deposit payment
router.post('/:id/deposit', requireAuth, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  const newPaid = member.security_deposit_paid + parseFloat(amount);
  db.prepare(`UPDATE members SET security_deposit_paid = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newPaid, req.params.id);

  db.prepare(`
    INSERT INTO transactions (member_id, type, amount, balance_after, description)
    VALUES (?, 'deposit', ?, ?, ?)
  `).run(req.params.id, amount, member.balance, 'دفعة رصيد أمان');

  res.json({ success: true, security_deposit_paid: newPaid });
});

// POST /api/members/:id/credit — Add credit to operating balance
router.post('/:id/credit', requireAuth, (req, res) => {
  const { amount, description } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });

  try {
    const newBalance = creditMember(parseInt(req.params.id), parseFloat(amount), description || 'شحن يدوي');
    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/members/:id/debit — Manual debit
router.post('/:id/debit', requireAuth, (req, res) => {
  const { amount, description } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  try {
    const newBalance = debitMember(parseInt(req.params.id), parseFloat(amount), description || 'خصم يدوي', null);
    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/members/:id/settle — Mark a financial settlement as completed (resets balance to 0)
router.post('/:id/settle', requireAuth, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  if (member.balance < 0) {
    db.prepare(`
      INSERT INTO transactions (member_id, type, amount, balance_after, description)
      VALUES (?, 'settlement', ?, 0, ?)
    `).run(req.params.id, Math.abs(member.balance), 'تصفية مالية');
    db.prepare(`UPDATE members SET balance = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  }

  recordSettlement(req.params.id);
  res.json({ success: true });
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

// POST /api/members/:id/archive — Archive member (soft delete, keeps history)
router.post('/:id/archive', requireAuth, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });
  archiveMember(req.params.id);
  res.json({ success: true });
});

// POST /api/members/:id/restore — Restore an archived member
router.post('/:id/restore', requireAuth, (req, res) => {
  restoreMember(req.params.id);
  res.json({ success: true });
});

// DELETE /api/members/:id — Permanently delete member (rarely needed; archive is preferred)
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM transactions WHERE member_id = ?').run(req.params.id);
  db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
