# Pässeranking

Bewertung von Motorradpässen in den Dolomiten und Südtirol nach **Fahrspaß** und
**Ambiente**, mit Notizen, Fotos und Videos. Passwortgeschützt, läuft auf einem
eigenen Server bei Hetzner.

Ursprünglich ein Claude Artifact, inzwischen eine eigenständige App ohne
Bindung an Claude.

## Aufbau

```
index.html             Markup
styles.css             Gestaltung, hell und dunkel
app.js                 Frontend – spricht nur mit /api
server.mjs             Node-Server: findet die Routen unter api/ und führt sie aus
api/
  session.js           GET  – bin ich angemeldet? (?poll=1: Änderungszähler)
  auth.js              POST – anmelden, DELETE – abmelden
  place.js             GET  – Koordinate -> Gegend (Nominatim, gecacht)
  import.js            POST – Foto vom Handy, ordnet nach Koordinaten zu
  videos.js            POST – Video hochladen, direkt auf die Platte
  inbox.js             GET/POST – Fotos ohne sichere Zuordnung
  _lib/photos.js       Fotos ablegen, gemeinsam für Upload und Import
  _lib/files.js        Dateien auf der Platte, Ausliefern mit Range
  _lib/inbox.js        Der Eingang
  map/[id].js          GET  – Kartenbild mit Streckenverlauf
  _lib/route.js        Straßenverlauf über den Pass aus OpenStreetMap
  _lib/tilemap.js      Setzt Kacheln zusammen und zeichnet die Strecke darauf
  passes/index.js      GET  – alle Pässe, POST – neuer Pass
  passes/[id].js       PATCH – Felder ändern, DELETE – Pass samt Fotos
  photos/index.js      POST – Foto hochladen
  photos/[id].js       GET  – Foto ausliefern, DELETE – Foto löschen
  _lib/auth.js         Passwortprüfung und Session-Cookie
  _lib/store.js        Datenform der Pässe
  _lib/redis.js        Redis-Zugang (lokal, verhält sich wie @upstash/redis)
data/seed-passes.json  Die sieben Pässe für den ersten Start
data/passes-alps.json  1811 Alpenpässe für die Namensvorschläge
scripts/seed.mjs       Spielt die sieben Pässe in Redis ein
scripts/build-passes.mjs  Baut den Pässe-Katalog aus OpenStreetMap
scripts/backfill-coords.mjs  Trägt Koordinaten bei alten Pässen nach
scripts/migrate-from-vercel.mjs  Einmalig: Daten aus Upstash und Vercel Blob holen
deploy/                Caddyfile, systemd-Dienst, Einrichtung und Ausrollen
.github/workflows/deploy.yml  Rollt jeden Push auf main aus
```

Kein Build-Schritt, kein Framework, keine externen Ressourcen im Browser –
die Oberfläche nutzt die Systemschrift des Geräts. Die einzige Abhängigkeit
auf dem Server ist der Redis-Client.

Die Routen unter `api/` stammen aus der Zeit auf Vercel und sind so
geblieben: `server.mjs` stellt ihnen dieselben Hilfen bereit (`req.query`,
einen gelesenen `req.body`, `res.status().json()`), und `api/_lib/redis.js`
verhält sich wie der Upstash-Client, für den sie geschrieben wurden.

## Speicher

- **Redis** auf demselben Server, nur über localhost erreichbar, mit
  Append-Only-Datei (jede Änderung ist nach spätestens einer Sekunde auf der
  Platte). Es hält die Pässe, einen Hash pro Pass (`pass:<id>`), dazu ein Set
  `passes:ids`. Bewertungen werden feldweise geschrieben, zwei Leute können
  also gleichzeitig unterwegs sein, ohne sich gegenseitig zu überschreiben.
- **Dateien** – Fotos, Videos, Kartenbilder – liegen unter
  `$DATA_DIR/blobs/` (`photos/…`, `videos/…`, `maps/…`). In Redis steht unter
  `photo:<id>` nur der Pfad; ausgeliefert wird über `/api/photos/<id>`.

Auf dem Server liegt `$DATA_DIR` auf einem Hetzner-Volume:
`/srv/passeranking/data`, darin `blobs/` und `redis/`.

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

