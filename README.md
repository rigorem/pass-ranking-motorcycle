# Pässeranking

Bewertung von Motorradpässen in den Dolomiten und Südtirol nach **Fahrspaß** und
**Ambiente**, mit Notizen und Fotos. Passwortgeschützt, läuft auf Vercel.

Ursprünglich ein Claude Artifact, inzwischen eine eigenständige App ohne
Bindung an Claude.

## Aufbau

```
index.html             Markup
styles.css             Gestaltung, hell und dunkel
app.js                 Frontend – spricht nur mit /api
api/
  session.js           GET  – bin ich angemeldet?
  auth.js              POST – anmelden, DELETE – abmelden
  version.js           GET  – Änderungszähler für den Live-Abgleich
  place.js             GET  – Koordinate -> Gegend (Nominatim, gecacht)
  map/[id].js          GET  – Kartenbild mit Streckenverlauf
  _lib/route.js        Straßenverlauf über den Pass aus OpenStreetMap
  passes/index.js      GET  – alle Pässe, POST – neuer Pass
  passes/[id].js       PATCH – Felder ändern, DELETE – Pass samt Fotos
  photos/index.js      POST – Foto hochladen
  photos/[id].js       GET  – Foto ausliefern, DELETE – Foto löschen
  _lib/auth.js         Passwortprüfung und Session-Cookie
  _lib/store.js        Redis-Zugriff und Datenform
data/seed-passes.json  Die sieben Pässe für den ersten Start
data/passes-alps.json  1811 Alpenpässe für die Namensvorschläge
scripts/seed.mjs       Spielt die sieben Pässe in Redis ein
scripts/build-passes.mjs  Baut den Pässe-Katalog aus OpenStreetMap
scripts/backfill-coords.mjs  Trägt Koordinaten bei alten Pässen nach
```

Kein Build-Schritt, kein Framework. Die einzige externe Ressource im Browser
sind Barlow und Barlow Condensed von Google Fonts.

## Speicher

- **Upstash Redis** hält die Pässe, einen Hash pro Pass (`pass:<id>`), dazu ein
  Set `passes:ids`. Bewertungen werden feldweise geschrieben, zwei Leute können
  also gleichzeitig unterwegs sein, ohne sich gegenseitig zu überschreiben.
- **Vercel Blob** (privater Store) hält die Fotos. In Redis steht unter
  `photo:<id>` nur der Pfad im Store; ausgeliefert werden die Bilder von
  `/api/photos/<id>`, das sie mit dem Store-Token holt und durchreicht.

## Passwortschutz

Ein gemeinsames Passwort in `APP_PASSWORD`, geprüft auf dem Server. Stimmt es,
setzt `/api/auth` ein HMAC-signiertes Cookie (HttpOnly, Secure, SameSite=Lax,
30 Tage). Jede Route unter `/api` prüft dieses Cookie, **auch das Ausliefern der
Fotos** – ohne Anmeldung gibt `/api/photos/<id>` eine 401 zurück. Nach zehn
Fehlversuchen ist eine IP 15 Minuten gesperrt.

Die Passwortabfrage im Browser ist nur die Tür, nicht das Schloss: das Schloss
sitzt in `api/_lib/auth.js`. Wer die Seite ohne Anmeldung aufruft, bekommt vom
Server keine Daten und keine Bilder.

Der Blob-Store läuft auf **privatem** Zugriff. Die Bilder sind von außen also
auch mit der richtigen URL nicht abrufbar, sie lassen sich nur mit dem
Store-Token lesen – und das liegt allein auf dem Server. In Redis steht nur der
Pfad im Store, nie eine abrufbare Adresse.

Ohne `SESSION_SECRET` wird der Signaturschlüssel aus `APP_PASSWORD` abgeleitet.
Ein Passwortwechsel meldet dann alle ab, was meistens erwünscht ist.

## Einrichten auf Vercel

1. Repository in Vercel importieren. Framework: **Other**, kein Build-Command.
2. Im Projekt unter **Storage** anlegen:
   - **Upstash Redis** → setzt `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN`
   - **Blob** → setzt `BLOB_READ_WRITE_TOKEN`. Der Store muss auf **private**
     stehen; die App lädt Fotos ausdrücklich mit `access: 'private'` hoch.
