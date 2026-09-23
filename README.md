# Pässeranking

Bewertung von Motorradpässen in den Dolomiten und Südtirol nach **Fahrspaß** und
**Ambiente**, mit Notizen und Fotos. Passwortgeschützt, läuft auf Vercel.

Ursprünglich ein Claude Artifact, inzwischen eine eigenständige App ohne
Bindung an Claude.

## Aufbau

```
index.html            Markup
styles.css            Gestaltung, hell und dunkel
app.js                Frontend – spricht nur mit /api
api/
  session.js          GET  – bin ich angemeldet?
  auth.js             POST – anmelden, DELETE – abmelden
  passes/index.js     GET  – alle Pässe, POST – neuer Pass
  passes/[id].js      PATCH – Felder ändern, DELETE – Pass samt Fotos
  photos/index.js     POST – Foto hochladen
  photos/[id].js      GET  – Foto ausliefern, DELETE – Foto löschen
  _lib/auth.js        Passwortprüfung und Session-Cookie
  _lib/store.js       Redis-Zugriff und Datenform
data/seed-passes.json Die sieben Pässe für den ersten Start
scripts/seed.mjs      Spielt sie in Redis ein
```

Kein Build-Schritt, kein Framework. Die einzige externe Ressource im Browser
sind Barlow und Barlow Condensed von Google Fonts.

## Speicher

- **Upstash Redis** hält die Pässe, einen Hash pro Pass (`pass:<id>`), dazu ein
  Set `passes:ids`. Bewertungen werden feldweise geschrieben, zwei Leute können
  also gleichzeitig unterwegs sein, ohne sich gegenseitig zu überschreiben.
- **Vercel Blob** hält die Fotos. Die Blob-URL steht nur in Redis
  (`photo:<id>`) und wird nie an den Browser gegeben.

## Passwortschutz

Ein gemeinsames Passwort in `APP_PASSWORD`, geprüft auf dem Server. Stimmt es,
setzt `/api/auth` ein HMAC-signiertes Cookie (HttpOnly, Secure, SameSite=Lax,
30 Tage). Jede Route unter `/api` prüft dieses Cookie, **auch das Ausliefern der
Fotos** – ohne Anmeldung gibt `/api/photos/<id>` eine 401 zurück. Nach zehn
Fehlversuchen ist eine IP 15 Minuten gesperrt.

Die Passwortabfrage im Browser ist nur die Tür, nicht das Schloss: das Schloss
sitzt in `api/_lib/auth.js`. Wer die Seite ohne Anmeldung aufruft, bekommt vom
Server keine Daten und keine Bilder.

Ein bewusster Rest: die Fotos liegen in einem öffentlichen Blob-Store unter
unerratbaren URLs (Zufalls-Suffix). Diese URLs verlassen den Server nicht, wer
eine aber kennt, käme daran vorbei. Für Urlaubsfotos ist das in Ordnung – für
etwas Heikleres müsste der Blob-Store auf privaten Zugriff umgestellt werden.

Ohne `SESSION_SECRET` wird der Signaturschlüssel aus `APP_PASSWORD` abgeleitet.
Ein Passwortwechsel meldet dann alle ab, was meistens erwünscht ist.

## Einrichten auf Vercel

1. Repository in Vercel importieren. Framework: **Other**, kein Build-Command.
2. Im Projekt unter **Storage** anlegen:
   - **Upstash Redis** → setzt `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN`
   - **Blob** → setzt `BLOB_READ_WRITE_TOKEN`
3. Unter **Settings → Environment Variables** `APP_PASSWORD` setzen.
   Optional `SESSION_SECRET` (`openssl rand -hex 32`).
4. Deployen.
5. Pässe einspielen:
   ```sh
   vercel env pull .env.local
   node --env-file=.env.local scripts/seed.mjs
   ```
   Der Lauf überspringt bereits vorhandene Pässe; `-- --force` überschreibt sie
   (und wirft dabei Bewertungen weg).

## Lokal entwickeln

```sh
npm install
vercel env pull .env.local     # holt Redis- und Blob-Zugang aus dem Projekt
vercel dev
```

`vercel dev` liest `.env.local` selbst ein. Ohne Vercel-CLI lässt sich am
Layout auch mit einem beliebigen statischen Server arbeiten – dann antwortet
`/api` nicht, und die Seite bleibt hinter der Passwortabfrage stehen.

## Bewertung und Sortierung

Beide Achsen gehen von 1 bis 10. Ein erneuter Klick auf den aktuellen Wert setzt
ihn zurück auf „nicht bewertet“. Die Gesamtwertung ist der Mittelwert der
vorhandenen Werte – ein Pass mit nur einer Bewertung zählt mit dieser.
Unbewertete Pässe stehen am Ende und bekommen statt eines Platzes ein „–“,
sortiert nach `order`. Gleiche Werte teilen sich einen Platz.

Bewertungen erscheinen sofort und werden im Hintergrund gespeichert;
schlägt das fehl, springt der Balken zurück und eine Meldung sagt warum.
Die Liste lädt beim Zurückkehren auf den Tab neu und sonst alle 45 Sekunden.
