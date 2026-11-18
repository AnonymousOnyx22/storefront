// POST /.netlify/functions/discord-interactions
// discord interactions endpoint: ticket panel buttons and key verification.
// register this URL in the discord developer portal under "interactions endpoint url".
import {
  api, guildId, assignRole, getMember, createChannel,
  editChannelPerms, moveChannel, sendMessage, verifyInteraction,
  VIEW_CHANNEL, SEND_MESSAGES, READ_HISTORY,
} from '../lib/discord.mjs';
import {
  TIERS, getOrderByKey, isKey, normKey, json, serve, expiresAt,
  normEmail, isEmail, siteUrl,
} from '../lib/core.mjs';

const PUBLIC_KEY = () => process.env.DISCORD_APP_PUBLIC_KEY || '';
const OPEN_CAT = () => process.env.DISCORD_OPEN_TICKETS_CATEGORY || '';
const CLOSED_CAT = () => process.env.DISCORD_CLOSED_TICKETS_CATEGORY || '';
const STAFF_ROLE = () => process.env.DISCORD_STAFF_ROLE_ID || '';
const VERIFIED_ROLE = () => process.env.DISCORD_VERIFIED_ROLE_ID || '';

// interaction types
const PING = 1;
const COMPONENT = 3;
const MODAL_SUBMIT = 5;

// response types
const PONG = 1;
const CHANNEL_MSG = 4;
const DEFERRED_MSG = 5;
const MODAL = 9;

const TICKET_CATEGORIES = {
  'ticket:purchase': { label: 'Purchase Support', prefix: 'purchase' },
  'ticket:hardware': { label: 'Hardware Issue', prefix: 'hardware' },
  'ticket:account':  { label: 'Account Issue', prefix: 'account' },
  'ticket:bug':      { label: 'Bug Report', prefix: 'bug' },
  'ticket:other':    { label: 'Other', prefix: 'other' },
};

function respond(type, data) {
  return json(200, { type, data });
}

function ephemeral(content) {
  return respond(CHANNEL_MSG, { content, flags: 64 });
}

async function followup(token, data) {
  const appId = process.env.DISCORD_APP_ID || '';
  return api('POST', `/webhooks/${appId}/${token}`, data);
}

const ticketTimes = new Map();
const TICKET_COOLDOWN = 60_000;

async function createTicketChannel(prefix, label, user) {
  const openCat = OPEN_CAT();
  if (!openCat) return null;

  const guild = guildId();
  const staffRole = STAFF_ROLE();
  const tag = user.username.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'user';
  const suffix = Date.now().toString(36).slice(-4);

  const overwrites = [
    { id: guild, type: 0, deny: String(VIEW_CHANNEL), allow: '0' },
    { id: user.id, type: 1, allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY), deny: '0' },
  ];
  if (staffRole) {
    overwrites.push({ id: staffRole, type: 0, allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY), deny: '0' });
  }

  return createChannel(`${prefix}-${tag}-${suffix}`, {
    type: 0,
    parent_id: openCat,
    topic: `${label} ticket opened by ${user.username}`,
    permission_overwrites: overwrites,
  });
}

async function handlePurchaseButton(interaction) {
  const user = interaction.member?.user || interaction.user;
  if (!user) return ephemeral('Could not identify you.');

  const last = ticketTimes.get(user.id) || 0;
  if (Date.now() - last < TICKET_COOLDOWN) {
    return ephemeral('Wait a minute before opening another ticket.');
  }
  ticketTimes.set(user.id, Date.now());

  const ch = await createTicketChannel('purchase', 'Purchase', user);
  if (!ch) return ephemeral('Ticket system is not configured. Contact staff directly.');

  const tierOptions = Object.entries(TIERS)
    .filter(([, t]) => !t.retired)
    .map(([k, t]) => ({
      label: `${t.label} - $${t.price}`,
      value: k,
      description: `$${t.price} USD, unlimited spoofs`,
    }));

  await sendMessage(ch.id, {
    content: `<@${user.id}>`,
    embeds: [{
      title: 'Purchase Slate',
      description: 'Select a tier below to get started. You will pay via PayPal and receive your key by email.',
      color: 0xffffff,
      timestamp: new Date().toISOString(),
    }],
    components: [
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'purchase:tier',
          placeholder: 'Select a tier',
          options: tierOptions,
        }],
      },
      {
        type: 1,
        components: [{
          type: 2,
          style: 4,
          label: 'Close Ticket',
          custom_id: 'ticket:close',
        }],
      },
    ],
  });

  return ephemeral(`Ticket created: <#${ch.id}>`);
}

