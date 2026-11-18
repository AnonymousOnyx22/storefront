// sets up the basalt product channels in discord.
// creates a BASALT category with announcement, chat, media and support channels.
//
// usage:
//   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/discord-setup-basalt.mjs
//
// optional env:
//   DISCORD_STAFF_ROLE_ID    staff can see the support channel
//   DISCORD_BASALT_ROLE_ID   basalt buyer role (gets access to gated channels)

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;
const STAFF = process.env.DISCORD_STAFF_ROLE_ID;
const BASALT_ROLE = process.env.DISCORD_BASALT_ROLE_ID;

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
  if (r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) { console.error(`${method} ${path} ${r.status}: ${text.slice(0, 300)}`); return null; }
  return text ? JSON.parse(text) : null;
};

(async () => {
  // create BASALT category
  console.log('creating BASALT category...');
  const category = await api('POST', `/guilds/${GUILD}/channels`, {
    name: 'BASALT',
    type: 4, // category
  });
  if (!category) { console.error('failed to create category'); process.exit(1); }
  console.log(`  category: ${category.id}`);

  const catId = category.id;

  // channels to create under the category
  const channels = [
    { name: 'basalt-announcements', type: 5, topic: 'Basalt updates, patches and status changes.' },
    { name: 'basalt-chat', type: 0, topic: 'General discussion about basalt.' },
    { name: 'basalt-media', type: 0, topic: 'Screenshots, clips and gameplay.' },
    { name: 'basalt-support', type: 0, topic: 'Help with basalt. Open a ticket for private issues.' },
  ];

  // type 5 = announcement/news channel, type 0 = text
  for (const ch of channels) {
    console.log(`creating #${ch.name}...`);
    const payload = {
      name: ch.name,
      type: ch.type,
      topic: ch.topic,
      parent_id: catId,
    };

    // announcements channel: read-only for everyone except staff
    if (ch.name === 'basalt-announcements') {
      payload.permission_overwrites = [
        { id: GUILD, type: 0, deny: '2048' }, // everyone: deny SEND_MESSAGES
      ];
      if (STAFF) {
        payload.permission_overwrites.push(
          { id: STAFF, type: 0, allow: '2048' } // staff: allow SEND_MESSAGES
        );
      }
    }

    const created = await api('POST', `/guilds/${GUILD}/channels`, payload);
    if (created) {
      console.log(`  #${ch.name}: ${created.id}`);
    }
  }

  console.log('\n--- basalt channels created ---');
  console.log('category id:', catId);
  console.log('\nadd these to your .env if needed:');
  console.log('DISCORD_BASALT_CATEGORY_ID=' + catId);

  if (BASALT_ROLE) {
    console.log('\nbasalt buyer role configured: ' + BASALT_ROLE);
  } else {
    console.log('\ntip: create a "basalt" role in discord and set DISCORD_BASALT_ROLE_ID to gate channels later.');
  }

  console.log('\ndone.');
})();
