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
  import.js            POST – Foto vom Handy, ordnet nach Koordinaten zu
  inbox.js             GET/POST – Fotos ohne sichere Zuordnung
  _lib/photos.js       Ablegen im Blob, gemeinsam für Upload und Import
  _lib/inbox.js        Der Eingang
  map/[id].js          GET  – Kartenbild mit Streckenverlauf
  _lib/route.js        Straßenverlauf über den Pass aus OpenStreetMap
  _lib/tilemap.js      Setzt Kacheln zusammen und zeichnet die Strecke darauf
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

Kein Build-Schritt, kein Framework, keine externen Ressourcen im Browser –
die Oberfläche nutzt die Systemschrift des Geräts.

## Speicher

- **Upstash Redis** hält die Pässe, einen Hash pro Pass (`pass:<id>`), dazu ein
  Set `passes:ids`. Bewertungen werden feldweise geschrieben, zwei Leute können
  also gleichzeitig unterwegs sein, ohne sich gegenseitig zu überschreiben.
- **Vercel Blob** (privater Store) hält die Fotos. In Redis steht unter
  `photo:<id>` nur der Pfad im Store; ausgeliefert werden die Bilder von
  `/api/photos/<id>`, das sie mit dem Store-Token holt und durchreicht.

## Passwortschutz und Gastansicht

Zwei Passwörter, zwei Rollen:

| Variable | Rolle | darf |
| --- | --- | --- |
| `APP_PASSWORD` | `edit` | alles: bewerten, Notizen, Fotos, Pässe anlegen und löschen |
| `GUEST_PASSWORD` | `guest` | alles ansehen, nichts ändern |

Beide laufen über dasselbe Eingabefeld; welches Passwort kam, entscheidet der
Server. Stimmt es, setzt `/api/auth` ein Cookie (HttpOnly, Secure,
SameSite=Lax, 30 Tage), in dem die Rolle **mitsigniert** ist – aus `guest.…`
ein `edit.…` zu machen, macht die Signatur ungültig.

Jede Route unter `/api` prüft das Cookie, **auch das Ausliefern der Fotos** –
ohne Anmeldung gibt `/api/photos/<id>` eine 401 zurück. Alles, was etwas
verändert, prüft zusätzlich die Rolle und antwortet Gästen mit 403. Die
Gastansicht blendet Bewertungsbalken, Notizfelder, Fotoupload und die
Bearbeiten-Knöpfe aus, aber verlassen kann man sich allein auf `guardWrite`
in `api/_lib/auth.js`. Nach zehn Fehlversuchen ist eine IP 15 Minuten gesperrt.

