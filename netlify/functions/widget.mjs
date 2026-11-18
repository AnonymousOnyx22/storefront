// live "online" count for the header badge.
//
// the browser cannot call discord directly: widget.json carries no
// access-control-allow-origin, so a cross-origin fetch is blocked before it
// starts. this proxies it same-origin, caches for a minute, and never leaks a
// token. if the guild has the widget switched off, or discord is slow, it
// answers with the last known good figure instead of failing.
//
// guild id comes from DISCORD_GUILD, so pointing the badge at a different
// server is an env change, not a deploy of new code.
import { serve, json } from '../lib/core.mjs';

const GUILD = (process.env.DISCORD_GUILD_ID || process.env.DISCORD_GUILD || '1511613081954947102').trim();
const TTL = 60_000;

let cached = { at: 0, online: null };

async function pull() {
  const now = Date.now();
  // negative results are cached too, so a disabled widget does not turn every
  // page view into a call to discord.
  if (now - cached.at < TTL) return cached.online;

  let online = cached.online;

  try {
    const res = await fetch(`https://discord.com/api/guilds/${GUILD}/widget.json`, {
      headers: { accept: 'application/json', 'user-agent': 'slate-storefront' },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const body = await res.json();
      const n = Number(body.presence_count);
      if (Number.isFinite(n) && n >= 0) online = n;
    }
    // 404 / code 50004 = widget disabled. keep the last figure we saw.
  } catch (e) {
    // network or timeout. same: keep what we had.
  }

  cached = { at: now, online };
  return online;
}

export default serve(async event => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return json(405, { error: 'method' });
  }

  let online = null;
  try {
    online = await pull();
  } catch (e) {
    online = cached.online;
  }

  // null means "no figure right now" — widget off, discord unreachable, or a
  // cold cache. the page keeps whatever it is already showing.
  return json(200, { online }, {
    'cache-control': online === null ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300',
  });
});