Die Dateien liegen außerhalb dessen, was Caddy ausliefert: öffentlich sind
nur `index.html`, `styles.css`, `app.js`, `exif.js`, `img/` und der
Pässe-Katalog, alles andere antwortet mit 404. Fotos und Videos kommen
ausschließlich über `/api/photos/<id>`, und das prüft vorher die Sitzung.

Ohne `SESSION_SECRET` wird der Signaturschlüssel aus `APP_PASSWORD` abgeleitet.
Ein Passwortwechsel meldet dann alle ab, was meistens erwünscht ist.

## Betrieb auf Hetzner

```
Browser ──HTTPS──> Caddy ── Seite (index.html, app.js, styles.css, img/, Katalog)
                     └─ /api/* ──> Node (server.mjs, systemd) ──> Redis (localhost)
                                        └─ Dateien: /srv/passeranking/data/blobs
```

**Server:** Hetzner Cloud, kleinster x86-Tarif mit geteilten vCPUs (2 vCPU,
4 GB RAM), Ubuntu 24.04, Standort Nürnberg oder Falkenstein. Dazu ein
**Volume** mit 50–100 GB für Fotos und Videos – es lässt sich später
vergrößern, ohne den Server anzufassen. Bei der Bestellung die automatischen
Backups einschalten; das Volume sichern sie allerdings nicht mit (siehe unten).

### Einrichten

1. Server und Volume in der Hetzner Console anlegen, eigenen SSH-Schlüssel
   hinterlegen, Volume mit „automatisch einhängen“.
2. Schlüsselpaar nur für die GitHub Action erzeugen (lokal):
   `ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key`
