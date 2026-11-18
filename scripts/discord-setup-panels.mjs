// one-time setup: posts the ticket panel and key verification panel to discord.
// run once after configuring the interactions endpoint in the developer portal.
//
// usage:
//   DISCORD_BOT_TOKEN=... DISCORD_TICKET_CHANNEL=<id> DISCORD_VERIFY_CHANNEL=<id> node scripts/discord-setup-panels.mjs
//
// optional: pass --delete-ops to delete the channel named "ops" (keeps the OPS category).

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;
const TICKET_CHANNEL = process.env.DISCORD_TICKET_CHANNEL;
const VERIFY_CHANNEL = process.env.DISCORD_VERIFY_CHANNEL;

if (!TOKEN || !GUILD) { console.error('need DISCORD_BOT_TOKEN + DISCORD_GUILD_ID'); process.exit(1); }

const api = async (method, path, body) => {
  const opts = { method, headers: { authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://discord.com/api/v10${path}`, opts);
  if (r.status === 429) {
    const d = await r.json().catch(() => ({}));
    await new Promise(res => setTimeout(res, ((d.retry_after || 2) * 1000) + 500));
    return api(method, path, body);
  }
  const text = await r.text();
  if (!r.ok) { console.error(`${method} ${path} ${r.status}: ${text.slice(0, 300)}`); return null; }
  return text ? JSON.parse(text) : null;
};

const args = process.argv.slice(2);

(async () => {
  // post ticket panel
  if (TICKET_CHANNEL) {
    console.log('posting ticket panel...');
    const msg = await api('POST', `/channels/${TICKET_CHANNEL}/messages`, {
      embeds: [{
        title: 'Open a Ticket',
        description: 'Need help? Pick the category that fits your issue. A private channel will be created for you and staff.',
        color: 0xffffff,
      }],
      components: [{
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Purchase Support', custom_id: 'ticket:purchase' },
          { type: 2, style: 1, label: 'Hardware Issue', custom_id: 'ticket:hardware' },
          { type: 2, style: 1, label: 'Account Issue', custom_id: 'ticket:account' },
        ],
      }, {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Bug Report', custom_id: 'ticket:bug' },
          { type: 2, style: 2, label: 'Other', custom_id: 'ticket:other' },
        ],
      }],
    });
    if (msg) console.log(`ticket panel posted: ${msg.id}`);
  } else {
    console.log('skipping ticket panel (DISCORD_TICKET_CHANNEL not set)');
  }

  // post verification panel
  if (VERIFY_CHANNEL) {
    console.log('posting verification panel...');
    const msg = await api('POST', `/channels/${VERIFY_CHANNEL}/messages`, {
      embeds: [{
        title: 'Verify Your Purchase',
        description: 'Paste your slate license key to get the Verified Buyer role. This confirms you own a key without revealing it to anyone else.',
        color: 0xffffff,
      }],
      components: [{
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Verify Key', custom_id: 'verify:start' },
        ],
      }],
    });
    if (msg) console.log(`verification panel posted: ${msg.id}`);
  } else {
    console.log('skipping verification panel (DISCORD_VERIFY_CHANNEL not set)');
  }

  // delete OPS channel if requested
  if (args.includes('--delete-ops')) {
    console.log('looking for OPS channel to delete...');
    const channels = await api('GET', `/guilds/${GUILD}/channels`);
    if (channels) {
      // find text/voice channels named "ops" but not categories (type 4)
      const opsChannels = channels.filter(c => c.name.toLowerCase() === 'ops' && c.type !== 4);
      for (const ch of opsChannels) {
        const typeName = ch.type === 0 ? 'text' : ch.type === 2 ? 'voice' : `type ${ch.type}`;
        console.log(`  deleting ${typeName} channel "ops" (${ch.id})...`);
        await api('DELETE', `/channels/${ch.id}`);
        console.log(`  deleted.`);
      }
      if (!opsChannels.length) console.log('  no OPS channel found (categories preserved).');
    }
  }

  // print env var reference
  console.log('\n--- env vars for the interactions endpoint ---');
  console.log('DISCORD_APP_PUBLIC_KEY    your app\'s public key (developer portal > general)');
  console.log('DISCORD_APP_ID            your app id (developer portal > general)');
  console.log('DISCORD_BOT_TOKEN         bot token');
  console.log('DISCORD_GUILD_ID          server id');
  console.log('DISCORD_OPEN_TICKETS_CATEGORY    category id for open tickets');
  console.log('DISCORD_CLOSED_TICKETS_CATEGORY  category id for closed tickets');
  console.log('DISCORD_STAFF_ROLE_ID     staff role id (staff can see + close tickets)');
  console.log('DISCORD_VERIFIED_ROLE_ID  verified buyer role id');

  console.log('\ndone.');
})();
