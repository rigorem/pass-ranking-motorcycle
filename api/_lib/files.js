// Fotos, Videos und Kartenbilder als Dateien auf dem Server.
//
// Abgelegt wird unter DATA_DIR/blobs/<pfad>, mit genau den Pfaden, die schon
// in Redis stehen (photos/…, videos/…, maps/…) – so gelten die Verweise aus
// der Zeit mit Vercel Blob nach dem Umzug unverändert weiter.
//
// Nichts davon ist von außen erreichbar: Caddy liefert nur die Seite selbst
// aus, Dateien gehen immer über /api/photos bzw. /api/map, und die prüfen
// vorher die Sitzung.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, readFile as read, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(process.env.DATA_DIR || '.data', 'blobs');

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'
};

export const typeOf = pathname => TYPES[path.extname(pathname).slice(1).toLowerCase()] || 'application/octet-stream';

// Pfad aus Redis -> Datei. Alles, was aus dem Ablageordner hinausführen
// würde, gilt als nicht vorhanden.
function fileFor(pathname) {
  const p = String(pathname || '');
  if (!p || p.includes('\0')) return null;
  const file = path.resolve(ROOT, p);
  return file.startsWith(ROOT + path.sep) ? file : null;
}

// Wie addRandomSuffix bei Vercel Blob: derselbe Name zweimal ergibt zwei Dateien.
function withSuffix(pathname) {
  const ext = path.extname(pathname);
  return `${pathname.slice(0, pathname.length - ext.length)}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// Erst in eine Zwischendatei, dann umbenennen: ein Absturz mittendrin
// hinterlässt nie eine halbe Datei unter dem richtigen Namen.
async function place(pathname, write) {
  const file = fileFor(pathname);
  if (!file) throw new Error('bad_pathname');
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  try {
    await write(tmp);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return pathname;
}

export async function putFile(pathname, data, { addRandomSuffix = false } = {}) {
  const name = addRandomSuffix ? withSuffix(pathname) : pathname;
  await place(name, tmp => writeFile(tmp, data));
  return { pathname: name };
}

export class TooLarge extends Error {}

// Für Videos: der Rumpf wird direkt auf die Platte geschrieben, nie ganz in
// den Speicher geholt. Über maxBytes wird abgebrochen.
export async function putStream(pathname, source, { maxBytes = Infinity, addRandomSuffix = false } = {}) {
  const name = addRandomSuffix ? withSuffix(pathname) : pathname;
  let size = 0;
  const limit = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      done(size > maxBytes ? new TooLarge('too_large') : null, chunk);
    }
  });
  await place(name, tmp => pipeline(source, limit, createWriteStream(tmp)));
  return { pathname: name, size };
}

export async function readFile(pathname) {
  const file = fileFor(pathname);
  if (!file) return null;
  try { return await read(file); } catch { return null; }
}

export async function deleteFile(pathname) {
  const file = fileFor(pathname);
  if (file) await rm(file, { force: true });
}

// Datei ausliefern, mit Range-Anfragen: Safari auf dem iPhone spielt Videos
// nur ab, wenn der Server Teilstücke liefern kann. Ergibt false, wenn es die
// Datei nicht gibt – der Aufrufer entscheidet dann, was passiert.
export async function sendFile(req, res, pathname, { cacheControl } = {}) {
  const file = fileFor(pathname);
  if (!file) return false;
  let info;
  try { info = await stat(file); } catch { return false; }
  if (!info.isFile()) return false;

  const size = info.size;
  res.setHeader('Content-Type', typeOf(pathname));
  res.setHeader('Accept-Ranges', 'bytes');
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);

  let start = 0, end = size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));   // "bytes=-500": die letzten 500
    }
    if (start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      res.statusCode = 416;
      res.end();
      return true;
    }
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  res.setHeader('Content-Length', String(end - start + 1));
  res.statusCode = status;
  if (req.method === 'HEAD' || size === 0) { res.end(); return true; }
  try {
    await pipeline(createReadStream(file, { start, end }), res);
  } catch { /* Verbindung abgebrochen – beim Scrubben im Video völlig normal */ }
  return true;
}
