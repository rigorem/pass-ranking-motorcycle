# Pässeranking

Bewertung von Motorradpässen in den Dolomiten und Südtirol nach **Fahrspaß** und **Ambiente**.
Eine einzelne HTML-Seite, veröffentlicht als Claude Artifact.

## Live

https://claude.ai/artifact/VuxDWBQuqjKuNTHZAY3ih8

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Die komplette App: Markup, Styles und Logik in einer Datei |
| `data/seed-passes.json` | Die Pässe, mit denen die Datenbank initial befüllt wurde |

Die Seite hat keinen Build-Schritt und keine Abhängigkeiten außer Barlow / Barlow
Condensed von Google Fonts.

## Laufzeit

Die Seite nutzt drei Artifact-Capabilities über `window.claude.use(...)`:

- **`db`** – geteilte Datenbank, Collection `passes`. Ein Dokument pro Pass:
  `de`, `intl`, `lad`, `alt`, `region`, `fun`, `amb`, `note`, `photos`, `order`.
  Schreibvorgänge laufen pro Pass durch eine Promise-Queue, damit schnelle Klicks
  sich nicht überholen.
- **`assets`** – Fotospeicher. Bilder werden vor dem Upload clientseitig auf
  max. 1800 px lange Kante als JPEG (Qualität 0.85) verkleinert.
- **`user`** – nur um Nur-Lese-Zugriff zu erkennen; ohne `data.write` werden
  Bewertung, Notizen und Bearbeiten ausgeblendet.

Ohne diese Capabilities (z. B. beim Öffnen der Datei direkt im Browser) zeigt die
Seite einen Hinweis statt der Liste. Für lokale Entwicklung an Layout und Styles
reicht ein statischer Server, die Liste bleibt dabei leer.

```sh
python3 -m http.server 8000
```

## Bewertung und Sortierung

Beide Achsen gehen von 1 bis 10. Ein erneuter Klick auf den aktuellen Wert setzt
ihn zurück auf „nicht bewertet“. Die Gesamtwertung ist der Mittelwert der
vorhandenen Werte — ein Pass mit nur einer Bewertung zählt mit dieser. Unbewertete
Pässe landen ans Ende der Liste und bekommen statt eines Platzes ein „–“, sortiert
nach `order`. Gleiche Werte teilen sich einen Platz.

## Veröffentlichen

Änderungen an `index.html` werden über das Artifact-Tool auf dieselbe URL
zurückgespielt, damit Link und gespeicherte Daten erhalten bleiben.
