// slate admin bot. gateway bot that stays online, monitors site health,
// logs moderation events, and posts audit entries to a log channel.
//
// env:
//   DISCORD_BOT_TOKEN        (required)
//   DISCORD_GUILD_ID         server id
//   DISCORD_STATUS_CHANNEL   channel for site up/down alerts
//   DISCORD_LOG_CHANNEL      channel for audit/mod log embeds
//   CHECK_URL                url to health-check (default https://useslate.net)
//   CHECK_NAME               label for health checks (default "storefront")
//   CHECK_MODE               "html" | "api" | "any"
//   RENDER_EXTERNAL_URL      set by render; used for self-ping keep-alive
//   SLATE_SITE_URL           fallback base url

import { WebSocket } from 'ws';
import { createServer } from 'node:http';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;
const STATUS_CHANNEL = process.env.DISCORD_STATUS_CHANNEL;
const LOG_CHANNEL = process.env.DISCORD_LOG_CHANNEL;
const SITE = process.env.SLATE_SITE_URL || 'https://useslate.net';
const CHECK_INTERVAL = 5 * 60 * 1000;
const KEEPALIVE_INTERVAL = 4 * 60 * 1000;

const NAME = process.env.CHECK_NAME || 'storefront';
const URL = process.env.CHECK_URL || SITE;
const MODE = process.env.CHECK_MODE || 'html';

if (!TOKEN) { console.error('DISCORD_BOT_TOKEN required'); process.exit(1); }

