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
    role        TEXT NOT NULL DEFAULT 'super_admin' CHECK(role IN ('super_admin','sub_admin')),
    member_id   INTEGER,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT UNIQUE NOT NULL,
    name            TEXT,
    wa_id           TEXT UNIQUE,
    balance         REAL DEFAULT 0,
    security_deposit_required REAL DEFAULT 0,
    security_deposit_paid     REAL DEFAULT 0,
    is_admin        INTEGER DEFAULT 0,
    is_blocked      INTEGER DEFAULT 0,
    is_archived     INTEGER DEFAULT 0,
    last_settlement_at TEXT,
    joined_at       TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    archived_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id     INTEGER NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('credit','debit','manual','deposit','settlement')),
    amount        REAL NOT NULL,
    balance_after REAL NOT NULL,
    description   TEXT,
    trigger_message TEXT,
    order_type    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS billing_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword     TEXT NOT NULL,
    emoji       TEXT,
    amount      REAL NOT NULL,
    order_type  TEXT DEFAULT 'internal' CHECK(order_type IN ('internal','external','subscription')),
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

// ─── Migrations for existing DBs (safe re-run) ─────────────
function columnExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}
function addColumnIfMissing(table, col, ddl) {
  if (!columnExists(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
addColumnIfMissing('members', 'security_deposit_required', 'security_deposit_required REAL DEFAULT 0');
addColumnIfMissing('members', 'security_deposit_paid', 'security_deposit_paid REAL DEFAULT 0');
addColumnIfMissing('members', 'is_archived', 'is_archived INTEGER DEFAULT 0');
addColumnIfMissing('members', 'last_settlement_at', 'last_settlement_at TEXT');
addColumnIfMissing('members', 'archived_at', 'archived_at TEXT');
addColumnIfMissing('admins', 'role', "role TEXT NOT NULL DEFAULT 'super_admin'");
addColumnIfMissing('admins', 'member_id', 'member_id INTEGER');
addColumnIfMissing('billing_rules', 'order_type', "order_type TEXT DEFAULT 'internal'");
addColumnIfMissing('transactions', 'order_type', 'order_type TEXT');

// ─── Default dynamic settings (only seeded once) ───────────
const DEFAULT_SETTINGS = {
  security_deposit_amount: process.env.SECURITY_DEPOSIT_AMOUNT || '20',
  commission_internal: process.env.COMMISSION_INTERNAL || '1',
  commission_external: process.env.COMMISSION_EXTERNAL || '2',
  fixed_subscription_amount: process.env.FIXED_SUBSCRIPTION_AMOUNT || '10',
  fixed_subscription_period: process.env.FIXED_SUBSCRIPTION_PERIOD || 'weekly',
  cancellation_compensation: process.env.CANCELLATION_COMPENSATION || '2',
  settlement_schedule: process.env.SETTLEMENT_SCHEDULE || 'يومياً عند الساعة 9 مساءً',
  click_transfer_number: process.env.CLICK_TRANSFER_NUMBER || '0790000000',
  late_settlement_hours: process.env.LATE_SETTLEMENT_HOURS || '24',
  confirmation_keyword: process.env.BILLING_KEYWORD || 'تم',
  confirmation_emoji: process.env.BILLING_EMOJI || '👍',
  internal_keyword: process.env.INTERNAL_KEYWORD || 'داخلي',
  external_keyword: process.env.EXTERNAL_KEYWORD || 'خارجي',
};

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO group_settings (key, value) VALUES (?, ?)
`);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  insertSetting.run(k, v);
}

// Seed default billing rule once
const ruleCount = db.prepare('SELECT COUNT(*) AS c FROM billing_rules').get();
if (ruleCount.c === 0) {
  db.prepare(`
    INSERT INTO billing_rules (keyword, emoji, amount, order_type, description)
    VALUES (?, ?, ?, 'internal', ?)
  `).run(
    process.env.BILLING_KEYWORD || 'تم',
    process.env.BILLING_EMOJI   || '👍',
    parseFloat(process.env.COMMISSION_INTERNAL || '1'),
    'عمولة طلب داخلي (افتراضي)'
  );
}

export default db;

// ─── Helpers: Members ───────────────────────────────────────

export const getMember = (phone) =>
  db.prepare('SELECT * FROM members WHERE (phone = ? OR wa_id = ?) AND is_archived = 0').get(phone, phone);

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

export const debitMember = (memberId, amount, description, triggerMessage, orderType = null) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) throw new Error('Member not found');
  const newBalance = member.balance - amount;
  db.prepare(`UPDATE members SET balance = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newBalance, memberId);
  db.prepare(`
    INSERT INTO transactions (member_id, type, amount, balance_after, description, trigger_message, order_type)
    VALUES (?, 'debit', ?, ?, ?, ?, ?)
  `).run(memberId, amount, newBalance, description, triggerMessage, orderType);
  return newBalance;
};

export const creditMember = (memberId, amount, description, type = 'credit') => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) throw new Error('Member not found');
  const newBalance = member.balance + amount;
  db.prepare(`UPDATE members SET balance = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newBalance, memberId);
  db.prepare(`
    INSERT INTO transactions (member_id, type, amount, balance_after, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(memberId, type, amount, newBalance, description);
  return newBalance;
};

export const archiveMember = (memberId) => {
  db.prepare(`
    UPDATE members SET is_archived = 1, archived_at = datetime('now') WHERE id = ?
  `).run(memberId);
};

export const restoreMember = (memberId) => {
  db.prepare(`
    UPDATE members SET is_archived = 0, archived_at = NULL WHERE id = ?
  `).run(memberId);
};

export const recordSettlement = (memberId) => {
  db.prepare(`
    UPDATE members SET last_settlement_at = datetime('now') WHERE id = ?
  `).run(memberId);
};

// ─── Helpers: Dynamic Settings ──────────────────────────────

export const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM group_settings WHERE key = ?').get(key);
  return row ? row.value : null;
};

