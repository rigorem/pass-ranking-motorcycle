import { guardWrite } from './_lib/auth.js';
import { redis, listPasses, patchPass, photoKey } from './_lib/store.js';
import { shaKey, hashKey } from './_lib/photos.js';
import { listInbox, dropInbox, bumpInboxRev } from './_lib/inbox.js';
import { get as getBlob, del as deleteBlob } from '@vercel/blob';

// Doppelte Fotos finden und entfernen.
//
// Verglichen werden die Bytes, nicht die Dateinamen – dasselbe Bild zweimal
// hochgeladen ergibt zwei Blobs, die sonst niemandem auffallen. Seit dem
// Upload wird der Fingerabdruck mitgeschrieben; für ältere Fotos holt diese
// Funktion ihn einmal nach und merkt ihn sich.
//
// Ohne `apply` wird nichts verändert, nur berichtet.

const BUDGET_MS = 40000;

async function shaOf(id) {
  try {
    const known = await redis.get(shaKey(id));
    if (known) return String(known);
  } catch { /* dann eben rechnen */ }

  const path = await redis.get(photoKey(id));
  if (!path) return null;                       // verwaister Verweis
  const found = await getBlob(String(path), { access: 'private' });
  if (!found || found.statusCode !== 200) return null;

  const bytes = Buffer.from(await new Response(found.stream).arrayBuffer());
  const crypto = await import('node:crypto');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  try { await redis.set(shaKey(id), sha); } catch { /* nächstes Mal wieder */ }
  return sha;
}

async function forget(id) {
  try {
    const path = await redis.get(photoKey(id));
    if (path) await deleteBlob(String(path));
    await redis.del(photoKey(id));
    const sha = await redis.get(shaKey(id));
    if (sha) {
      // Den Rückweg nur löschen, wenn er auf genau dieses Foto zeigt.
      const owner = await redis.get(hashKey(String(sha)));
      if (String(owner) === id) await redis.del(hashKey(String(sha)));
    }
    await redis.del(shaKey(id));
  } catch { /* ein übrig gebliebenes Blob ist kein Grund abzubrechen */ }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guardWrite(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = typeof req.body === 'string' ? safe(req.body) : (req.body || {});
  const apply = body.apply === true;
  const deadline = Date.now() + BUDGET_MS;

  try {
    const [passes, inbox] = await Promise.all([listPasses(), listInbox()]);

    // Wo steckt welches Foto? Ein Foto kann in mehreren Pässen hängen.
    const places = new Map();                   // photoId -> [{kind, passId}]
    for (const p of passes) {
      for (const id of p.photos || []) {
        if (!places.has(id)) places.set(id, []);
        places.get(id).push({ kind: 'pass', passId: p.id, name: p.de });
      }
    }
    for (const it of inbox) {
      if (!places.has(it.id)) places.set(it.id, []);
      places.get(it.id).push({ kind: 'inbox' });
    }

    // Fingerabdrücke einsammeln, so weit die Zeit reicht.
    const byHash = new Map();
    let hashed = 0, skipped = 0, orphans = 0;
    for (const id of places.keys()) {
      if (Date.now() > deadline) { skipped++; continue; }
      const sha = await shaOf(id);
      if (!sha) { orphans++; continue; }
      hashed++;
      if (!byHash.has(sha)) byHash.set(sha, []);
      byHash.get(sha).push(id);
    }

    // Was doppelt ist, und wo.
    const withinPass = [];                      // sicher entfernbar
    const acrossPasses = [];                    // nur melden
    for (const [sha, ids] of byHash) {
      if (ids.length < 2) continue;
      const passesOf = new Map();
      for (const id of ids) {
        for (const w of places.get(id) || []) {
          const key = w.kind === 'inbox' ? 'inbox' : w.passId;
          if (!passesOf.has(key)) passesOf.set(key, []);
          passesOf.get(key).push(id);
        }
      }
      for (const [where, list] of passesOf) {
        if (list.length > 1) withinPass.push({ sha, where, keep: list[0], drop: list.slice(1) });
      }
      if (passesOf.size > 1) {
        acrossPasses.push({
          sha,
          orte: [...passesOf.keys()].map(k => {
            const p = passes.find(x => x.id === k);
            return p ? p.de : k;
          })
        });
      }
    }

    const doomed = [...new Set(withinPass.flatMap(g => g.drop))];

    if (!apply) {
      return res.status(200).json({
        applied: false,
        scanned: places.size, hashed, skipped, orphans,
        duplicates: doomed.length,
        groups: withinPass.length,
        alsoInOtherPasses: acrossPasses
      });
    }

    // Erst aus den Listen nehmen, dann die Bytes wegwerfen – in dieser
    // Reihenfolge, damit nie ein Verweis auf ein gelöschtes Blob übrig bleibt.
    let removed = 0;
    for (const p of passes) {
      const before = p.photos || [];
      const after = before.filter(id => !doomed.includes(id));
      if (after.length !== before.length) await patchPass(p.id, { photos: after });
    }
    const inboxDoomed = inbox.filter(it => doomed.includes(it.id)).map(it => it.id);
    if (inboxDoomed.length) { await dropInbox(inboxDoomed); await bumpInboxRev(); }

    for (const id of doomed) { await forget(id); removed++; }

    return res.status(200).json({
      applied: true,
      scanned: places.size, hashed, skipped, orphans,
      removed, groups: withinPass.length,
      alsoInOtherPasses: acrossPasses
    });
  } catch (e) {
    return res.status(500).json({ error: 'dedupe_failed', detail: String(e.message || e) });
  }
}

function safe(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
