// Redis auf demselben Server, erreichbar nur über localhost.
//
// Der übrige Code ist für @upstash/redis geschrieben worden. Statt ihn an
// siebzig Stellen umzubauen, bildet dieser Adapter genau die Befehle nach, die
// er benutzt – mit demselben Verhalten wie Upstash:
//
//   - Was kein String ist, wird als JSON abgelegt; Strings gehen unverändert.
//   - Was sich beim Lesen als JSON lesen lässt, kommt als Wert zurück
//     ("2211" -> 2211, '["a"]' -> ["a"]), alles andere als String.
//   - hgetall auf einen fehlenden Schlüssel ergibt null, nicht {}.
//
// Ist Redis nicht erreichbar, schlagen Befehle sofort fehl statt zu warten –
// die Aufrufer fangen das ab und machen ohne weiter, wo das geht.

import { createClient } from 'redis';

const client = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  disableOfflineQueue: true
});
client.on('error', e => console.error('[redis]', e.message));

let connecting = null;
function conn() {
  if (client.isReady) return Promise.resolve(client);
  if (!connecting) {
    connecting = client.connect().then(() => client).finally(() => { connecting = null; });
  }
  return connecting;
}

async function cmd(...args) {
  const c = await conn();
  return c.sendCommand(args.map(String));
}

const enc = v => (typeof v === 'string' ? v : JSON.stringify(v));

function dec(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// HGETALL kommt je nach Protokoll als flache Liste oder als Objekt.
function pairs(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out = {};
    for (let i = 0; i < raw.length; i += 2) out[raw[i]] = raw[i + 1];
    return out;
  }
  return raw instanceof Map ? Object.fromEntries(raw) : raw;
}

export const redis = {
  get: async key => dec(await cmd('GET', key)),

  // Unterstützt die beiden Formen, die vorkommen: { ex } und { nx, ex }.
  // Ergibt 'OK', oder null wenn nx den Schreibvorgang verhindert hat.
  async set(key, value, opts = {}) {
    const args = ['SET', key, enc(value)];
    if (opts.ex) args.push('EX', opts.ex);
    if (opts.nx) args.push('NX');
    return cmd(...args);
  },

  del: (...keys) => cmd('DEL', ...keys),
  exists: (...keys) => cmd('EXISTS', ...keys),
  expire: (key, seconds) => cmd('EXPIRE', key, seconds),
  incr: key => cmd('INCR', key),

  async hset(key, fields) {
    const flat = Object.entries(fields).flatMap(([f, v]) => [f, enc(v)]);
    return flat.length ? cmd('HSET', key, ...flat) : 0;
  },

  async hgetall(key) {
    const obj = pairs(await cmd('HGETALL', key));
    const keys = Object.keys(obj);
    if (!keys.length) return null;
    for (const k of keys) obj[k] = dec(obj[k]);
    return obj;
  },

  hdel: (key, ...fields) => cmd('HDEL', key, ...fields),
  hlen: key => cmd('HLEN', key),
  sadd: (key, ...members) => cmd('SADD', key, ...members.map(enc)),
  smembers: async key => ((await cmd('SMEMBERS', key)) || []).map(dec),
  srem: (key, ...members) => cmd('SREM', key, ...members.map(enc)),

  // Für Skripte, die nach getaner Arbeit beenden wollen.
  async quit() { if (client.isOpen) await client.quit(); }
};
