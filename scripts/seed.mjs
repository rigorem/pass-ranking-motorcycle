// Legt die Pässe aus data/seed-passes.json in Redis an.
//
//   npm run seed            – nur fehlende Pässe anlegen
//   npm run seed -- --force – vorhandene überschreiben (Bewertungen gehen verloren)
//
// Braucht UPSTASH_REDIS_REST_URL und UPSTASH_REDIS_REST_TOKEN in der Umgebung,
// am einfachsten über `vercel env pull .env.local` und
// `node --env-file=.env.local scripts/seed.mjs`.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Redis } from '@upstash/redis';

const force = process.argv.includes('--force');
const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('Fehlt: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

const redis = new Redis({ url, token });
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