// -- discord REST --
const discordApi = async (method, path, body, _retries = 0) => {
  const opts = { method, headers: { authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://discord.com/api/v10${path}`, opts);
  if (r.status === 429 && _retries < 3) {
    const retry = (await r.json().catch(() => ({}))).retry_after || 2;
    await new Promise(res => setTimeout(res, retry * 1000 + 500));
    return discordApi(method, path, body, _retries + 1);
  }
  if (r.status === 204) return null;
  if (!r.ok) {
    const text = await r.text();
    console.error(`${method} ${path} ${r.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

// -- audit log --
const log = async (title, description, color = 0x8c8c8c, fields = []) => {
  if (!LOG_CHANNEL) return;
  await discordApi('POST', `/channels/${LOG_CHANNEL}/messages`, {
    embeds: [{
      title,
      description,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  });
};

// -- health check --
const validate = (status, body) => {
  if (MODE === 'api') {
    if (status === 400) {
      try { return !!JSON.parse(body).error; } catch { return false; }
    }
    return status < 500;
  }
  if (MODE === 'html') return status === 200 && body.includes('<html');
  return status < 500;
};

const runCheck = async () => {
  const t = Date.now();
  try {
    const r = await fetch(URL, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': 'slate-bot/1.0' },
    });
    const ms = Date.now() - t;
    if (r.status >= 500) return { ok: false, ms, detail: `HTTP ${r.status}` };
    const body = await r.text();
    const passed = validate(r.status, body);
    return { ok: passed, ms, detail: passed ? `${r.status}` : `${r.status} (bad body)` };
  } catch (err) {
    return { ok: false, ms: Date.now() - t, detail: err.code || err.message || 'timeout' };
  }
};

// -- gateway state --
let ws = null;
let heartbeatInterval = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let lastStatus = null;
let botUser = null;

const sendPresence = (up) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    op: 3,
    d: {
      since: null,
      activities: [{
        name: up ? `${NAME}: operational` : `${NAME}: down`,
        type: 3,
      }],
      status: up ? 'online' : 'dnd',
      afk: false,
    },
  }));
};

const postStatusUpdate = async (up, result) => {
  if (!STATUS_CHANNEL) return;
  const line = `${up ? '[UP]' : '[DOWN]'} **${NAME}** -- ${result.ms}ms${up ? '' : ' (' + result.detail + ')'}`;
  await discordApi('POST', `/channels/${STATUS_CHANNEL}/messages`, {
    embeds: [{
      title: up ? `${NAME.toUpperCase()}: UP` : `${NAME.toUpperCase()}: DOWN`,
      color: up ? 0x2ecc71 : 0xe74c3c,
      description: line,
      footer: { text: URL },
      timestamp: new Date().toISOString(),
    }],
  });
};

const checkAndUpdate = async () => {
  const result = await runCheck();
  sendPresence(result.ok);

  if (lastStatus !== null && lastStatus !== result.ok) {
    await postStatusUpdate(result.ok, result);
  }
  lastStatus = result.ok;
  console.log(`[${new Date().toISOString()}] ${NAME} ${result.ok ? 'UP' : 'DOWN'} ${result.ms}ms`);
};

// -- event handlers --
const handleMemberAdd = async (d) => {
  const tag = d.user?.username || 'unknown';
  const id = d.user?.id || '?';
  const created = d.user?.id ? new Date(Number(BigInt(d.user.id) >> 22n) + 1420070400000) : null;
  const age = created ? Math.floor((Date.now() - created.getTime()) / 86400000) : null;
  const fields = [];
  if (age !== null) fields.push({ name: 'account age', value: `${age} days`, inline: true });
  fields.push({ name: 'id', value: id, inline: true });
  await log('Member Joined', `**${tag}** (<@${id}>)`, 0x2ecc71, fields);
};

const handleMemberRemove = async (d) => {
  const tag = d.user?.username || 'unknown';
  const id = d.user?.id || '?';
  await log('Member Left', `**${tag}** (<@${id}>)`, 0xe74c3c, [
    { name: 'id', value: id, inline: true },
  ]);
};

const handleBanAdd = async (d) => {
  const tag = d.user?.username || 'unknown';
  const id = d.user?.id || '?';
  await log('Member Banned', `**${tag}** (<@${id}>)`, 0xe74c3c, [
    { name: 'id', value: id, inline: true },
  ]);
};

const handleBanRemove = async (d) => {
  const tag = d.user?.username || 'unknown';
  const id = d.user?.id || '?';
  await log('Member Unbanned', `**${tag}** (<@${id}>)`, 0x2ecc71, [
    { name: 'id', value: id, inline: true },
  ]);
};

const handleMessageDelete = async (d) => {
  const channelId = d.channel_id;
  const fields = [{ name: 'channel', value: `<#${channelId}>`, inline: true }];
  if (d.id) fields.push({ name: 'message id', value: d.id, inline: true });
  await log('Message Deleted', `A message was deleted in <#${channelId}>.`, 0xffa500, fields);
};

const handleAutoModExecution = async (d) => {
  const user = d.user_id ? `<@${d.user_id}>` : 'unknown';
  const rule = d.rule_trigger_type;
  const action = d.action?.type;
  const content = (d.content || '').slice(0, 200);
  const matched = d.matched_keyword || d.matched_content || '';

  const triggerNames = { 1: 'keyword', 3: 'spam', 4: 'keyword preset', 5: 'mention spam' };
  const actionNames = { 1: 'block message', 2: 'alert', 3: 'timeout' };

  const fields = [
    { name: 'user', value: user, inline: true },
    { name: 'trigger', value: triggerNames[rule] || `type ${rule}`, inline: true },
    { name: 'action', value: actionNames[action] || `type ${action}`, inline: true },
  ];
  if (matched) fields.push({ name: 'matched', value: `\`${matched.slice(0, 100)}\`` });
  if (content) fields.push({ name: 'content', value: content.slice(0, 200) });
  if (d.channel_id) fields.push({ name: 'channel', value: `<#${d.channel_id}>`, inline: true });

  await log('AutoMod Action', `AutoMod triggered on ${user}.`, 0xffa500, fields);
};

// -- gateway --
// intents:
//   GUILDS (0), GUILD_MEMBERS (1), GUILD_MODERATION (2),
//   GUILD_MESSAGES (9), MESSAGE_CONTENT (15),
//   AUTO_MODERATION_CONFIGURATION (20), AUTO_MODERATION_EXECUTION (21)
// GUILDS (0), GUILD_MODERATION (2), GUILD_MESSAGES (9)
const INTENTS = (1 << 0) | (1 << 2) | (1 << 9);

const heartbeat = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 1, d: seq }));
  }
};

