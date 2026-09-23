import { guard } from './_lib/auth.js';
import { redis } from './_lib/store.js';

// Schlägt zu einer Koordinate die Gegend nach, damit beim Anlegen eines Passes
// nicht alles von Hand getippt werden muss. Nominatim erlaubt eine Anfrage pro
// Sekunde und keine Massenabfragen – deshalb läuft das hier über den Server
// (ein sauberer User-Agent, die IP der Nutzer bleibt draußen) und jedes
// Ergebnis wandert in Redis, sodass jeder Punkt höchstens einmal gefragt wird.
const TTL = 60 * 60 * 24 * 365;

function label(address) {
  const a = address || {};
  const ort = a.village || a.town || a.city || a.municipality || a.hamlet || '';
  const gebiet = a.county || a.state_district || a.state || '';
  const parts = [ort, gebiet].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  return parts.join(', ') || a.state || a.country || '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'bad_coordinates' });
  }

  const key = `place:${lat.toFixed(4)},${lon.toFixed(4)}`;
  try {
    const hit = await redis.get(key);
    if (hit !== null && hit !== undefined) return res.status(200).json({ region: String(hit), cached: true });
  } catch { /* ohne Cache halt direkt fragen */ }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}&accept-language=de`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'pass-ranking-motorcycle/1.0 (https://pass-ranking-motorcycle.vercel.app)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return res.status(502).json({ error: 'geocoder_unavailable' });
    const region = label((await r.json()).address);
    try { await redis.set(key, region, { ex: TTL }); } catch { /* nicht schlimm */ }
    return res.status(200).json({ region });
  } catch (e) {
    return res.status(502).json({ error: 'geocoder_unavailable' });
  }
}
