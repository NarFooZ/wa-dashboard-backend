// routes/admins.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/database.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

// GET /api/admins — List all admins (super admin only)
router.get('/', requireSuperAdmin, (req, res) => {
  const admins = db.prepare(`
    SELECT a.id, a.username, a.role, a.created_at, a.member_id,
           m.name as member_name, m.phone as member_phone
    FROM admins a
    LEFT JOIN members m ON m.id = a.member_id
    ORDER BY a.created_at ASC
  `).all();
  res.json(admins);
});

// GET /api/admins/me — Current admin info (any authenticated admin)
router.get('/me', requireAuth, (req, res) => {
  const admin = db.prepare('SELECT id, username, role FROM admins WHERE id = ?').get(req.admin.id);
  res.json(admin);
});

// POST /api/admins — Create a new sub-admin manually (super admin only)
router.post('/', requireSuperAdmin, (req, res) => {
  const { username, password, role = 'sub_admin' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  if (!['super_admin', 'sub_admin'].includes(role)) {
    return res.status(400).json({ error: 'صلاحية غير صحيحة' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(`
      INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)
    `).run(username, hash, role);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admins/promote — Promote an existing group member to sub-admin
router.post('/promote', requireSuperAdmin, (req, res) => {
  const { memberId, username, password } = req.body;
  if (!memberId || !username || !password) {
    return res.status(400).json({ error: 'العضو واسم المستخدم وكلمة المرور مطلوبة' });
  }

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) return res.status(404).json({ error: 'العضو غير موجود' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(`
      INSERT INTO admins (username, password_hash, role, member_id) VALUES (?, ?, 'sub_admin', ?)
    `).run(username, hash, memberId);

    // Reflect admin status on the member record too (mirrors WhatsApp group admin tagging)
    db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(memberId);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admins/:id/password — Reset any admin's password instantly (super admin only)
router.patch('/:id/password', requireSuperAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'المستخدم غير موجود' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ success: true });
});

// DELETE /api/admins/:id — Remove a sub-admin (super admin only, cannot delete self or other super admins)
router.delete('/:id', requireSuperAdmin, (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (admin.id === req.admin.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
  if (admin.role === 'super_admin') return res.status(400).json({ error: 'لا يمكن حذف مدير رئيسي' });

  if (admin.member_id) {
    db.prepare('UPDATE members SET is_admin = 0 WHERE id = ?').run(admin.member_id);
  }
  db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
