// lib/webhookProcessor.js
import db, { getMember, upsertMember, debitMember } from '../db/database.js';
import { sendMessage } from './greenApi.js';

const TARGET_GROUP = process.env.GROUP_ID;

/**
 * Process an incoming Green API webhook payload
 * Handles billing triggers: keyword + emoji in group messages
 */
export async function processWebhook(payload) {
  // Log raw payload
  db.prepare('INSERT INTO webhook_log (raw_data) VALUES (?)').run(JSON.stringify(payload));

  const { typeWebhook, messageData, senderData } = payload;

  // Only handle incoming text messages
  if (typeWebhook !== 'incomingMessageReceived') return;
  if (!messageData?.textMessageData?.textMessage) return;

  const chatId = senderData?.chatId;
  const sender = senderData?.sender; // e.g. "962790000000@c.us"
  const text = messageData.textMessageData.textMessage;

  // Only process messages from our target group
  if (chatId !== TARGET_GROUP) return;

  // Get all active billing rules
  const rules = db.prepare('SELECT * FROM billing_rules WHERE is_active = 1').all();

  for (const rule of rules) {
    const keywordMatch = rule.keyword && text.includes(rule.keyword);
    const emojiMatch = rule.emoji ? text.includes(rule.emoji) : true;

    if (keywordMatch && emojiMatch) {
      await processBillingTrigger(sender, text, rule, chatId);
      break; // Apply only first matching rule
    }
  }

  // Mark log as processed
  db.prepare('UPDATE webhook_log SET processed = 1 WHERE id = (SELECT MAX(id) FROM webhook_log)').run();
}

async function processBillingTrigger(senderWaId, text, rule, groupId) {
  // Normalize phone: "962790000000@c.us" → "962790000000"
  const phone = senderWaId.replace('@c.us', '');

  // Find or register member
  let member = getMember(phone);

  if (!member) {
    // Auto-register with phone as name (will be updated on next group sync)
    upsertMember(phone, phone, senderWaId);
    member = getMember(phone);
  }

  if (!member) return;

  // Check if blocked
  if (member.is_blocked) {
    await sendMessage(groupId,
      `⛔ عذراً @${phone}، حسابك موقوف. تواصل مع المدير.`
    );
    return;
  }

  const amount = rule.amount;

  // Check sufficient balance
  if (member.balance < amount) {
    await sendMessage(groupId,
      `❌ رصيدك غير كافٍ @${phone}\n` +
      `💰 رصيدك الحالي: ${member.balance.toFixed(2)} د.أ\n` +
      `💳 المبلغ المطلوب: ${amount.toFixed(2)} د.أ\n` +
      `📞 تواصل مع المدير لشحن رصيدك.`
    );
    return;
  }

  // Debit the member
  const newBalance = debitMember(
    member.id,
    amount,
    rule.description || `خصم تلقائي - ${rule.keyword}`,
    text
  );

  // Send confirmation to group
  await sendMessage(groupId,
    `✅ تم الخصم بنجاح!\n` +
    `👤 ${member.name || phone}\n` +
    `💳 المبلغ المخصوم: ${amount.toFixed(2)} د.أ\n` +
    `💰 رصيدك الحالي: ${newBalance.toFixed(2)} د.أ`
  );
}
