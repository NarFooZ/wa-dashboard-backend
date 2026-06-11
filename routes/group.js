// routes/group.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import db, { upsertMember } from '../db/database.js';
import * as greenApi from '../lib/greenApi.js';

const router = Router();
const GROUP_ID = () => process.env.GROUP_ID;

// GET /api/group/info — Get group info + participants
router.get('/info', requireAuth, async (req, res) => {
  try {
    const data = await greenApi.getGroupInfo(GROUP_ID());

    // Sync participants to DB
    if (data.participants) {
      for (const p of data.participants) {
        const phone = p.id.replace('@c.us', '');
        upsertMember(phone, p.name || phone, p.id);

        // Sync admin status
        if (p.isAdmin !== undefined) {
          db.prepare('UPDATE members SET is_admin = ? WHERE wa_id = ?')
            .run(p.isAdmin ? 1 : 0, p.id);
        }
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/group/status — WhatsApp instance status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = await greenApi.getInstanceStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/group/name — Change group name
router.patch('/name', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });

  try {
    const result = await greenApi.setGroupSubject(GROUP_ID(), name);
    db.prepare("INSERT OR REPLACE INTO group_settings (key, value, updated_at) VALUES ('group_name', ?, datetime('now'))")
      .run(name);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/group/description — Change group description
router.patch('/description', requireAuth, async (req, res) => {
  const { description } = req.body;
  try {
    const result = await greenApi.setGroupDescription(GROUP_ID(), description || '');
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/group/admin — Grant admin to member
router.post('/admin', requireAuth, async (req, res) => {
  const { waId } = req.body;
  if (!waId) return res.status(400).json({ error: 'waId مطلوب' });

  try {
    const result = await greenApi.setGroupAdmin(GROUP_ID(), waId);
    db.prepare('UPDATE members SET is_admin = 1 WHERE wa_id = ?').run(waId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/group/admin — Remove admin from member
router.delete('/admin', requireAuth, async (req, res) => {
  const { waId } = req.body;
  if (!waId) return res.status(400).json({ error: 'waId مطلوب' });

  try {
    const result = await greenApi.removeAdmin(GROUP_ID(), waId);
    db.prepare('UPDATE members SET is_admin = 0 WHERE wa_id = ?').run(waId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/group/member — Remove member from group
router.delete('/member', requireAuth, async (req, res) => {
  const { waId } = req.body;
  if (!waId) return res.status(400).json({ error: 'waId مطلوب' });

  try {
    const result = await greenApi.removeGroupParticipant(GROUP_ID(), waId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/group/message — Send message to group
router.post('/message', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'النص مطلوب' });

  try {
    const result = await greenApi.sendGroupMessage(GROUP_ID(), text);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/group/webhook — Set webhook URL
router.post('/webhook', requireAuth, async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl مطلوب' });

  try {
    const result = await greenApi.setWebhookUrl(webhookUrl);
    db.prepare("INSERT OR REPLACE INTO group_settings (key, value, updated_at) VALUES ('webhook_url', ?, datetime('now'))")
      .run(webhookUrl);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
