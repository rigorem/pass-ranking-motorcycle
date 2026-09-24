// Der Server der App. Die Routen unter api/ sind für Vercel geschrieben
// worden und bleiben unverändert: dieser Server findet sie über ihren
// Dateinamen und stellt ihnen die Hilfen bereit, die Vercel mitbrachte –
// req.query, einen schon gelesenen req.body und res.status()/json()/send().
//
//   api/auth.js          -> /api/auth
//   api/passes/index.js  -> /api/passes
//   api/passes/[id].js   -> /api/passes/<id>   (req.query.id)
//
// Im Betrieb steht Caddy davor, liefert die Seite selbst aus und reicht nur
// /api/* hierher weiter. Lokal (NODE_ENV != production) liefert dieser Server
// auch die Seite, damit `npm run dev` allein genügt.
//
//   PORT (3000), HOST (127.0.0.1), DATA_DIR, REDIS_URL

import http from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEV = process.env.NODE_ENV !== 'production';

// JSON und Text werden vorab gelesen, wie bei Vercel. Bilder und Videos
// bleiben als Datenstrom stehen – die Routen lesen sie selbst (readBody,
// putStream), Videos so direkt auf die Platte.
// Rohe Binärdaten (application/octet-stream) kommen als Buffer – der
// Kurzbefehl schickt Fotos je nach Einstellung so; daher dieselbe Grenze wie für Fotos.
const MAX_TEXT_BODY = 1024 * 1024;
const MAX_BINARY_BODY = 25 * 1024 * 1024;

/* ---------------------------------------------------------- Routen --- */

async function findRoutes(dir, prefix = '') {
  const routes = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...await findRoutes(full, `${prefix}/${entry.name}`));
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const base = entry.name.slice(0, -3);
    const segment = base === 'index' ? '' : `/${base}`;
    const pattern = `/api${prefix}${segment}`;
    const params = [];
    const source = pattern.split('/').map(part => {
      const m = /^\[(\w+)\]$/.exec(part);
      if (!m) return part.replace(/[.*+?^${}()|\\]/g, '\\$&');
      params.push(m[1]);
      return '([^/]+)';
    }).join('/');
    routes.push({ pattern, params, re: new RegExp(`^${source}/?$`), file: full, dynamic: params.length > 0 });
  }
  return routes;
}

// Feste Pfade vor Platzhaltern, damit /api/passes nicht als /api/[id] gilt.
const routes = (await findRoutes(path.join(ROOT, 'api'))).sort((a, b) => a.dynamic - b.dynamic);
const handlers = new Map();

async function handlerFor(route) {
  if (!handlers.has(route.file)) {
    handlers.set(route.file, import(pathToFileURL(route.file).href).then(m => m.default));
  }
  return handlers.get(route.file);
}

function match(pathname) {
  for (const route of routes) {
    const m = route.re.exec(pathname);
    if (!m) continue;
    const params = {};
    route.params.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { route, params };
  }
  return null;
}

/* ------------------------------------------------ Vercel-Hilfen --- */

function decorate(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = body => {
    if (body === undefined || body === null) { res.end(); return res; }
    if (Buffer.isBuffer(body) || typeof body === 'string') { res.end(body); return res; }
    return res.json(body);
  };
  return res;
}

class BodyError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function parseBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const parsed = type === 'application/json' || type.startsWith('text/') ||
    type === 'application/x-www-form-urlencoded' || type === 'application/octet-stream';
  if (!parsed || req.method === 'GET' || req.method === 'HEAD') return undefined;

  const max = type === 'application/octet-stream' ? MAX_BINARY_BODY : MAX_TEXT_BODY;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new BodyError(413, 'body_too_large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (type === 'application/octet-stream') return raw;
  const text = raw.toString('utf8');
  if (type === 'application/json') {
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new BodyError(400, 'invalid_json'); }
  }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  return text;
}

async function runApi(req, res, url) {
  const found = match(url.pathname);
  if (!found) return res.status(404).json({ error: 'not_found' });

  req.query = { ...Object.fromEntries(url.searchParams), ...found.params };
  try {
    req.body = await parseBody(req);
  } catch (e) {
    if (e instanceof BodyError) return res.status(e.status).json({ error: e.code });
    throw e;
  }

  const handler = await handlerFor(found.route);
  await handler(req, res);
}

/* ------------------------------------------- Seite (nur lokal) --- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon'
};
// Dieselben Ausnahmen wie im Caddyfile: was nicht zur Seite gehört, bleibt zu.
const HIDDEN = /^\/(\.|node_modules|deploy|scripts|api|server\.mjs|package)/;

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (HIDDEN.test(rel) || !file.startsWith(ROOT + path.sep)) return res.status(404).send('not found');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('dir');
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(file).pipe(res);
  } catch {
    res.status(404).send('not found');
  }
}

/* ----------------------------------------------------------- Start --- */

const server = http.createServer(async (req, res) => {
  decorate(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await runApi(req, res, url);
    else if (DEV) await serveStatic(req, res, url);
    else res.status(404).json({ error: 'not_found' });
  } catch (e) {
    console.error(`[${req.method} ${url.pathname}]`, e);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
    else res.end();
  }
});

// Videos brauchen am Berg mit schlechtem Netz ihre Zeit: das Hochladen eines
// ganzen Rumpfs darf bis zu einer halben Stunde dauern.
server.requestTimeout = 30 * 60 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`Pässeranking auf http://${HOST}:${PORT} (${routes.length} Routen${DEV ? ', mit Seite' : ''})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
