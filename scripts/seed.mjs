// Legt die Pässe aus data/seed-passes.json in Redis an.
//
//   npm run seed            – nur fehlende Pässe anlegen
//   npm run seed -- --force – vorhandene überschreiben (Bewertungen gehen verloren)
//
// Schreibt in das Redis aus REDIS_URL (Vorgabe: redis://127.0.0.1:6379).
// Auf dem Server: sudo -u passe node --env-file=/etc/passeranking.env scripts/seed.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redis } from '../api/_lib/redis.js';

const force = process.argv.includes('--force');
const here = dirname(fileURLToPath(import.meta.url));

const seed = JSON.parse(await readFile(join(here, '..', 'data', 'seed-passes.json'), 'utf8'));

let added = 0, skipped = 0;
for (const p of seed) {
  const key = 'pass:' + p.id;
  if (!force && await redis.exists(key)) { skipped++; continue; }
  await redis.hset(key, {
    de: p.de,
    intl: p.intl ?? '',
    lad: p.lad ?? '',
    alt: p.alt ?? '',
    region: p.region ?? '',
    fun: p.fun ?? '',
    amb: p.amb ?? '',
    note: p.note ?? '',
    photos: JSON.stringify(p.photos ?? []),
    order: p.order ?? 0
  });
  await redis.sadd('passes:ids', p.id);
  added++;
}

console.log(`${added} Pässe angelegt, ${skipped} übersprungen.`);
await redis.quit();
