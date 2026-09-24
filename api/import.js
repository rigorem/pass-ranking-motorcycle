import { guardUpload } from './_lib/auth.js';
import { redis, listPasses, appendPhotos } from './_lib/store.js';
import { metersBetween } from './_lib/route.js';
import { ALLOWED, readBody, contentType, storePhoto, fingerprint, hashKey } from './_lib/photos.js';
import { inboxKey, bumpInboxRev } from './_lib/inbox.js';

// Nimmt ein Foto vom Kurzbefehl auf dem Handy entgegen: Bild im Rumpf,
// Koordinaten und Aufnahmezeit in Kopfzeilen. Was nah genug an einem Pass
// aufgenommen wurde, landet direkt dort; alles andere im Eingang.
//
// Die Koordinaten stehen bewusst in Kopfzeilen und nicht in der Adresse –
// Query-Strings landen in Logs, Standortdaten haben dort nichts zu suchen.

const MATCH_RADIUS_M = Number(process.env.MATCH_RADIUS_M || 3000);

function coordinate(value, limit) {
  // Achtung: Number('') ist 0, nicht NaN. Ohne diese Prüfung landet jedes Foto
  // ohne Ortsangabe bei 0°/0° im Atlantik – und bekommt dort einen Vorschlag.
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

// Der nächstgelegene Pass mit Koordinaten – samt Entfernung, auch wenn er
// weit weg ist. Der Eingang zeigt ihn dann als Vorschlag an.
export function nearestPass(passes, lat, lon) {
  let best = null;
  for (const p of passes) {
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    const d = metersBetween({ lat, lon }, { lat: p.lat, lon: p.lon });
    if (!best || d < best.distanceM) best = { pass: p, distanceM: Math.round(d) };
  }
  return best;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.UPLOAD_TOKEN && !process.env.APP_PASSWORD) {
    return res.status(501).json({ error: 'upload_not_configured' });
  }
  if (!guardUpload(req, res)) return;

  const type = contentType(req);
  if (!ALLOWED.has(type)) return res.status(415).json({ error: 'unsupported_type' });

  const lat = coordinate(req.headers['x-photo-lat'], 90);
  const lon = coordinate(req.headers['x-photo-lon'], 180);
  const taken = String(req.headers['x-photo-taken'] || '').trim().slice(0, 40);

  try {
    const data = await readBody(req);
    if (!data.length) return res.status(400).json({ error: 'empty_body' });

    // Zweimal dasselbe Foto geschickt? Dann die vorhandene Id zurückgeben.
    const sha = fingerprint(data);
    let known = null;
    try { known = await redis.get(hashKey(sha)); } catch { /* ohne Cache halt neu */ }
    if (known) {
      return res.status(200).json({ id: String(known), duplicate: true, passId: null });
    }

    const id = await storePhoto(data, type);
    try { await redis.set(hashKey(sha), id); } catch { /* nicht schlimm */ }

    // Zuordnen, wenn ein Pass nah genug liegt.
    if (lat !== null && lon !== null) {
      const hit = nearestPass(await listPasses(), lat, lon);
      if (hit && hit.distanceM <= MATCH_RADIUS_M) {
        const pass = await appendPhotos(hit.pass.id, [id]);
        if (pass) {
          return res.status(201).json({
            id, duplicate: false,
            passId: hit.pass.id, passName: hit.pass.de, distanceM: hit.distanceM
          });
        }
      }
    }

    // Sonst in den Eingang – mit allem, was wir wissen, damit die Oberfläche
    // einen brauchbaren Vorschlag machen kann.
    await redis.hset(inboxKey(), { [id]: JSON.stringify({ taken, lat, lon }) });
    await bumpInboxRev();
    return res.status(201).json({ id, duplicate: false, passId: null, inbox: true });
  } catch (e) {
    return res.status(500).json({ error: 'import_failed', detail: String(e.message || e) });
  }
}
