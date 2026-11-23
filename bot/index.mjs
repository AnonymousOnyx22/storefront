// slate status bot. runs multiple watchers in one process, each with its own
// discord gateway connection and presence. one service, multiple bot users.
//
// env:
//   WATCHERS                  JSON array of watcher configs (see below)
//   DISCORD_GUILD_ID          server id (shared)
//   DISCORD_STATUS_CHANNEL    channel for site up/down alerts (shared, optional)
//   DISCORD_LOG_CHANNEL       channel for audit/mod log embeds (shared, optional)
//   RENDER_EXTERNAL_URL       set by render/railway; used for self-ping keep-alive
//
// WATCHERS format (JSON array, each entry):
//   { "name": "storefront", "url": "https://useslate.net", "token": "...", "mode": "html" }
//
// legacy single-bot env vars still work if WATCHERS is not set:
//   DISCORD_BOT_TOKEN, CHECK_URL, CHECK_NAME, CHECK_MODE

import { WebSocket } from 'ws';
import { createServer } from 'node:http';

const GUILD = process.env.DISCORD_GUILD_ID;
const STATUS_CHANNEL = process.env.DISCORD_STATUS_CHANNEL;
const LOG_CHANNEL = process.env.DISCORD_LOG_CHANNEL;
const CHECK_INTERVAL = 5 * 60 * 1000;
const KEEPALIVE_INTERVAL = 4 * 60 * 1000;

function parseWatchers() {
  if (process.env.WATCHERS) {
    try { return JSON.parse(process.env.WATCHERS); } catch (e) {
      console.error('bad WATCHERS JSON:', e.message);
      process.exit(1);
    }
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) { console.error('WATCHERS or DISCORD_BOT_TOKEN required'); process.exit(1); }
  return [{
    name: process.env.CHECK_NAME || 'storefront',
    url: process.env.CHECK_URL || process.env.SLATE_SITE_URL || 'https://useslate.net',
    token,
    mode: process.env.CHECK_MODE || 'html',
  }];
}

const watchers = parseWatchers();
console.log(`[bot] ${watchers.length} watcher(s): ${watchers.map(w => w.name).join(', ')}`);

