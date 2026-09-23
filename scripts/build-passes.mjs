// Baut data/passes-alps.json aus OpenStreetMap.
//
//   node scripts/build-passes.mjs                 – frisch von Overpass laden
//   node scripts/build-passes.mjs --from roh.json – eine gespeicherte Antwort verwenden
//
// Genommen werden benannte Pässe (mountain_pass=yes) im Alpenbogen, die auf
// einer Straße liegen – Wanderscharten bleiben draußen.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'data', 'passes-alps.json');

const QUERY = `[out:json][timeout:600];
node["mountain_pass"="yes"]["name"](43.4,4.5,48.6,16.6)->.p;
way(bn.p)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"]->.r;
node(w.r)->.onroad;
node.p.onroad;
out body;`;

// OSM packt bei zweisprachigen Pässen gern beide Namen in ein Feld
// ("Passo Sella - Sellajoch"). Für die Anzeige wollen wir einen davon.
function pickPrimary(t) {
  if (t['name:de']) return t['name:de'];
  const n = t.name || '';
  return n.includes(' - ') ? n.split(' - ')[0].trim() : n;
}

async function fetchRaw() {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'pass-ranking-motorcycle/1.0' },
    body: new URLSearchParams({ data: QUERY })
  });
  if (!res.ok) throw new Error('Overpass antwortet mit ' + res.status);
  return res.json();
}

const fromArg = process.argv.indexOf('--from');
const raw = fromArg > -1
  ? JSON.parse(await readFile(process.argv[fromArg + 1], 'utf8'))
  : await fetchRaw();

const seen = new Set();
const out = [];

for (const el of raw.elements) {
  const t = el.tags;
  if (!t || !t.name) continue;

  const primary = pickPrimary(t);
  if (!primary) continue;

  // Zwei Knoten für denselben Pass (Nord- und Südrampe) kommen vor.
  const dupKey = primary.toLowerCase() + '|' + (t.ele || '');
  if (seen.has(dupKey)) continue;
  seen.add(dupKey);

  const alt = t.ele && /^-?\d+(\.\d+)?$/.test(t.ele) ? Math.round(Number(t.ele)) : null;
  const rec = { n: primary };
  const it = t['name:it'];
  const lld = t['name:lld'];
  const alt_name = t.alt_name;

  if (it && it !== primary) rec.it = it;
  if (lld && lld !== primary) rec.lld = lld;
  if (alt !== null) rec.alt = alt;
  // Koordinaten: die Region wird beim Auswählen über /api/place nachgeschlagen,
  // geraten wird sie nicht – ein falsches Tal ist ärgerlicher als ein leeres Feld.
  rec.lat = Math.round(el.lat * 1e4) / 1e4;
  rec.lon = Math.round(el.lon * 1e4) / 1e4;

  // Weitere Schreibweisen nur für die Suche, nicht für die Anzeige.
  const extra = [t.name, alt_name, t['name:fr'], t['name:sl'], t['name:rm']]
    .filter(Boolean)
    .flatMap(v => v.split(' - '))
    .map(v => v.trim())
    .filter(v => v && v !== primary && v !== it && v !== lld);
  const uniqueExtra = [...new Set(extra)];
  if (uniqueExtra.length) rec.a = uniqueExtra;

  out.push(rec);
}

out.sort((a, b) => a.n.localeCompare(b.n, 'de'));
await writeFile(OUT, JSON.stringify(out));

const bytes = JSON.stringify(out).length;
console.log(`${out.length} Pässe, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`mit Höhe: ${out.filter(p => p.alt).length}, italienisch: ${out.filter(p => p.it).length}, ladinisch: ${out.filter(p => p.lld).length}`);
