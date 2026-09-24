#!/usr/bin/env bash
# Holt den neuesten Stand und startet die App neu. Läuft als Benutzer passe.
#
# setup-server.sh legt eine Kopie unter /usr/local/bin/passeranking-deploy ab.
# Die GitHub Action darf per SSH nur genau diesen Befehl auslösen (siehe
# authorized_keys von passe). Von Hand: sudo -u passe passeranking-deploy
#
# Welcher Zweig ausgerollt wird, steht in /srv/passeranking/branch (Vorgabe: main).

set -euo pipefail

# Alles in einer Funktion: bash liest sie ganz, bevor sie läuft. So stört es
# nicht, wenn git reset unten diese Datei im App-Ordner gerade austauscht.
main() {
  cd /srv/passeranking/app

  local branch
  branch=$(cat /srv/passeranking/branch 2>/dev/null || echo main)

  git fetch --quiet origin "$branch"
  local before after
  before=$(git rev-parse HEAD)
  git reset --quiet --hard "origin/$branch"
  after=$(git rev-parse HEAD)

  # Pakete nur neu holen, wenn sich die Liste geändert hat.
  if [ ! -d node_modules ] || ! git diff --quiet "$before" "$after" -- package-lock.json; then
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
  fi

  sudo /usr/bin/systemctl restart passeranking

  # Erst fertig melden, wenn die App wirklich antwortet.
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:3000/api/session; then
      echo "ausgerollt: $branch @ $(git log -1 --format='%h %s')"
      return 0
    fi
    sleep 0.5
  done
  echo "App antwortet nach dem Neustart nicht – journalctl -u passeranking -n 50" >&2
  return 1
}

main "$@"