3. Auf dem Server als root:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/rigorem/pass-ranking-motorcycle/main/deploy/setup-server.sh -o setup.sh
   bash setup.sh --deploy-key "$(cat deploy_key.pub)"     # Inhalt von deploy_key.pub einsetzen
   ```
   Das Skript installiert Node 22, Redis und Caddy, richtet Firewall
   (nur 22/80/443), automatische Sicherheitsupdates und den Dienst ein, holt
   den Code nach `/srv/passeranking/app` und nennt am Ende die Adresse.
   Ohne eigene Domain ist das `<ip-mit-strichen>.sslip.io` – ein freier Name,
   der auf die IP zeigt; das HTTPS-Zertifikat holt Caddy selbst.
4. Geheimnisse eintragen und neu starten:
   ```sh
   nano /etc/passeranking.env
   systemctl restart passeranking
   ```
   - `APP_PASSWORD` – das Passwort zum Bearbeiten
   - `GUEST_PASSWORD` – das Passwort für die Gastansicht (nur lesen)
   - `SESSION_SECRET` (`openssl rand -hex 32`) – denselben Wert wie bisher
     übernehmen, dann bleiben alle angemeldet
   - `UPLOAD_TOKEN` – für den Foto-Import vom Handy (`openssl rand -hex 32`)
   - `MAPTILER_KEY` – für die Kartenbilder, kostenloser Schlüssel von
     [maptiler.com](https://www.maptiler.com/); ohne ihn bleiben die Kacheln
     leer. Das freie Kontingent genügt: gebraucht werden nur Rasterkacheln,
     nicht die kostenpflichtige Static-Maps-API
   - optional `MAPTILER_STYLE`, voreingestellt `streets-v4`
   - optional `MATCH_RADIUS_M`, voreingestellt `3000`

   Der MapTiler-Schlüssel wird nur auf dem Server benutzt und erreicht den
   Browser nie. In den Schlüsseleinstellungen bei MapTiler bleiben die
   **Allowed HTTP origins deshalb am besten leer**: eine Herkunftssperre
   schützt hier nichts. Die App fragt jede Kachel einmal mit und einmal ohne
   Referer an, falls doch eine gesetzt ist.
5. Bei GitHub unter **Settings → Secrets and variables → Actions** anlegen:
   `DEPLOY_HOST` (IP), `DEPLOY_KEY` (Inhalt von `deploy_key`),
   `DEPLOY_HOST_KEY` (Ausgabe von `ssh-keyscan -t ed25519 <IP>`).
   Danach die lokale Datei `deploy_key` löschen.

Ein ganz neuer Server ohne alte Daten bekommt die sieben Pässe mit
`cd /srv/passeranking/app && sudo -u passe node --env-file=/etc/passeranking.env scripts/seed.mjs`.

### Ausrollen

Jeder Push auf `main` löst `.github/workflows/deploy.yml` aus. Die Action
meldet sich als `passe` an; der Schlüssel darf dort genau einen Befehl
auslösen, `passeranking-deploy`. Der holt den Stand, installiert Pakete nur
bei geändertem `package-lock.json`, startet den Dienst neu und meldet erst
Erfolg, wenn die App antwortet. Von Hand: `sudo -u passe passeranking-deploy`.

Welcher Zweig ausgerollt wird, steht in `/srv/passeranking/branch`.

### Umzug von Vercel

Einmalig, darf beliebig oft laufen – erst einmal, während die Seite noch auf
Vercel läuft, dann ein kurzer letzter Lauf beim Umschalten:

```sh
cd /srv/passeranking/app
sudo -u passe npm install --no-save @upstash/redis @vercel/blob
sudo -u passe node --env-file=/etc/passeranking.env scripts/migrate-from-vercel.mjs
```

Dafür gehören die alten Zugänge (`UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`, `BLOB_READ_WRITE_TOKEN`) vorübergehend mit in
`/etc/passeranking.env`. Das Skript übernimmt alle Schlüssel unverändert und
lädt jede Datei unter demselben Pfad herunter, den Redis schon kennt – danach
prüft es, ob jeder Foto- und Videoverweis eine Datei hat. Nach dem Umzug die
drei Zugänge wieder löschen. Im Kurzbefehl die Adresse auf den neuen Namen
umstellen.

`vercel.json` schaltet das automatische Ausrollen bei Vercel ab: die alte
Fassung bleibt dort unverändert erreichbar, bis das Projekt gelöscht wird.

### Eigene Domain

DNS-Eintrag (A, und AAAA für IPv6) auf die IP setzen, dann auf dem Server
`bash setup.sh --host passe.example.de` erneut laufen lassen – oder
`SITE_HOST` in `/etc/systemd/system/caddy.service.d/site.conf` ändern und
`systemctl daemon-reload && systemctl restart caddy`.

### Sichern

Die automatischen Hetzner-Backups sichern die Systemplatte, **nicht das
Volume**. Für Fotos, Videos und Redis deshalb zusätzlich den Ordner
`/srv/passeranking/data` sichern, etwa nächtlich mit `restic` in eine Hetzner
Storage Box. Redis schreibt seine Daten laufend nach `data/redis/`
(`appendonly.aof`); für eine konsistente Kopie vorher `redis-cli BGSAVE`.

### Nachsehen

```sh
systemctl status passeranking         # läuft die App?
journalctl -u passeranking -f         # ihre Ausgaben
tail -f /var/log/caddy/passeranking.log
redis-cli INFO persistence            # aof_enabled:1
```

## Lokal entwickeln

```sh
brew install redis && brew services start redis
npm install
echo 'APP_PASSWORD=lokal' > .env
npm run seed
npm run dev                           # http://127.0.0.1:3000
```

Lokal liefert `server.mjs` auch die Seite selbst aus; Dateien landen unter
`.data/`. Für die Kartenbilder `MAPTILER_KEY` mit in `.env` schreiben.

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
als Datei auf dem Server, ausgeliefert wie die Fotos über eine Route mit
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
(`photohash:<sha>`) wird die vorhandene Id zurückgegeben, keine zweite Datei.

Ohne iPhone lässt sich der Weg genauso prüfen:

```sh
curl -X POST https://<deine-domain>/api/import \
  -H "Authorization: Bearer $UPLOAD_TOKEN" -H 'Content-Type: image/jpeg' \
  -H 'X-Photo-Lat: 46.4876' -H 'X-Photo-Lon: 11.8122' \
  --data-binary @foto.jpg
