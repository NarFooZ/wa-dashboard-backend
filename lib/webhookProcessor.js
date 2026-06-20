// lib/webhookProcessor.js
import db, { getMember, upsertMember, debitMember, getSetting } from '../db/database.js';
import { sendMessage } from './greenApi.js';

const TARGET_GROUP = process.env.GROUP_ID;

/**
 * Process an incoming Green API webhook payload
 * Handles billing triggers: keyword + emoji in group messages,
 * with automatic internal/external order-type detection.
 */
export async function processWebhook(payload) {
  db.prepare('INSERT INTO webhook_log (raw_data) VALUES (?)').run(JSON.stringify(payload));

  const { typeWebhook, messageData, senderData } = payload;

  if (typeWebhook !== 'incomingMessageReceived') return;
  if (!messageData?.textMessageData?.textMessage) return;

  const chatId = senderData?.chatId;
  const sender = senderData?.sender;
  const text = messageData.textMessageData.textMessage;

  if (chatId !== TARGET_GROUP) return;

  const rules = db.prepare('SELECT * FROM billing_rules WHERE is_active = 1').all();

  for (const rule of rules) {
    const keywordMatch = rule.keyword && text.includes(rule.keyword);
    const emojiMatch = rule.emoji ? text.includes(rule.emoji) : true;

    if (keywordMatch && emojiMatch) {
      await processBillingTrigger(sender, text, rule, chatId);
      break; // Apply only first matching rule
    }
  }

  db.prepare('UPDATE webhook_log SET processed = 1 WHERE id = (SELECT MAX(id) FROM webhook_log)').run();
}

function detectOrderType(text) {
  const internalKw = getSetting('internal_keyword') || 'داخلي';
  const externalKw = getSetting('external_keyword') || 'خارجي';
  if (text.includes(externalKw)) return 'external';
  if (text.includes(internalKw)) return 'internal';
  return null; // unspecified — falls back to rule's own order_type
}

async function processBillingTrigger(senderWaId, text, rule, groupId) {
  const phone = senderWaId.replace('@c.us', '');

  let member = getMember(phone);
  if (!member) {
    upsertMember(phone, phone, senderWaId);
    member = getMember(phone);
  }
  if (!member) return;

  // Suspended members cannot register new orders until manually reactivated by admin
  if (member.is_blocked) {
    await sendMessage(groupId,
      `⛔ عذراً @${phone}، حسابك موقوف مالياً حالياً.\n` +
      `يجب تسوية الذمة المالية مع الإدارة لإعادة تفعيل حسابك.`
    );
    return;
  }

  // Determine order type: message override > rule default
  const detectedType = detectOrderType(text);
  const orderType = detectedType || rule.order_type || 'internal';

  // Resolve amount based on order type from dynamic settings (falls back to rule.amount)
  let amount = rule.amount;
  if (detectedType === 'internal') amount = parseFloat(getSetting('commission_internal')) || rule.amount;
  if (detectedType === 'external') amount = parseFloat(getSetting('commission_external')) || rule.amount;

  // The order is recorded as a debt the moment the confirmation keyword is sent —
  // this matches the group's financial policy (orders count toward the ledger immediately,
  // settlement happens later on a schedule, not gated per-order on current balance).
  const typeLabel = orderType === 'external' ? '🔵 طلب خارجي' : '🟢 طلب داخلي';
  const newBalance = debitMember(
    member.id,
    amount,
    rule.description || `عمولة طلب - ${rule.keyword}`,
    text,
    orderType
  );

  const clickNumber = getSetting('click_transfer_number') || '';
  const settlementSchedule = getSetting('settlement_schedule') || '';

  let message =
    `✅ تم تسجيل الطلب في ذمتك!\n` +
    `👤 ${member.name || phone}\n` +
    `${typeLabel}\n` +
    `💳 العمولة: ${amount.toFixed(2)} د.أ\n` +
    `📊 إجمالي الذمة الحالية: ${newBalance < 0 ? Math.abs(newBalance).toFixed(2) : '0.00'} د.أ`;

  if (newBalance < 0 && settlementSchedule) {
    message += `\n📅 التصفية ${settlementSchedule}` + (clickNumber ? ` عبر Click: ${clickNumber}` : '');
  }

  await sendMessage(groupId, message);
}
