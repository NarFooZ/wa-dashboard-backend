// routes/settings.js
import { Router } from 'express';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import db, { getAllSettings, setSettings, renderRulesPrompt } from '../db/database.js';
import { sendGroupMessage } from '../lib/greenApi.js';

const router = Router();

// GET /api/settings — All dynamic settings (any admin can view)
router.get('/', requireAuth, (req, res) => {
  res.json(getAllSettings());
});

// PATCH /api/settings — Update dynamic settings (super admin only)
router.patch('/', requireSuperAdmin, (req, res) => {
  const allowedKeys = [
    'security_deposit_amount', 'commission_internal', 'commission_external',
    'fixed_subscription_amount', 'fixed_subscription_period', 'cancellation_compensation',
    'settlement_schedule', 'click_transfer_number', 'late_settlement_hours',
    'confirmation_keyword', 'confirmation_emoji', 'internal_keyword', 'external_keyword',
  ];
  const updates = {};
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
  }
  setSettings(updates);
  res.json({ success: true, settings: getAllSettings() });
});

// GET /api/settings/rules-prompt — Preview the rendered rules prompt
router.get('/rules-prompt', requireAuth, (req, res) => {
  res.json({ text: renderRulesPrompt() });
});

// POST /api/settings/rules-prompt/send — Send the rendered rules prompt to the group
router.post('/rules-prompt/send', requireAuth, async (req, res) => {
  const GROUP_ID = process.env.GROUP_ID;
  try {
    const text = renderRulesPrompt();
    await sendGroupMessage(GROUP_ID, text);
    res.json({ success: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
