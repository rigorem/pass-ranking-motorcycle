// Bündelt den Browser-Client von @vercel/blob nach vendor/blob-client.js.
//
//   node scripts/vendor-blob-client.mjs
//
// Warum gebündelt und nicht einfach kopiert: die Datei im Paket zieht ein
// halbes Dutzend weiterer Pakete nach sich. Das Ergebnis wird mitversioniert,
// damit auf Vercel kein Build-Schritt nötig ist und der Browser nichts von
// einem fremden CDN nachladen muss.
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, '.blob-entry.js');
const out = join(root, 'vendor', 'blob-client.js');

await mkdir(join(root, 'vendor'), { recursive: true });
await writeFile(entry, "export { upload } from '@vercel/blob/client';\n");
try {
  execFileSync('npx', ['--yes', 'esbuild@0.24.0', entry, '--bundle', '--format=esm',
    '--platform=browser', '--target=es2020', '--minify', `--outfile=${out}`],
    { cwd: root, stdio: 'inherit' });
} finally {
  await rm(entry, { force: true });
}

const head = `/* Gebündelte Browser-Fassung von @vercel/blob/client (nur \`upload\`).
 * Erzeugt mit: node scripts/vendor-blob-client.mjs
 * Nicht von Hand bearbeiten. Enthalten ist nur, was der Browser braucht, um
 * ein Video mit einem befristeten Schlüssel direkt in den Blob-Store zu laden –
 * der eigentliche BLOB_READ_WRITE_TOKEN bleibt auf dem Server.
 */
`;
await writeFile(out, head + await readFile(out, 'utf8'));
console.log('vendor/blob-client.js neu gebündelt');