export const getAllSettings = () => {
  const rows = db.prepare('SELECT key, value FROM group_settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
};

export const setSetting = (key, value) => {
  db.prepare(`
    INSERT INTO group_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
};

export const setSettings = (obj) => {
  for (const [k, v] of Object.entries(obj)) setSetting(k, v);
};

/**
 * Renders the rules prompt template by replacing placeholders
 * with current dynamic settings values.
 */
export const renderRulesPrompt = () => {
  const s = getAllSettings();
  const periodLabel = s.fixed_subscription_period === 'monthly' ? 'شهري' : 'أسبوعي';

  return `🚨 **النظام المالي والتعليمات الرسمية لجروب التوصيل (ركاب + أوردرات)** 🚨

الزملاء الكباتن الأعزاء، يُرجى الالتزام التام بالنظام المالي المعتمد والمثبت في لوحة تحكم الإدارة:

---

### 1️⃣ الأمان المالي وتفعيل الحساب
* يشترط للعمل إرسال وثائق التوثيق (الهوية، رخص القيادة والمركبة).
* إيداع "رصيد أمان" مسترد قيمته ${s.security_deposit_amount} دينار عبر Click (يُرد بالكامل عند المغادرة بشرط خلو الذمة المالية).

---

### 2️⃣ آلية احتساب عمولة الجروب
تُقتطع عمولة الجروب لصالح الإدارة فور حجز الطلب، وهي كالتالي:
* 🟢 الطلبات الداخلية (ضمن المدينة): ${s.commission_internal} دينار عن كل طلب.
* 🔵 طلبات المحافظات والمسافات الطويلة: ${s.commission_external} دينار عن كل طلب.
* 💳 الاشتراك الثابت (بديل العمولات): ${s.fixed_subscription_amount} دينار ${periodLabel}.

---

### 3️⃣ تأكيد الحجز والدورة المالية
* نظام الركاب كاش أو كليك عند الوصول، ونظام الأوردرات يعتمد على (التشييك المسبق) بدفع الكابتن ثمن البضاعة للتاجر وتحصيلها مع أجور التوصيل من الزبون.
* ⚠️ **مهم جداً:** يُعتبر الطلب مسجلاً مالياً في ذمتك بمجرد إرسالك لكلمة التأكيد المعتمدة بالنظام وهي: [${s.confirmation_keyword}] أو الإيموجي المعتمد: [${s.confirmation_emoji}].
* للتمييز بين نوع الطلب أضف "${s.internal_keyword}" للطلبات الداخلية أو "${s.external_keyword}" للطلبات الخارجية قبل كلمة التأكيد.

---

### 4️⃣ مواعيد التصفية وعقوبة المخالفة
* يتم تصفية الذمم والعمولات المتراكمة ${s.settlement_schedule} عبر خدمة Click على الرقم: ${s.click_transfer_number}.
* ⛔ **تنبيه:** التأخر في التصفية لمدة تتجاوز ${s.late_settlement_hours} ساعة يمنح الأدمن الحق في (تعليق حساب الكابتن) على لوحة التحكم، مما يمنعه من أخذ أي طلبات جديدة حتى تسوية الحساب.

---

### 5️⃣ سياسة إلغاء الطلبات
* في حال رفض الزبون الاستلام دون خطأ من الكابتن، يلتزم التاجر بدفع تعويض للكابتن قيمته ${s.cancellation_compensation} دينار مقابل الجهد والوقت بعد التنسيق مع الإدارة لإرجاع الطلب.`;
};
