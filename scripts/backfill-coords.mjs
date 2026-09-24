// Trägt Koordinaten bei Pässen nach, die vor den Kartenvorschauen angelegt
// wurden. Gesucht wird über den Katalog, nach deutschem, italienischem und
// ladinischem Namen sowie den Nebenschreibweisen.
//
//   node scripts/backfill-coords.mjs          – zeigt nur an
//   node scripts/backfill-coords.mjs --write  – schreibt
//
// Schreibt in das Redis aus REDIS_URL (Vorgabe: redis://127.0.0.1:6379).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redis } from '../api/_lib/redis.js';

const write = process.argv.includes('--write');
const here = dirname(fileURLToPath(import.meta.url));


const fold = s => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const catalog = JSON.parse(await readFile(join(here, '..', 'data', 'passes-alps.json'), 'utf8'));
const index = new Map();
for (const p of catalog) {
  for (const name of [p.n, p.it, p.lld, ...(p.a || [])]) {
    if (name && !index.has(fold(name))) index.set(fold(name), p);
  }
}

const ids = await redis.smembers('passes:ids');
let done = 0, missing = 0, already = 0;

for (const id of ids) {
  const raw = await redis.hgetall('pass:' + id);
  if (!raw) continue;
  if (raw.lat !== undefined && raw.lat !== '' && raw.lat !== null) { already++; continue; }

  const hit = index.get(fold(raw.de)) || index.get(fold(raw.intl || '')) || index.get(fold(raw.lad || ''));
  if (!hit) {
    console.log(`  ?  ${raw.de} – kein Treffer im Katalog`);
    missing++;
    continue;
  }
  console.log(`  ${write ? '+' : '·'}  ${raw.de} -> ${hit.lat}, ${hit.lon}`);
  if (write) await redis.hset('pass:' + id, { lat: hit.lat, lon: hit.lon });
  done++;
}

if (write && done) await redis.incr('passes:rev');
console.log(`\n${done} ${write ? 'ergänzt' : 'zu ergänzen'}, ${already} hatten schon Koordinaten, ${missing} ohne Treffer.`);
if (!write && done) console.log('Zum Schreiben nochmal mit --write aufrufen.');
await redis.quit();
