// Der Eingang: Fotos, die angekommen sind, aber noch keinem Pass gehören –
// ohne GPS aufgenommen, oder zu weit von allem entfernt, was wir kennen.

import { redis } from './store.js';

const ITEMS = 'inbox:items';
const REV = 'inbox:rev';

export const inboxKey = () => ITEMS;

export async function bumpInboxRev() {
  try { return Number(await redis.incr(REV)); } catch { return null; }
}

export async function inboxRev() {
  try { return Number((await redis.get(REV)) || 0); } catch { return 0; }
}

export async function inboxCount() {
  try { return Number(await redis.hlen(ITEMS)) || 0; } catch { return 0; }
}

// Alles im Eingang, neueste Aufnahme zuerst.
export async function listInbox() {
  const raw = await redis.hgetall(ITEMS);
  if (!raw) return [];
  return Object.entries(raw).map(([id, value]) => {
    const v = typeof value === 'string' ? safe(value) : (value || {});
    return {
      id,
      taken: v.taken || '',
      lat: typeof v.lat === 'number' ? v.lat : null,
      lon: typeof v.lon === 'number' ? v.lon : null
    };
  }).sort((a, b) => String(b.taken).localeCompare(String(a.taken)));
}

export async function dropInbox(ids) {
  if (!ids.length) return;
  await redis.hdel(ITEMS, ...ids);
}

function safe(s) { try { return JSON.parse(s); } catch { return {}; } }