// -- discord REST (shared, uses per-call token) --
const discordApi = async (token, method, path, body, _retries = 0) => {
  const opts = { method, headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://discord.com/api/v10${path}`, opts);
  if (r.status === 429 && _retries < 3) {
    const retry = (await r.json().catch(() => ({}))).retry_after || 2;
    await new Promise(res => setTimeout(res, retry * 1000 + 500));
    return discordApi(token, method, path, body, _retries + 1);
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

// -- audit log (uses first watcher's token) --
const log = async (title, description, color = 0x8c8c8c, fields = []) => {
  if (!LOG_CHANNEL || !watchers[0]) return;
  await discordApi(watchers[0].token, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
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
const validate = (mode, status, body) => {
  if (mode === 'api') {
    if (status === 400) {
      try { return !!JSON.parse(body).error; } catch { return false; }
    }
    return status < 500;
  }
  if (mode === 'html') return status === 200 && body.includes('<html');
  return status < 500;
};

const runCheck = async (url, mode) => {
  const t = Date.now();
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': 'slate-bot/1.0' },
    });
    const ms = Date.now() - t;
    if (r.status >= 500) return { ok: false, ms, detail: `HTTP ${r.status}` };
    const body = await r.text();
    const passed = validate(mode, r.status, body);
    return { ok: passed, ms, detail: passed ? `${r.status}` : `${r.status} (bad body)` };
  } catch (err) {
    return { ok: false, ms: Date.now() - t, detail: err.code || err.message || 'timeout' };
  }
};

// -- per-watcher gateway state --
class Watcher {
  constructor(config) {
    this.name = config.name;
    this.url = config.url;
    this.token = config.token;
    this.mode = config.mode || 'html';
    this.ws = null;
    this.heartbeatInterval = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.lastStatus = null;
    this.botUser = null;
  }

  sendPresence(up) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      op: 3,
      d: {
        since: null,
        activities: [{
          name: up ? `${this.name}: operational` : `${this.name}: down`,
          type: 3,
        }],
        status: up ? 'online' : 'dnd',
        afk: false,
      },
    }));
  }

  async postStatusUpdate(up, result) {
    if (!STATUS_CHANNEL) return;
    const line = `${up ? '[UP]' : '[DOWN]'} **${this.name}** -- ${result.ms}ms${up ? '' : ' (' + result.detail + ')'}`;
    await discordApi(this.token, 'POST', `/channels/${STATUS_CHANNEL}/messages`, {
      embeds: [{
        title: up ? `${this.name.toUpperCase()}: UP` : `${this.name.toUpperCase()}: DOWN`,
        color: up ? 0x2ecc71 : 0xe74c3c,
        description: line,
        footer: { text: this.url },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  async checkAndUpdate() {
    const result = await runCheck(this.url, this.mode);
    this.sendPresence(result.ok);

    if (this.lastStatus !== null && this.lastStatus !== result.ok) {
      await this.postStatusUpdate(result.ok, result);
    }
    this.lastStatus = result.ok;
    console.log(`[${this.name}] ${result.ok ? 'UP' : 'DOWN'} ${result.ms}ms`);
  }

  heartbeat() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
    }
  }

  identify() {
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this.token,
        intents: (1 << 0) | (1 << 2) | (1 << 9),
        properties: { os: 'linux', browser: 'slate-bot', device: 'slate-bot' },
        presence: {
          activities: [{ name: `${this.name}: starting...`, type: 3 }],
          status: 'idle',
          afk: false,
        },
      },
    }));
  }

  connect(url) {
    const gateway = url || 'wss://gateway.discord.gg/?v=10&encoding=json';
    console.log(`[${this.name}] connecting...`);
    this.ws = new WebSocket(gateway);

    this.ws.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.s) this.seq = msg.s;

      switch (msg.op) {
        case 10: {
          const interval = msg.d.heartbeat_interval;
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = setInterval(() => this.heartbeat(), interval);
          this.heartbeat();
          if (this.sessionId && this.resumeUrl) {
            this.ws.send(JSON.stringify({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } }));
          } else {
            this.identify();
          }
          break;
        }
        case 11: break;
        case 7: this.ws.close(); break;
        case 9:
          this.sessionId = null;
          await new Promise(r => setTimeout(r, 3000));
          this.identify();
          break;
        case 0: {
          const t = msg.t;
          const d = msg.d;
          if (t === 'READY') {
            this.sessionId = d.session_id;
            this.resumeUrl = d.resume_gateway_url;
            this.botUser = d.user;
            console.log(`[${this.name}] connected as ${d.user.username}`);
            await this.checkAndUpdate();
          }
          // only the first watcher handles server events (audit log)
          if (this === watchers[0]?._instance) {
            if (t === 'GUILD_MEMBER_ADD') await handleMemberAdd(d).catch(e => console.error('log error:', e.message));
            if (t === 'GUILD_MEMBER_REMOVE') await handleMemberRemove(d).catch(e => console.error('log error:', e.message));
            if (t === 'GUILD_BAN_ADD') await handleBanAdd(d).catch(e => console.error('log error:', e.message));
            if (t === 'GUILD_BAN_REMOVE') await handleBanRemove(d).catch(e => console.error('log error:', e.message));
            if (t === 'MESSAGE_DELETE') await handleMessageDelete(d).catch(e => console.error('log error:', e.message));
            if (t === 'AUTO_MODERATION_ACTION_EXECUTION') await handleAutoModExecution(d).catch(e => console.error('log error:', e.message));
          }
          break;
        }
      }
    });

    this.ws.on('close', (code) => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      const fatal = [4004, 4010, 4011, 4012, 4013, 4014].includes(code);
      if (fatal) {
        console.error(`[${this.name}] fatal close code ${code}, not reconnecting`);
        return;
      }
      const resumable = code !== 4007 && code !== 4009 && this.sessionId;
      if (!resumable) { this.sessionId = null; this.resumeUrl = null; }
      console.log(`[${this.name}] disconnected (${code}), reconnecting in 5s...`);
      setTimeout(() => this.connect(resumable ? this.resumeUrl : null), 5000);
    });

    this.ws.on('error', (err) => {
      console.error(`[${this.name}] ws error:`, err.message);
    });
  }
}

// -- event handlers (audit log, run by first watcher only) --
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

// -- start all watchers --
const instances = watchers.map((config, i) => {
  const w = new Watcher(config);
  config._instance = w;
  // stagger connections so we don't hit discord's identify rate limit
  setTimeout(() => w.connect(), i * 6000);
  setInterval(() => w.checkAndUpdate(), CHECK_INTERVAL);
  return w;
});

// -- keep-alive self-ping --
const extUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
if (extUrl) {
  const pingUrl = extUrl.startsWith('http') ? extUrl : `https://${extUrl}`;
  console.log(`[bot] keep-alive pinging ${pingUrl} every ${KEEPALIVE_INTERVAL / 1000}s`);
  setInterval(async () => {
    try { await fetch(pingUrl, { signal: AbortSignal.timeout(10000) }); } catch {}
  }, KEEPALIVE_INTERVAL);
} else {
  console.log('[bot] no external URL set, skipping self-ping keep-alive');
}

// -- http health endpoint --
const PORT = process.env.PORT || 3000;
createServer((req, res) => {
  const status = instances.map(w => ({
    name: w.name,
    url: w.url,
    status: w.lastStatus === null ? 'starting' : w.lastStatus ? 'up' : 'down',
    bot: w.botUser?.username || null,
  }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status));
}).listen(PORT, () => console.log(`[bot] http health on :${PORT}`));
