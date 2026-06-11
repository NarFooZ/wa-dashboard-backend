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
  // Normalize phone: "962790000000@c.us" â†’ "962790000000"
  const phone = senderWaId.replace('@c.us', '');

  // Find or register member
  let member = getMember(phone);

  if (!member) {
    // Auto-register with phone as name (will be updated on next group sync)
    upsertMember(phone, phone, senderWaId);
    member = getMember(phone);
  }

  if (!member) return;

  // Skip billing for admins
  if (member.is_admin) {
    return;
  }

  // Check if blocked
  if (member.is_blocked) {
    await sendMessage(groupId,
      `â›” ط¹ط°ط±ط§ظ‹ @${phone}طŒ ط­ط³ط§ط¨ظƒ ظ…ظˆظ‚ظˆظپ. طھظˆط§طµظ„ ظ…ط¹ ط§ظ„ظ…ط¯ظٹط±.`
    );
    return;
  }

  const amount = rule.amount;

  // Check sufficient balance
  if (member.balance < amount) {
    await sendMessage(groupId,
      `â‌Œ ط±طµظٹط¯ظƒ ط؛ظٹط± ظƒط§ظپظچ @${phone}\n` +
      `ًں’° ط±طµظٹط¯ظƒ ط§ظ„ط­ط§ظ„ظٹ: ${member.balance.toFixed(2)} ط¯.ط£\n` +
      `ًں’³ ط§ظ„ظ…ط¨ظ„ط؛ ط§ظ„ظ…ط·ظ„ظˆط¨: ${amount.toFixed(2)} ط¯.ط£\n` +
      `ًں“‍ طھظˆط§طµظ„ ظ…ط¹ ط§ظ„ظ…ط¯ظٹط± ظ„ط´ط­ظ† ط±طµظٹط¯ظƒ.`
    );
    return;
  }

  // Debit the member
  const newBalance = debitMember(
    member.id,
    amount,
    rule.description || `ط®طµظ… طھظ„ظ‚ط§ط¦ظٹ - ${rule.keyword}`,
    text
  );

  // Send confirmation to group
  await sendMessage(groupId,
    `âœ… طھظ… ط§ظ„ط®طµظ… ط¨ظ†ط¬ط§ط­!\n` +
    `ًں‘¤ ${member.name || phone}\n` +
    `ًں’³ ط§ظ„ظ…ط¨ظ„ط؛ ط§ظ„ظ…ط®طµظˆظ…: ${amount.toFixed(2)} ط¯.ط£\n` +
    `ًں’° ط±طµظٹط¯ظƒ ط§ظ„ط­ط§ظ„ظٹ: ${newBalance.toFixed(2)} ط¯.ط£`
  );
}
