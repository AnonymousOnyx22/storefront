// sets up discord automod rules for the slate server.
// run once. re-running updates existing rules by name.
//
// usage:
//   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/discord-setup-automod.mjs
//
// optional env:
//   DISCORD_LOG_CHANNEL   channel to send automod alerts to

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;
const ALERT_CHANNEL = process.env.DISCORD_LOG_CHANNEL || '';

if (!TOKEN || !GUILD) { console.error('need DISCORD_BOT_TOKEN + DISCORD_GUILD_ID'); process.exit(1); }

const api = async (method, path, body, _retries = 0) => {
  const opts = { method, headers: { authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://discord.com/api/v10${path}`, opts);
  if (r.status === 429 && _retries < 3) {
    const d = await r.json().catch(() => ({}));
    await new Promise(res => setTimeout(res, ((d.retry_after || 2) * 1000) + 500));
    return api(method, path, body, _retries + 1);
  }
  if (r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) { console.error(`${method} ${path} ${r.status}: ${text.slice(0, 300)}`); return null; }
  return text ? JSON.parse(text) : null;
};

const actions = (block = true, alert = true) => {
  const a = [];
  if (block) a.push({ type: 1, metadata: {} });
  if (alert && ALERT_CHANNEL) a.push({ type: 2, metadata: { channel_id: ALERT_CHANNEL } });
  return a;
};

// automod trigger types:
//   1 = keyword, 3 = spam, 4 = keyword preset, 5 = mention spam
const RULES = [
  {
    name: 'Block spam links',
    event_type: 1,
    trigger_type: 1,
    trigger_metadata: {
      keyword_filter: [
        '*discord.gg/*', '*discordapp.com/invite/*',
        '*bit.ly/*', '*tinyurl.com/*', '*t.co/*',
        '*steamcommunity.com/*', '*steampowered.com/*',
        'free nitro', 'free discord', 'claim your',
        '*airdrop*', '*giveaway*claim*',
      ],
      regex_patterns: [],
    },
    actions: actions(true, true),
    enabled: true,
  },
  {
    name: 'Block profanity',
    event_type: 1,
    trigger_type: 4,
    trigger_metadata: {
      presets: [1, 2, 3],
    },
    actions: actions(true, true),
    enabled: true,
  },
  {
    name: 'Block mention spam',
    event_type: 1,
    trigger_type: 5,
    trigger_metadata: {
      mention_total_limit: 5,
    },
    actions: actions(true, true),
    enabled: true,
  },
  {
    name: 'Block spam messages',
    event_type: 1,
    trigger_type: 3,
    trigger_metadata: {},
    actions: actions(true, true),
    enabled: true,
  },
];

(async () => {
  const existing = await api('GET', `/guilds/${GUILD}/auto-moderation/rules`);
  if (!existing) { console.error('failed to fetch existing rules'); process.exit(1); }

  const byName = new Map(existing.map(r => [r.name, r]));

  for (const rule of RULES) {
    const prev = byName.get(rule.name);
    if (prev) {
      console.log(`updating "${rule.name}" (${prev.id})...`);
      const updated = await api('PATCH', `/guilds/${GUILD}/auto-moderation/rules/${prev.id}`, rule);
      if (updated) console.log(`  updated.`);
    } else {
      console.log(`creating "${rule.name}"...`);
      const created = await api('POST', `/guilds/${GUILD}/auto-moderation/rules`, rule);
      if (created) console.log(`  created: ${created.id}`);
    }
  }

  console.log('\nautomod rules configured. make sure the bot has MANAGE_GUILD permission.');
  if (!ALERT_CHANNEL) console.log('tip: set DISCORD_LOG_CHANNEL to get automod alerts in a channel.');
  console.log('done.');
})();
