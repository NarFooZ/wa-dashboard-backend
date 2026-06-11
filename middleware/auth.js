// middleware/auth.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../db/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const JWT_EXPIRES = '7d';

// Initialize default admin if not exists
export function initAdmin() {
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(
    process.env.ADMIN_USERNAME || 'admin'
  );
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(
      process.env.ADMIN_USERNAME || 'admin',
      hash
    );
    console.log('✅ Default admin created');
  }
}

export function generateToken(admin) {
  return jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Express middleware
export function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  try {
    req.admin = verifyToken(auth.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: 'جلسة منتهية' });
  }
}

export { bcrypt };
