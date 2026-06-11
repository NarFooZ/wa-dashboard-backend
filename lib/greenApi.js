// lib/greenApi.js
import axios from 'axios';

const BASE = process.env.GREEN_API_BASE_URL || 'https://api.green-api.com';
const INSTANCE = process.env.GREEN_API_INSTANCE_ID;
const TOKEN = process.env.GREEN_API_TOKEN;

const api = axios.create({
  baseURL: `${BASE}/waInstance${INSTANCE}`,
  timeout: 15000,
});

const url = (method) => `/${method}/${TOKEN}`;

// ─── Group Info ────────────────────────────────────────────

export async function getGroupInfo(groupId) {
  const res = await api.post(url('getGroupData'), { groupId });
  return res.data;
}

export async function getGroupParticipants(groupId) {
  const data = await getGroupInfo(groupId);
  return data.participants || [];
}

// ─── Group Management ──────────────────────────────────────

export async function setGroupSubject(groupId, subject) {
  const res = await api.post(url('setGroupSubject'), { groupId, groupSubject: subject });
  return res.data;
}

export async function setGroupDescription(groupId, description) {
  const res = await api.post(url('setGroupDescription'), { groupId, groupDescription: description });
  return res.data;
}

export async function addGroupParticipant(groupId, participantChatId) {
  const res = await api.post(url('addGroupParticipant'), { groupId, participantChatId });
  return res.data;
}

export async function removeGroupParticipant(groupId, participantChatId) {
  const res = await api.post(url('removeGroupParticipant'), { groupId, participantChatId });
  return res.data;
}

export async function setGroupAdmin(groupId, participantChatId) {
  const res = await api.post(url('setGroupAdmin'), { groupId, participantChatId });
  return res.data;
}

export async function removeGroupAdmin(groupId, participantChatId) {
  const res = await api.post(url('removeGroupAdmin'), { groupId, participantChatId });
  return res.data;
}

// ─── Messaging ────────────────────────────────────────────

export async function sendMessage(chatId, message) {
  const res = await api.post(url('sendMessage'), { chatId, message });
  return res.data;
}

export async function sendGroupMessage(groupId, message) {
  return sendMessage(groupId, message);
}

// ─── Webhook / Receive ────────────────────────────────────

export async function getWebhookSettings() {
  const res = await api.get(url('getSettings'));
  return res.data;
}

export async function setWebhookUrl(webhookUrl) {
  const res = await api.post(url('setSettings'), {
    webhookUrl,
    webhookUrlToken: process.env.WEBHOOK_TOKEN || '',
    incomingWebhook: 'yes',
    outgoingMessageWebhook: 'no',
  });
  return res.data;
}

// ─── Instance Status ──────────────────────────────────────

export async function getInstanceStatus() {
  const res = await api.get(url('getStateInstance'));
  return res.data;
}

export async function getQRCode() {
  const res = await api.get(url('qr'));
  return res.data;
}
