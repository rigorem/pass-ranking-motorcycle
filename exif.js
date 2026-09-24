// EXIF aus einer Bilddatei lesen – Ort und Aufnahmezeit, mehr braucht die App
// nicht. Bewusst ohne Bibliothek: es geht um zwei Handvoll Bytes an bekannten
// Stellen, und ein Paket dafür wäre größer als der Parser.
//
// Wichtig: das muss auf der *ausgewählten Datei* laufen. Sobald ein Bild durch
// ein Canvas gegangen ist, sind die Metadaten weg – genau daran scheitert der
// Umweg über das geteilte Album.

const EXIF_IFD = 0x8769;
const GPS_IFD = 0x8825;
const DATE_TAKEN = 0x9003;
const GPS_LAT_REF = 0x0001, GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003, GPS_LON = 0x0004;

// Nur der Anfang der Datei ist interessant; APP1 steht direkt hinter SOI.
const HEAD_BYTES = 256 * 1024;

function findApp1(view) {
  if (view.getUint16(0) !== 0xFFD8) return -1;        // kein JPEG
  let off = 2;
  while (off + 4 < view.byteLength) {
    if (view.getUint8(off) !== 0xFF) return -1;       // aus dem Tritt geraten
    const marker = view.getUint16(off);
    const size = view.getUint16(off + 2);
    if (marker === 0xFFE1) {
      // "Exif\0\0" muss folgen, sonst ist es ein anderes APP1 (etwa XMP).
      if (view.getUint32(off + 4) === 0x45786966) return off + 10;
      return -1;
    }
    if (marker === 0xFFDA) return -1;                 // Bilddaten beginnen
    off += 2 + size;
  }
  return -1;
}

function rational(view, at, little) {
  const n = view.getUint32(at, little);
  const d = view.getUint32(at + 4, little);
  return d ? n / d : 0;
}

// Grad, Minuten, Sekunden -> Dezimalgrad.
function degrees(view, at, little) {
  return rational(view, at, little)
    + rational(view, at + 8, little) / 60
    + rational(view, at + 16, little) / 3600;
}

function ascii(view, at, count) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(at + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

// Ein Verzeichnis durchgehen und die Einträge als Map liefern.
function readIfd(view, tiff, at, little) {
  const out = new Map();
  if (at + 2 > view.byteLength) return out;
  const count = view.getUint16(at, little);
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const num = view.getUint32(entry + 4, little);
    // Werte bis vier Byte stehen direkt im Eintrag, längere dahinter.
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
    const total = size * num;
    const at2 = total <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, little);
    out.set(tag, { type, num, at: at2 });
  }
  return out;
}

function pointer(view, ifd, tag, little) {
  const e = ifd.get(tag);
  return e ? view.getUint32(e.at, little) : 0;
}

/**
 * @returns {{lat: number|null, lon: number|null, taken: string}}
 */
export async function readExif(file) {
  const empty = { lat: null, lon: null, taken: '' };
  try {
    const buf = await file.slice(0, HEAD_BYTES).arrayBuffer();
    const view = new DataView(buf);

    const tiff = findApp1(view);
    if (tiff < 0) return empty;

    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4D4D) return empty;
    const little = order === 0x4949;

    const ifd0 = readIfd(view, tiff, tiff + view.getUint32(tiff + 4, little), little);

    let taken = '';
    const exifAt = pointer(view, ifd0, EXIF_IFD, little);
    if (exifAt) {
      const exif = readIfd(view, tiff, tiff + exifAt, little);
      const d = exif.get(DATE_TAKEN);
      if (d && d.type === 2) taken = ascii(view, d.at, d.num);
    }

    let lat = null, lon = null;
    const gpsAt = pointer(view, ifd0, GPS_IFD, little);
    if (gpsAt) {
      const gps = readIfd(view, tiff, tiff + gpsAt, little);
      const latE = gps.get(GPS_LAT), lonE = gps.get(GPS_LON);
      const latRef = gps.get(GPS_LAT_REF), lonRef = gps.get(GPS_LON_REF);
      if (latE && latE.num === 3 && lonE && lonE.num === 3) {
        lat = degrees(view, latE.at, little);
        lon = degrees(view, lonE.at, little);
        if (latRef && ascii(view, latRef.at, 2).toUpperCase() === 'S') lat = -lat;
        if (lonRef && ascii(view, lonRef.at, 2).toUpperCase() === 'W') lon = -lon;
        // 0/0 heißt in der Praxis „nicht gesetzt", nicht „Atlantik".
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
          lat = lon = null;
        }
      }
    }

    return { lat, lon, taken };
  } catch {
    return empty;                                      // lieber ohne Ort als gar nicht
  }
}