Bleibt `GUEST_PASSWORD` leer, gibt es schlicht keine Gastansicht.

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
   - `APP_PASSWORD` – das Passwort zum Bearbeiten
   - `GUEST_PASSWORD` – das Passwort für die Gastansicht (nur lesen)
   - `MAPTILER_KEY` – für die Kartenbilder, kostenloser Schlüssel von
     [maptiler.com](https://www.maptiler.com/); ohne ihn bleiben die Kacheln
     leer. Das freie Kontingent genügt: gebraucht werden nur Rasterkacheln,
     nicht die kostenpflichtige Static-Maps-API
   - optional `SESSION_SECRET` (`openssl rand -hex 32`)
   - `UPLOAD_TOKEN` – für den Foto-Import vom Handy (`openssl rand -hex 32`)
   - optional `MAPTILER_STYLE`, voreingestellt `streets-v4`
   - optional `MATCH_RADIUS_M`, voreingestellt `3000`

   Der Schlüssel wird nur auf dem Server benutzt und erreicht den Browser nie.
   In den Schlüsseleinstellungen bei MapTiler bleiben die **Allowed HTTP
   origins deshalb am besten leer**: eine Herkunftssperre schützt hier nichts.
   Die App fragt jede Kachel einmal mit und einmal ohne Referer an, falls doch
   eine gesetzt ist.
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

Jede Passkarte hat links neben dem Namen eine Kachel mit dem Streckenverlauf:
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

Das Bild wird selbst gebaut: `api/_lib/tilemap.js` holt die Rasterkacheln von
MapTiler, setzt sie nebeneinander, legt den Straßenverlauf darüber und gibt
alles als SVG zurück, die Kacheln als Daten eingebettet. Die Static-Maps-API
von MapTiler wäre der bequemere Weg, gehört dort aber zu den kostenpflichtigen
Diensten – Kacheln sind im freien Kontingent enthalten. Nebenbei bleibt der
Schlüssel so auf dem Server.

Ausschnitt und Zoomstufe ergeben sich aus der Strecke: gewählt wird die
größte Stufe, auf der die ganze Passstraße noch ins Bild passt. Kennt die App
den Verlauf nicht, zeigt sie den Pass auf Stufe 12 mit Markierung.

Straßenverlauf und fertiges Bild werden pro Pass einmal geholt und landen dann
im privaten Blob-Store, ausgeliefert wie die Fotos über eine Route mit
Passwortprüfung. Danach kostet ein Aufruf nichts mehr bei fremden Diensten.
Die Kachel wiegt rund 80 KB, die große Ansicht rund 260 KB.

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

## Fotos hochladen, Zuordnung automatisch

Es gibt zwei Wege, beide enden im selben `POST /api/import`: der Server liest
die Koordinaten, sucht den nächstgelegenen Pass und hängt das Foto dort an.
Innerhalb von `MATCH_RADIUS_M` (Vorgabe 3000 m) wird zugeordnet, alles andere
landet im Eingang.

### Aus der App heraus

**„+ Fotos hochladen, Zuordnung automatisch"** unter der Liste: beliebig viele
Fotos auswählen, den Rest macht die Seite. `exif.js` liest Ort und Aufnahmezeit
**aus der ausgewählten Datei**, bevor `shrink()` sie durchs Canvas schickt –
danach wären die Metadaten weg. Ein Fortschrittsfenster zeigt für jedes Foto,
wo es gelandet ist, und am Ende, wie viele überhaupt einen Ort dabei hatten.

Die Zahl ist auch die Antwort auf die Frage, ob das eigene Gerät den Ort
überhaupt mitgibt: kommt dort `0 von 12` heraus, liefert der Browser die
Metadaten nicht aus, und der Weg über den Kurzbefehl ist der richtige.

`exif.js` ist ein kleiner Parser ohne Abhängigkeit: JPEG-APP1 suchen,
TIFF-Kopf lesen, im GPS-Verzeichnis Breite und Länge als Grad/Minuten/Sekunden
einsammeln, im Exif-Verzeichnis `DateTimeOriginal`. Alles andere wird
ignoriert. Findet er nichts, wird trotzdem hochgeladen – das Foto geht dann in
den Eingang.

Das **„+ Fotos" am einzelnen Pass** bleibt, wie es war: dort ist der Pass ja
schon gewählt, ein Ort wird nicht gebraucht.

### Vom Handy per Kurzbefehl

Warum nicht über das geteilte iCloud-Album: **Apple rechnet Bilder beim Anlegen
eines geteilten Albums neu und wirft EXIF weg.** Die Schnittstelle kennt nur
`photoGuid`, `caption`, `dateCreated` und Ableitungen – keine Koordinaten. Die
Ortsangabe fehlt nicht in der API, sie fehlt in den Dateien. Die Originale in
der Mediathek haben sie noch, deshalb führt der Weg am Album vorbei.

Wenn der Browser die Metadaten nicht durchreicht, liest ein Kurzbefehl sie
direkt aus dem Original.

| # | Aktion | Einstellung |
| --- | --- | --- |
| 1 | Bei Ausführung erhalten | Bilder, aus dem Teilen-Menü |
| 2 | Wiederhole mit jedem | über die erhaltenen Bilder |
| 3 | Bilddetails abrufen | **Metadaten-Wörterbuch** |
| 4 | Wörterbuchwert abrufen | `{GPS}` → `Latitude`, dann `Longitude` |
| 5 | Wörterbuchwert abrufen | `{Exif}` → `DateTimeOriginal` |
| 6 | Bild konvertieren | nach JPEG |
| 7 | Bildgröße ändern | längste Kante 1800 px |
| 8 | Inhalte von URL abrufen | siehe unten |

**Die Schritte 3–5 müssen vor dem Konvertieren und Verkleinern laufen.** Danach
sind die Metadaten weg – derselbe Effekt, der das geteilte Album unbrauchbar
macht.

```
POST https://<deine-domain>/api/import
  Authorization: Bearer <UPLOAD_TOKEN>
  Content-Type:  image/jpeg
  X-Photo-Lat:   <Latitude>
  X-Photo-Lon:   <Longitude>
  X-Photo-Taken: <DateTimeOriginal>
  Body: die verkleinerte Datei
```

Die Koordinaten stehen in Kopfzeilen, nicht in der Adresse – Query-Strings
landen in Logs, Standortdaten haben dort nichts zu suchen. `Latitude` kommt aus
dem Metadaten-Wörterbuch und nicht aus der `Ort`-Eigenschaft: `Ort` liefert eine
Postadresse, keine Koordinaten.

Die Antwort ist kurz genug für eine Benachrichtigung am Handy:

```json
{ "id": "…", "passId": "pordoijoch", "passName": "Pordoijoch", "distanceM": 167 }
```

Dasselbe Foto zweimal zu schicken ist harmlos: über einen SHA-256 der Bytes
(`photohash:<sha>`) wird die vorhandene Id zurückgegeben, kein zweites Blob.

Ohne iPhone lässt sich der Weg genauso prüfen:

```sh
curl -X POST https://<deine-domain>/api/import \
  -H "Authorization: Bearer $UPLOAD_TOKEN" -H 'Content-Type: image/jpeg' \
  -H 'X-Photo-Lat: 46.4876' -H 'X-Photo-Lon: 11.8122' \
  --data-binary @foto.jpg
```

### Doppelte Fotos

Dasselbe Bild ein zweites Mal hochzuladen legt kein zweites Blob mehr an: über
einen SHA-256 der Bytes (`photohash:<sha>` und zurück `photosha:<id>`) gibt der
Server die vorhandene Id aus. Das gilt für beide Wege, Browser wie Import.

Für das, was sich vorher schon angesammelt hat, gibt es unten auf der Seite
**„Doppelte Fotos suchen"**. Der Aufruf vergleicht Bytes, nicht Dateinamen,
zeigt erst nur an, was er fände, und entfernt erst nach Rückfrage. Von jeder
Gruppe bleibt eines stehen.

Bewusst zurückhaltend: entfernt wird nur, was **innerhalb desselben Passes**
doppelt hängt. Dieselbe Aufnahme an zwei verschiedenen Pässen kann Absicht
sein, wird deshalb nur gemeldet und bleibt unangetastet. Fotos ohne
gespeicherten Fingerabdruck werden einmalig nachgerechnet; reicht die Laufzeit
nicht, sagt die Antwort, wie viele offen blieben – dann einfach nochmal.

### Der Eingang

Was ohne Ortsangabe ankommt oder zu weit von allen Pässen entfernt liegt,
sammelt sich über der Rangliste – mit Aufnahmezeit und dem nächstgelegenen Pass
samt Entfernung als Vorschlag. Ein Griff ordnet zu oder verwirft. Ist er leer,
ist der ganze Bereich unsichtbar. Gäste sehen ihn nie und bekommen auf
`/api/inbox` eine 403.

`appendPhotos` in `api/_lib/store.js` hängt Fotos mit einer kurzen Sperre an
und führt die Listen über ein Set zusammen. Zwei Telefone, die gleichzeitig zum
selben Pass laden, verlieren dadurch nichts, und ein wiederholter Import trägt
nichts doppelt ein.

## Fotos ansehen

Ein Tipp auf ein Foto öffnet es groß. Von dort lässt sich durch alle Fotos des
Passes blättern: am Handy durch Wischen, am Rechner mit den Pfeiltasten oder
den Schaltflächen links und rechts. Ein Zähler zeigt, wo man ist. Wischen wird
nur als solches gewertet, wenn es waagerecht und weit genug geht – sonst wäre
jedes Antippen ein Blättern.

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
