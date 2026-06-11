// lib/webhookProcessor.js
import db, { getMember, upsertMember, debitMember } from '../db/database.js';
import { sendMessage } from './greenApi.js';

const TARGET_GROUP = process.env.GROUP_ID;

/**
 * Process an incoming Green API webhook payload
 * Handles billing triggers: keyword + emoji in group messages
 */
export async function processWebhook(payload) {
  console.log('[WEBHOOK] Received webhook:', JSON.stringify({type: payload?.typeWebhook, text: payload?.messageData?.textMessageData?.textMessage}));
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
  console.log('[WEBHOOK] Rules found:', rules.length, 'First keyword:', rules[0]?.keyword, 'First emoji:', rules[0]?.emoji);

  for (const rule of rules) {
    const keywordMatch = rule.keyword && text.includes(rule.keyword);
    const emojiMatch = rule.emoji ? text.includes(rule.emoji) : true;

    if (keywordMatch && emojiMatch) {
      console.log('[WEBHOOK] MATCH! Rule:', rule.id, rule.keyword, rule.emoji, 'Text:', text);
      await processBillingTrigger(sender, text, rule, chatId);
      break; // Apply only first matching rule
    }
  }

  // Mark log as processed
  db.prepare('UPDATE webhook_log SET processed = 1 WHERE id = (SELECT MAX(id) FROM webhook_log)').run();
}

async function processBillingTrigger(senderWaId, text, rule, groupId) {
  // Normalize phone: "962790000000@c.us" أ¢â€ â€™ "962790000000"
  const phone = senderWaId.replace('@c.us', '');

  // Find or register member
  let member = getMember(phone);

  if (!member) {
    // Auto-register with phone as name (will be updated on next group sync)
    upsertMember(phone, phone, senderWaId);
    member = getMember(phone);
  }

  if (!member) return;
  console.log('[BILLING] Member check - admin:', member.is_admin, 'blocked:', member.is_blocked, 'balance:', member.balance, 'vs rule amount:', rule.amount);

  // Skip billing for admins
  if (member.is_admin) {
    return;
  }

  // Check if blocked
  if (member.is_blocked) {
    await sendMessage(groupId,
      `أ¢â€؛â€‌ ط·آ¹ط·آ°ط·آ±ط·آ§ط¸â€¹ @${phone}ط·إ’ ط·آ­ط·آ³ط·آ§ط·آ¨ط¸ئ’ ط¸â€¦ط¸ث†ط¸â€ڑط¸ث†ط¸ظ¾. ط·ع¾ط¸ث†ط·آ§ط·آµط¸â€‍ ط¸â€¦ط·آ¹ ط·آ§ط¸â€‍ط¸â€¦ط·آ¯ط¸ظ¹ط·آ±.`
    );
    return;
  }

  const amount = rule.amount;

  // Check sufficient balance
  if (member.balance < amount) {
    await sendMessage(groupId,
      `أ¢â€Œإ’ ط·آ±ط·آµط¸ظ¹ط·آ¯ط¸ئ’ ط·ط›ط¸ظ¹ط·آ± ط¸ئ’ط·آ§ط¸ظ¾ط¸ع† @${phone}\n` +
      `ظ‹ع؛â€™آ° ط·آ±ط·آµط¸ظ¹ط·آ¯ط¸ئ’ ط·آ§ط¸â€‍ط·آ­ط·آ§ط¸â€‍ط¸ظ¹: ${member.balance.toFixed(2)} ط·آ¯.ط·آ£\n` +
      `ظ‹ع؛â€™آ³ ط·آ§ط¸â€‍ط¸â€¦ط·آ¨ط¸â€‍ط·ط› ط·آ§ط¸â€‍ط¸â€¦ط·آ·ط¸â€‍ط¸ث†ط·آ¨: ${amount.toFixed(2)} ط·آ¯.ط·آ£\n` +
      `ظ‹ع؛â€œâ€چ ط·ع¾ط¸ث†ط·آ§ط·آµط¸â€‍ ط¸â€¦ط·آ¹ ط·آ§ط¸â€‍ط¸â€¦ط·آ¯ط¸ظ¹ط·آ± ط¸â€‍ط·آ´ط·آ­ط¸â€  ط·آ±ط·آµط¸ظ¹ط·آ¯ط¸ئ’.`
    );
    return;
  }

  // Debit the member
  console.log('[BILLING] ABOUT TO DEBIT - member:', member.id, 'amount:', amount);
  const newBalance = debitMember(
    member.id,
    amount,
    rule.description || `ط·آ®ط·آµط¸â€¦ ط·ع¾ط¸â€‍ط¸â€ڑط·آ§ط·آ¦ط¸ظ¹ - ${rule.keyword}`,
    text
  );

  // Send confirmation to group
  await sendMessage(groupId,
    `أ¢إ“â€¦ ط·ع¾ط¸â€¦ ط·آ§ط¸â€‍ط·آ®ط·آµط¸â€¦ ط·آ¨ط¸â€ ط·آ¬ط·آ§ط·آ­!\n` +
    `ظ‹ع؛â€کآ¤ ${member.name || phone}\n` +
    `ظ‹ع؛â€™آ³ ط·آ§ط¸â€‍ط¸â€¦ط·آ¨ط¸â€‍ط·ط› ط·آ§ط¸â€‍ط¸â€¦ط·آ®ط·آµط¸ث†ط¸â€¦: ${amount.toFixed(2)} ط·آ¯.ط·آ£\n` +
    `ظ‹ع؛â€™آ° ط·آ±ط·آµط¸ظ¹ط·آ¯ط¸ئ’ ط·آ§ط¸â€‍ط·آ­ط·آ§ط¸â€‍ط¸ظ¹: ${newBalance.toFixed(2)} ط·آ¯.ط·آ£`
  );
}