3. Unter **Settings → Environment Variables** setzen:
   - `APP_PASSWORD` – das gemeinsame Passwort
   - `MAPTILER_KEY` – für die Kartenbilder, kostenloser Schlüssel von
     [maptiler.com](https://www.maptiler.com/); ohne ihn bleiben die Kacheln leer
   - optional `SESSION_SECRET` (`openssl rand -hex 32`)
   - optional `MAPTILER_STYLE`, voreingestellt `streets-v4`

   Der Schlüssel wird nur auf dem Server benutzt und erreicht den Browser nie.
   In den Schlüsseleinstellungen bei MapTiler bleiben die **Allowed HTTP
   origins deshalb am besten leer**: eine Herkunftssperre schützt hier nichts
   und lehnt Serveraufrufe ab. Wer sie trotzdem setzt, trägt die eigene
   Adresse ein, die App schickt sie als Referer mit.
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

## Pass anlegen mit Vorschlägen

Im Namensfeld genügen zwei Buchstaben, dann erscheinen passende Alpenpässe.
Ein Klick oder Enter füllt deutschen Namen, italienischen Namen, ladinischen
Namen und Höhe aus; die Gegend wird einmal über `/api/place` nachgeschlagen.
Alle Felder bleiben normal editierbar, und ein Pass, der nicht im Katalog
steht, lässt sich wie vorher von Hand eintragen.

`data/passes-alps.json` enthält 1811 Pässe aus OpenStreetMap – benannte
`mountain_pass=yes`-Knoten im Alpenbogen, die auf einer Straße liegen, also
ohne reine Wanderscharten. Die Datei wird beim Öffnen des Dialogs geladen
(rund 115 KB) und danach im Browser durchsucht, Tippen fragt also nichts nach.
Umlaute sind dabei egal: „groedner“ findet das Grödner Joch.

Neu bauen lässt sich der Katalog mit `node scripts/build-passes.mjs`
(fragt Overpass, dauert ein paar Minuten).

Die Gegend kommt aus Nominatim und wird in Redis gemerkt, jeder Punkt wird
also höchstens einmal erfragt – das hält die Nutzungsregeln von OSM ein und
ist beim zweiten Mal sofort da. Geraten wird nichts: antwortet der Dienst
nicht, bleibt das Feld leer.

Die ladinischen Namen stammen aus OSM und folgen nicht immer derselben
Mundart wie eure eigenen Einträge (OSM schreibt „Ju de Frara“, ihr
„Jëuf de Frea“) – beides ist richtig, das Feld bleibt ja änderbar.

## Karte und Streckenverlauf

Jede Passkarte hat links neben dem Schild eine Kachel mit dem Streckenverlauf:
die Passstraße mit ihren Kehren, über eine Karte gelegt. Eigene Fotos stehen
weiter unten im Streifen – beim Scrollen hilft die Form der Straße beim
Wiedererkennen mehr als ein Ausschnitt Himmel. Ein Tipp auf die Kachel öffnet
dieselbe Karte größer, dazu einen Knopf in die Karten-App.

Unter der Region steht, was die Straße ausmacht, aus dem Verlauf gerechnet:
Straßennummer, Länge, Kurven, Kehren und Kurven pro Kilometer – beim Stilfser
Joch etwa `SS38 · 16,9 km · 62 Kurven · 46 Kehren · 3,7 Kurven/km`. Als Kurve
zählt eine zusammenhängende Richtungsänderung ab 35°, als Kehre eine ab 120°.
Die Zahlen erscheinen, sobald das Kartenbild einmal gebaut wurde, und stehen
danach am Pass.

Das Kartenbild kommt von MapTiler, der Straßenverlauf aus OpenStreetMap.
Beides wird pro Pass genau einmal geholt und landet dann im privaten
Blob-Store, ausgeliefert wie die Fotos über eine Route mit Passwortprüfung.
Ein Pass kostet also einmalig zwei Bilder und eine Overpass-Abfrage, danach
nichts mehr.

`api/_lib/route.js` sucht die Straße, auf der der Pass liegt, und läuft von
dort acht Kilometer in beide Richtungen weiter. An Kreuzungen wird die Straße
mit derselben Nummer bevorzugt, damit die Linie nicht in ein Seitental
abbiegt. Anschließend wird die Linie vereinfacht – in Metern gerechnet, nicht
in Grad, sonst fielen genau die engen Kehren weg.

Damit die Kacheln erscheinen, braucht es `MAPTILER_KEY` in den Environment
Variables. Fehlt der Schlüssel, bleibt die Kachel leer und alles andere
funktioniert weiter. Antwortet Overpass gerade nicht, zeigt die Karte den Pass
ohne eingezeichnete Straße, und das Bild wird nicht gespeichert – beim
nächsten Aufruf wird es erneut versucht.

Pässe, die vor dieser Änderung angelegt wurden, haben noch keine Koordinaten:

```sh
node --env-file=.env.local scripts/backfill-coords.mjs          # zeigt an
node --env-file=.env.local scripts/backfill-coords.mjs --write  # schreibt
```

## Gemeinsam bewerten

Jede Änderung zählt serverseitig `passes:rev` hoch. Die Browser fragen nur
diese Zahl ab (`/api/version`) und holen die Liste erst, wenn sie sich bewegt
hat. Wer gerade mitbewertet, sieht die Bewertung des anderen also nach
spätestens drei Sekunden, und der geänderte Pass leuchtet kurz auf.

Der Takt passt sich an: drei Sekunden, solange etwas passiert, danach
15 Sekunden und nach zehn Minuten Ruhe eine Minute. Ein Tab im Hintergrund
fragt gar nicht, meldet sich aber sofort, wenn er wieder nach vorn kommt.
Während ein Dialog offen ist, jemand eine Notiz tippt oder eigene Änderungen
noch unterwegs sind, wird nicht abgeglichen – sonst überschreibt der Server,
was gerade erst lokal passiert ist.

## Bewertung und Sortierung

Beide Achsen gehen von 1 bis 10. Ein erneuter Klick auf den aktuellen Wert setzt
ihn zurück auf „nicht bewertet“. Die Gesamtwertung ist der Mittelwert der
vorhandenen Werte – ein Pass mit nur einer Bewertung zählt mit dieser.
Unbewertete Pässe stehen am Ende und bekommen statt eines Platzes ein „–“,
sortiert nach `order`. Gleiche Werte teilen sich einen Platz.

Bewertungen erscheinen sofort und werden im Hintergrund gespeichert;
schlägt das fehl, springt der Balken zurück und eine Meldung sagt warum.
