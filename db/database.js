// db/database.js — uses Node 22 built-in SQLite (no external deps)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR  = process.env.DB_PATH
  ? dirname(process.env.DB_PATH)
  : join(__dirname, '../data');
const DB_FILE = process.env.DB_PATH || join(DB_DIR, 'dashboard.db');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

// ─── Schema ───────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS admins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT UNIQUE NOT NULL,
    name        TEXT,
    wa_id       TEXT UNIQUE,
    balance     REAL DEFAULT 0,
    is_admin    INTEGER DEFAULT 0,
    is_blocked  INTEGER DEFAULT 0,
    joined_at   TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id     INTEGER NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('credit','debit','manual')),
    amount        REAL NOT NULL,
    balance_after REAL NOT NULL,
    description   TEXT,
    trigger_message TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS billing_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword     TEXT NOT NULL,
    emoji       TEXT,
    amount      REAL NOT NULL,
    description TEXT,
    is_active   INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_data    TEXT,
    processed   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default billing rule once
const ruleCount = db.prepare('SELECT COUNT(*) AS c FROM billing_rules').get();
if (ruleCount.c === 0) {
  db.prepare(`
    INSERT INTO billing_rules (keyword, emoji, amount, description)
    VALUES (?, ?, ?, ?)
  `).run(
    process.env.BILLING_KEYWORD || 'شراء',
    process.env.BILLING_EMOJI   || '👍',
    parseFloat(process.env.BILLING_AMOUNT || '5'),
    'قاعدة الخصم الافتراضية'
  );
}

export default db;

// ─── Helpers ──────────────────────────────────────────────

export const getMember = (phone) =>
  db.prepare('SELECT * FROM members WHERE phone = ? OR wa_id = ?').get(phone, phone);

export const upsertMember = (phone, name, waId) => {
  const existing = db.prepare(
    'SELECT id FROM members WHERE phone = ? OR wa_id = ?'
  ).get(phone, waId || phone);

  if (existing) {
    db.prepare(`
      UPDATE members SET name = ?, wa_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(name, waId, existing.id);
    return existing.id;
  }
  const r = db.prepare(
    'INSERT INTO members (phone, name, wa_id) VALUES (?, ?, ?)'
  ).run(phone, name, waId);
  return r.lastInsertRowid;
};

export const debitMember = (memberId, amount, description, triggerMessage) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) throw new Error('Member not found');
  const newBalance = member.balance - amount;
  db.prepare(`UPDATE members SET balance = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newBalance, memberId);
  db.prepare(`
    INSERT INTO transactions (member_id, type, amount, balance_after, description, trigger_message)
    VALUES (?, 'debit', ?, ?, ?, ?)
  `).run(memberId, amount, newBalance, description, triggerMessage);
  return newBalance;
};

export const creditMember = (memberId, amount, description) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) throw new Error('Member not found');
  const newBalance = member.balance + amount;
  db.prepare(`UPDATE members SET balance = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newBalance, memberId);
  db.prepare(`
    INSERT INTO transactions (member_id, type, amount, balance_after, description)
    VALUES (?, 'credit', ?, ?, ?)
  `).run(memberId, amount, newBalance, description);
  return newBalance;
};
