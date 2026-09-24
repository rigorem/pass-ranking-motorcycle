// Einmalig beim Umzug: holt alles aus Upstash Redis und Vercel Blob auf den
// eigenen Server.
//
//   cd /srv/passeranking/app
//   sudo -u passe npm install --no-save @upstash/redis @vercel/blob
//   sudo -u passe node --env-file=/etc/passeranking.env scripts/migrate-from-vercel.mjs
//
// Braucht zusätzlich zu REDIS_URL und DATA_DIR die alten Zugänge:
// UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, BLOB_READ_WRITE_TOKEN.
//
// Darf beliebig oft laufen. Schlüssel werden jedes Mal genau so übernommen,
// wie sie in Upstash stehen; Dateien nur geholt, wenn sie hier noch fehlen
// oder eine andere Größe haben. So geht ein erster Lauf, während die Seite
// noch auf Vercel läuft, und ein kurzer letzter beim Umschalten.

import { createClient } from 'redis';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const need = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'BLOB_READ_WRITE_TOKEN'];
const missing = need.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Fehlt in der Umgebung: ' + missing.join(', '));
  process.exit(1);
}

let Upstash, blobApi;
try {
  ({ Redis: Upstash } = await import('@upstash/redis'));
  blobApi = await import('@vercel/blob');
} catch {
  console.error('Erst die alten Pakete holen: npm install --no-save @upstash/redis @vercel/blob');
  process.exit(1);
}

const ROOT = path.resolve(process.env.DATA_DIR || '.data', 'blobs');
// Rohwerte, keine JSON-Umwandlung: was in Upstash steht, steht danach genau so hier.
const from = new Upstash({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  automaticDeserialization: false
});
const to = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
await to.connect();

/* ----------------------------------------------------------- Redis --- */

const counts = { string: 0, hash: 0, set: 0, skipped: 0 };
let cursor = '0';
do {
  const [next, keys] = await from.scan(cursor, { count: 500 });
  cursor = String(next);
  for (const key of keys) {
    const type = await from.type(key);
    const ttl = await from.pttl(key);
    const multi = to.multi().del(key);
    if (type === 'string') {
      multi.set(key, String(await from.get(key)));
    } else if (type === 'hash') {
      const fields = await from.hgetall(key) || {};
      const plain = Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, String(v)]));
      if (Object.keys(plain).length) multi.hSet(key, plain);
    } else if (type === 'set') {
      const members = (await from.smembers(key)).map(String);
      if (members.length) multi.sAdd(key, members);
    } else {
      console.warn(`  übersprungen: ${key} (${type})`);
      counts.skipped++;
      continue;
    }
    if (ttl > 0) multi.pExpire(key, ttl);
    await multi.exec();
    counts[type]++;
  }
} while (cursor !== '0');

console.log(`Redis: ${counts.string} Werte, ${counts.hash} Hashes, ${counts.set} Mengen übernommen` +
  (counts.skipped ? `, ${counts.skipped} übersprungen` : ''));

/* ----------------------------------------------------------- Dateien --- */

async function sizeOf(file) {
  try { return (await stat(file)).size; } catch { return -1; }
}

let fetched = 0, present = 0, failed = 0, bytes = 0;
let blobCursor;
do {
  const page = await blobApi.list({ cursor: blobCursor, limit: 1000 });
  for (const b of page.blobs) {
    const file = path.resolve(ROOT, b.pathname);
    if (!file.startsWith(ROOT + path.sep)) { failed++; continue; }
    if (await sizeOf(file) === b.size) { present++; continue; }
    try {
      const found = await blobApi.get(b.pathname, { access: 'private' });
      if (!found || found.statusCode !== 200) throw new Error('status ' + (found && found.statusCode));
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.part';
      await pipeline(Readable.fromWeb(found.stream), createWriteStream(tmp));
      await rename(tmp, file);
      fetched++;
      bytes += b.size;
    } catch (e) {
      failed++;
      await rm(file + '.part', { force: true });
      console.warn(`  fehlgeschlagen: ${b.pathname} (${e.message || e})`);
    }
  }
  blobCursor = page.hasMore ? page.cursor : undefined;
} while (blobCursor);

console.log(`Dateien: ${fetched} geholt (${(bytes / 1e6).toFixed(1)} MB), ${present} waren schon da` +
  (failed ? `, ${failed} fehlgeschlagen – einfach nochmal laufen lassen` : ''));

/* ----------------------------------------------------------- Probe --- */

// Zeigt jeder Verweis in Redis auf eine Datei, die jetzt hier liegt?
let refs = 0, dangling = 0;
for await (const keys of to.scanIterator({ MATCH: 'photo:*', COUNT: 500 })) {
  for (const key of [].concat(keys)) {
    refs++;
    const p = await to.get(key);
    if (!p || await sizeOf(path.resolve(ROOT, p)) < 0) {
      dangling++;
      if (dangling <= 10) console.warn(`  ohne Datei: ${key} -> ${p}`);
    }
  }
}
console.log(`Probe: ${refs} Foto-/Videoverweise, ${dangling} ohne Datei.`);

await to.quit();
process.exit(failed || dangling ? 2 : 0);