const identify = () => {
  ws.send(JSON.stringify({
    op: 2,
    d: {
      token: TOKEN,
      intents: INTENTS,
      properties: { os: 'linux', browser: 'slate-bot', device: 'slate-bot' },
      presence: {
        activities: [{ name: 'Watching over Slate', type: 3 }],
        status: 'online',
        afk: false,
      },
    },
  }));
};

const connect = (url) => {
  const gateway = url || 'wss://gateway.discord.gg/?v=10&encoding=json';
  console.log(`[admin] connecting to ${gateway.slice(0, 40)}...`);
  ws = new WebSocket(gateway);

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.s) seq = msg.s;

    switch (msg.op) {
      case 10: {
        const interval = msg.d.heartbeat_interval;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(heartbeat, interval);
        heartbeat();
        if (sessionId && resumeUrl) {
          ws.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: sessionId, seq } }));
        } else {
          identify();
        }
        break;
      }

      case 11: break;

      case 7:
        ws.close();
        break;

      case 9:
        sessionId = null;
        await new Promise(r => setTimeout(r, 3000));
        identify();
        break;

      case 0: {
        const t = msg.t;
        const d = msg.d;

        if (t === 'READY') {
          sessionId = d.session_id;
          resumeUrl = d.resume_gateway_url;
          botUser = d.user;
          console.log(`[admin] connected as ${d.user.username}`);
          await checkAndUpdate();
        }

        if (t === 'GUILD_MEMBER_ADD') await handleMemberAdd(d).catch(e => console.error('log error:', e.message));
        if (t === 'GUILD_MEMBER_REMOVE') await handleMemberRemove(d).catch(e => console.error('log error:', e.message));
        if (t === 'GUILD_BAN_ADD') await handleBanAdd(d).catch(e => console.error('log error:', e.message));
        if (t === 'GUILD_BAN_REMOVE') await handleBanRemove(d).catch(e => console.error('log error:', e.message));
        if (t === 'MESSAGE_DELETE') await handleMessageDelete(d).catch(e => console.error('log error:', e.message));
        if (t === 'AUTO_MODERATION_ACTION_EXECUTION') await handleAutoModExecution(d).catch(e => console.error('log error:', e.message));

        break;
      }
    }
  });

  ws.on('close', (code) => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    const fatal = [4004, 4010, 4011, 4012, 4013, 4014].includes(code);
    if (fatal) {
      console.error(`[admin] fatal close code ${code}, not reconnecting`);
      process.exit(1);
    }
    const resumable = code !== 4007 && code !== 4009 && sessionId;
    if (!resumable) { sessionId = null; resumeUrl = null; }
    console.log(`[admin] disconnected (${code}), reconnecting in 5s...`);
    setTimeout(() => connect(resumable ? resumeUrl : null), 5000);
  });

  ws.on('error', (err) => {
    console.error(`[admin] ws error:`, err.message);
  });
};

// -- keep-alive self-ping --
// render free tier sleeps after 15 min of no inbound requests.
// ping our own health endpoint every 4 min to prevent that.
const startKeepAlive = () => {
  const extUrl = process.env.RENDER_EXTERNAL_URL;
  if (!extUrl) {
    console.log('[admin] RENDER_EXTERNAL_URL not set, skipping self-ping keep-alive');
    return;
  }
  console.log(`[admin] keep-alive pinging ${extUrl} every ${KEEPALIVE_INTERVAL / 1000}s`);
  setInterval(async () => {
    try {
      await fetch(extUrl, { signal: AbortSignal.timeout(10000) });
    } catch {}
  }, KEEPALIVE_INTERVAL);
};

// -- http health endpoint --
const PORT = process.env.PORT || 3000;
createServer((req, res) => {
  const status = lastStatus === null ? 'starting' : lastStatus ? 'up' : 'down';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: NAME, status, bot: botUser?.username || null }));
}).listen(PORT, () => console.log(`[admin] http health on :${PORT}`));

connect();
startKeepAlive();
setInterval(checkAndUpdate, CHECK_INTERVAL);
