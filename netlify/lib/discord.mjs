// discord REST helpers for the storefront. no gateway, no sdk, plain fetch.
// used by the interactions endpoint and the payment webhook for role assignment.
import { verify as cryptoVerify } from 'node:crypto';

const TOKEN = () => process.env.DISCORD_BOT_TOKEN || '';
const GUILD = () => process.env.DISCORD_GUILD_ID || '';

export async function api(method, path, body, _retries = 0) {
  const opts = {
    method,
    headers: {
      authorization: `Bot ${TOKEN()}`,
      'content-type': 'application/json',
    },
  };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  const r = await fetch(`https://discord.com/api/v10${path}`, opts);
  if (r.status === 429 && _retries < 3) {
    const d = await r.json().catch(() => ({}));
    await new Promise(res => setTimeout(res, ((d.retry_after || 2) * 1000) + 500));
    return api(method, path, body, _retries + 1);
  }
  if (r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) {
    console.error(`discord ${method} ${path} ${r.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return text ? JSON.parse(text) : null;
}

export const guildId = () => GUILD();

export async function assignRole(userId, roleId) {
  return api('PUT', `/guilds/${GUILD()}/members/${userId}/roles/${roleId}`, {});
}

export async function removeRole(userId, roleId) {
  return api('DELETE', `/guilds/${GUILD()}/members/${userId}/roles/${roleId}`);
}

export async function getMember(userId) {
  return api('GET', `/guilds/${GUILD()}/members/${userId}`);
}

export async function searchMembers(query, limit = 5) {
  return api('GET', `/guilds/${GUILD()}/members/search?query=${encodeURIComponent(query)}&limit=${limit}`);
}

export async function createChannel(name, opts = {}) {
  return api('POST', `/guilds/${GUILD()}/channels`, { name, ...opts });
}

export async function editChannelPerms(channelId, overwriteId, allow, deny, type = 0) {
  return api('PUT', `/channels/${channelId}/permissions/${overwriteId}`, {
    type,
    allow: String(allow),
    deny: String(deny),
  });
}

export async function moveChannel(channelId, parentId) {
  return api('PATCH', `/channels/${channelId}`, { parent_id: parentId });
}

export async function sendMessage(channelId, data) {
  return api('POST', `/channels/${channelId}/messages`, data);
}

export async function deleteChannel(channelId) {
  return api('DELETE', `/channels/${channelId}`);
}

// ed25519 verification for discord interaction webhooks.
// uses node's built-in crypto (node 16+), no npm deps.
export function verifyInteraction(rawBody, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const msg = Buffer.from(timestamp + rawBody);
    const sig = Buffer.from(signature, 'hex');
    const key = Buffer.from(publicKey, 'hex');
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const derKey = Buffer.concat([derPrefix, key]);
    return cryptoVerify(null, msg, { key: derKey, format: 'der', type: 'spki' }, sig);
  } catch {
    return false;
  }
}

// discord permission bits used by the ticket system
export const VIEW_CHANNEL = 1n << 10n;
export const SEND_MESSAGES = 1n << 11n;
export const READ_HISTORY = 1n << 16n;
export const MANAGE_CHANNELS = 1n << 4n;