```

### Doppelte Fotos

Dasselbe Bild ein zweites Mal hochzuladen legt keine zweite Datei mehr an: über
einen SHA-256 der Bytes (`photohash:<sha>` und zurück `photosha:<id>`) gibt der
Server die vorhandene Id aus. Das gilt für beide Wege, Browser wie Import.

Für das, was sich vorher schon angesammelt hat, läuft nach **jedem Hochladen**
still ein Durchgang: Bytes vergleichen, von jeder Gruppe eines stehen lassen,
den Rest entfernen. Wurde etwas gefunden, steht es in der Rückmeldung des
Uploads – sonst merkt man nichts davon. Einen Knopf dafür gibt es nicht mehr;
es ist Aufräumarbeit, keine Entscheidung.

Der Durchgang wartet ab, bis die Fotoliste des Passes wirklich geschrieben ist.
Ohne das räumt er auf, während der Upload die Liste noch speichert – und der
Schreibvorgang stellt die Doppel danach wieder her.

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

## Fotos und Videos ansehen

Ein Tipp öffnet die Aufnahme groß. Von dort lässt sich durch alles blättern,
was am Pass hängt: am Handy durch Wischen, am Rechner mit den Pfeiltasten oder
den Schaltflächen. Ein Zähler zeigt die Position.

**Vergrößern** geht mit zwei Fingern, per Doppeltipp (und Doppelklick) und am
Rechner mit Strg+Rad beziehungsweise der Trackpad-Geste. Bis sechsfach; im
vergrößerten Bild schiebt ein Finger den Ausschnitt, und der Rand lässt sich
nicht überfahren. Solange vergrößert ist, blättert ein Wisch nicht weiter –
sonst käme man aus dem Bild nicht mehr heraus. Beim Weiterblättern und beim
Schließen stellt sich die Ansicht zurück.

Die Gesten müssen sich gegenseitig in Ruhe lassen, deshalb wird mitgeführt, ob
ein Finger aufgesetzt, kaum gewandert und wieder abgehoben ist. Ohne das zählt
das Ende einer Zwei-Finger-Geste als Tipp – und die nächste Berührung als
Doppeltipp, der die Vergrößerung wieder wegnimmt.

Bei einem **Video** übernimmt die Bedienleiste des Browsers; dort wird nicht
gezoomt und nicht gewischt.

## Videos

Videos werden nicht verkleinert und gehen deshalb über eine eigene Route:
`POST /api/videos?passId=<id>` mit der Datei als Rumpf. Der Server schreibt
sie direkt auf die Platte, statt sie im Speicher zu sammeln, und bricht ab,
sobald mehr als 300 MB ankommen – angekündigte Übergröße lehnt er schon vor
dem ersten Byte ab. Ohne `passId` landet das Video im Eingang. Der Browser
lädt mit `XMLHttpRequest` hoch, weil nur das den Fortschritt meldet.

Erlaubt sind MP4, QuickTime (was iPhones aufnehmen) und WebM, bis 300 MB.
Ausgeliefert werden sie über dieselbe Route wie Fotos, also mit Sessionprüfung,
und mit Range-Anfragen: Safari auf dem iPhone spielt Videos nur ab, wenn der
Server Teilstücke liefern kann.

Dass eine Id zu einem Video gehört, steht in der Id selbst (`v-…`). Das ist
bewusst schlicht gehalten: Pässe, Eingang und Löschen reichen Ids ohnehin nur
durch und bleiben dadurch unverändert, und der Browser weiß trotzdem, ob er ein
`<img>` oder ein `<video>` bauen muss.

Im Streifen steht ein Standbild mit Abspielzeichen (`preload="metadata"` holt
nur das erste Bild, nicht den ganzen Film).

**Doppelte Videos** erkennt die Aufräumfunktion nicht: dafür müsste sie jedes
einzelne herunterladen, und dafür ist die Laufzeit zu knapp. Sie zählt sie in
der Antwort mit und lässt sie in Ruhe.

## Gemeinsam bewerten

Jede Änderung zählt serverseitig `passes:rev` hoch. Die Browser fragen nur
diese Zahl ab (`/api/session?poll=1`) und holen die Liste erst, wenn sie sich bewegt
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
Die Liste steht immer nach dieser Gesamtwertung; eine andere Sortierung gibt es nicht.
Unbewertete Pässe stehen am Ende und bekommen statt eines Platzes ein „–“,
sortiert nach `order`. Gleiche Werte teilen sich einen Platz.

Bewertungen erscheinen sofort und werden im Hintergrund gespeichert;
schlägt das fehl, springt der Balken zurück und eine Meldung sagt warum.