async function handleTierSelect(interaction) {
  const tier = interaction.data?.values?.[0];
  if (!tier || !TIERS[tier] || TIERS[tier].retired) return ephemeral('Invalid tier.');

  const t = TIERS[tier];
  return respond(MODAL, {
    title: `Purchase: ${t.label} - $${t.price}`,
    custom_id: `purchase:email:${tier}`,
    components: [{
      type: 1,
      components: [{
        type: 4,
        custom_id: 'email_input',
        label: 'Email (your key will be sent here)',
        style: 1,
        placeholder: 'you@example.com',
        required: true,
        min_length: 5,
        max_length: 100,
      }],
    }],
  });
}

async function handlePurchaseEmail(interaction, tier) {
  const user = interaction.member?.user || interaction.user;
  if (!user) return ephemeral('Could not identify you.');

  const components = interaction.data?.components || [];
  const row = components[0]?.components || [];
  const rawEmail = row.find(c => c.custom_id === 'email_input')?.value || '';
  const email = normEmail(rawEmail);

  if (!isEmail(email)) return ephemeral('Invalid email address. Try again.');

  const t = TIERS[tier];
  if (!t || t.retired) return ephemeral('Invalid tier.');

  const site = siteUrl();
  const checkoutUrl = `${site}/checkout.html?tier=${tier}`;

  const channelId = interaction.channel_id || interaction.channel?.id;
  if (channelId) {
    await sendMessage(channelId, {
      embeds: [{
        title: `Purchase: ${t.label} - $${t.price}`,
        description: [
          `**Tier:** ${t.label}`,
          `**Price:** $${t.price} USD`,
          `**Email:** \`${email}\``,
          '',
          `Click the link below to complete your purchase. Your key will be emailed to \`${email}\` automatically after payment.`,
          '',
          `**[Pay Now](${checkoutUrl})**`,
        ].join('\n'),
        color: 0xffffff,
        timestamp: new Date().toISOString(),
      }],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 4,
          label: 'Close Ticket',
          custom_id: 'ticket:close',
        }],
      }],
    });
  }

  return ephemeral(`Checkout link posted in the ticket. Pay there and your key emails automatically.`);
}

async function handleTicketButton(customId, interaction) {
  if (customId === 'ticket:purchase') return handlePurchaseButton(interaction);

  const cat = TICKET_CATEGORIES[customId];
  if (!cat) return ephemeral('Unknown ticket type.');

  const user = interaction.member?.user || interaction.user;
  if (!user) return ephemeral('Could not identify you.');

  const last = ticketTimes.get(user.id) || 0;
  if (Date.now() - last < TICKET_COOLDOWN) {
    return ephemeral('Wait a minute before opening another ticket.');
  }
  ticketTimes.set(user.id, Date.now());

  const ch = await createTicketChannel(cat.prefix, cat.label, user);
  if (!ch) return ephemeral('Ticket system is not configured. Contact staff directly.');

  await sendMessage(ch.id, {
    content: `<@${user.id}>`,
    embeds: [{
      title: cat.label,
      description: `Ticket opened by <@${user.id}>.\nDescribe your issue below and staff will respond.`,
      color: 0xffffff,
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 4,
        label: 'Close Ticket',
        custom_id: 'ticket:close',
      }],
    }],
  });

  return ephemeral(`Ticket created: <#${ch.id}>`);
}

async function handleTicketClose(interaction) {
  const channelId = interaction.channel_id || interaction.channel?.id;
  if (!channelId) return ephemeral('Could not identify channel.');

  const user = interaction.member?.user || interaction.user;
  const staffRole = STAFF_ROLE();
  const isStaff = staffRole && interaction.member?.roles?.includes(staffRole);
  const perms = BigInt(interaction.member?.permissions || '0');
  const isAdmin = (perms & (1n << 3n)) !== 0n;

  if (!isStaff && !isAdmin) return ephemeral('Only staff can close tickets.');

  const closedCat = CLOSED_CAT();
  if (!closedCat) return ephemeral('Closed tickets category is not configured.');

  await moveChannel(channelId, closedCat);

  const ch = await api('GET', `/channels/${channelId}`);
  if (ch && ch.permission_overwrites) {
    for (const ow of ch.permission_overwrites) {
      if (ow.type === 1) {
        await editChannelPerms(channelId, ow.id, 0, Number(VIEW_CHANNEL), 1);
      }
    }
  }

  await sendMessage(channelId, {
    embeds: [{
      title: 'Ticket Closed',
      description: `Closed by <@${user.id}>.`,
      color: 0x8c8c8c,
      timestamp: new Date().toISOString(),
    }],
  });

  return ephemeral('Ticket closed.');
}

async function handleVerifyStart() {
  return respond(MODAL, {
    title: 'Verify Your Key',
    custom_id: 'verify:submit',
    components: [{
      type: 1,
      components: [{
        type: 4,
        custom_id: 'key_input',
        label: 'Slate License Key',
        style: 1,
        placeholder: 'SLT-XXXX-XXXX-XXXX-XXXX',
        required: true,
        min_length: 10,
        max_length: 30,
      }],
    }],
  });
}

async function handleVerifySubmit(interaction) {
  const user = interaction.member?.user || interaction.user;
  if (!user) return ephemeral('Could not identify you.');

  const roleId = VERIFIED_ROLE();
  if (!roleId) return ephemeral('Verification is not configured. Contact staff.');

  const components = interaction.data?.components || [];
  const row = components[0]?.components || [];
  const rawKey = row.find(c => c.custom_id === 'key_input')?.value || '';
  const key = normKey(rawKey);

  if (!isKey(key)) return ephemeral('Invalid key format. Keys look like SLT-XXXX-XXXX-XXXX-XXXX.');

  const order = await getOrderByKey(key);
  if (!order) return ephemeral('Key not found. Check the key and try again.');
  if (order.revoked) return ephemeral('This key has been revoked.');
  const exp = expiresAt(order);
  if (exp != null && Date.now() > exp) return ephemeral('This key has expired. Renew to keep the role.');

  await assignRole(user.id, roleId);

  return ephemeral('Key verified. You now have the Verified Buyer role.');
}

async function handle(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  const signature = event.headers['x-signature-ed25519'] || '';
  const timestamp = event.headers['x-signature-timestamp'] || '';
  const rawBody = event.body || '';

  if (!verifyInteraction(rawBody, signature, timestamp, PUBLIC_KEY())) {
    return json(401, { error: 'invalid signature' });
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: 'bad json' }); }

  if (body.type === PING) return respond(PONG);

  const customId = body.data?.custom_id || '';

  if (body.type === COMPONENT) {
    if (customId in TICKET_CATEGORIES) return handleTicketButton(customId, body);
    if (customId === 'ticket:close') return handleTicketClose(body);
    if (customId === 'verify:start') return handleVerifyStart();
    if (customId === 'purchase:tier') return handleTierSelect(body);
    return ephemeral('Unknown action.');
  }

  if (body.type === MODAL_SUBMIT) {
    if (customId === 'verify:submit') return handleVerifySubmit(body);
    if (customId.startsWith('purchase:email:')) {
      const tier = customId.replace('purchase:email:', '');
      return handlePurchaseEmail(body, tier);
    }
    return ephemeral('Unknown form.');
  }

  return json(400, { error: 'unhandled' });
}

export default serve(handle);
