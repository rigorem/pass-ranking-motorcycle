#!/usr/bin/env bash
# Richtet einen frischen Hetzner-Server (Ubuntu 24.04) für das Pässeranking ein.
# Als root ausführen; darf beliebig oft laufen.
#
#   curl -fsSL https://raw.githubusercontent.com/rigorem/pass-ranking-motorcycle/main/deploy/setup-server.sh -o setup.sh
#   bash setup.sh [--branch hetzner] [--host 49-12-34-56.sslip.io] [--deploy-key "ssh-ed25519 AAAA… github-deploy"]
#
# Ohne --host wird der Name aus der öffentlichen IPv4 gebildet (sslip.io).
# Ohne --branch wird main ausgerollt.
#
# Was das Skript nicht tut: Geheimnisse eintragen. Die gehören von Hand nach
# /etc/passeranking.env (Vorlage legt es an), danach: systemctl restart passeranking

set -euo pipefail

REPO=https://github.com/rigorem/pass-ranking-motorcycle.git
BRANCH=main
SITE_HOST=
DEPLOY_KEY=

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH=$2; shift 2 ;;
    --host) SITE_HOST=$2; shift 2 ;;
    --deploy-key) DEPLOY_KEY=$2; shift 2 ;;
    *) echo "Unbekannt: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen." >&2; exit 1; }

BASE=/srv/passeranking
APP=$BASE/app
DATA=$BASE/data
step() { printf '\n== %s\n' "$*"; }

step "Pakete"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq curl git ufw gnupg debian-keyring debian-archive-keyring apt-transport-https \
  unattended-upgrades redis-server

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

step "Automatische Sicherheitsupdates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

step "Benutzer und Ordner"
id passe >/dev/null 2>&1 || useradd --system --create-home --home-dir $BASE --shell /bin/bash passe
passwd -l passe >/dev/null
mkdir -p $BASE

# Daten auf das Hetzner-Volume, wenn eines eingehängt ist: es lässt sich
# später vergrößern, ohne den Server anzufassen.
VOLUME=$(find /mnt -maxdepth 1 -name 'HC_Volume_*' -type d | head -n1 || true)
mkdir -p $DATA
if [ -n "$VOLUME" ]; then
  mkdir -p "$VOLUME/passeranking"
  if ! grep -q " $DATA " /etc/fstab; then
    echo "$VOLUME/passeranking $DATA none bind,nofail,x-systemd.requires-mounts-for=$VOLUME 0 0" >> /etc/fstab
    systemctl daemon-reload
  fi
  mountpoint -q $DATA || mount $DATA
  echo "Daten liegen auf $VOLUME"
else
  echo "Kein Hetzner-Volume gefunden – Daten liegen auf der Systemplatte."
fi
mkdir -p $DATA/blobs $DATA/redis
chown passe:passe $BASE $DATA $DATA/blobs
chown redis:redis $DATA/redis
chmod 750 $DATA/redis

echo "$BRANCH" > $BASE/branch
chown passe:passe $BASE/branch

step "Code"
if [ ! -d $APP/.git ]; then
  sudo -u passe git clone --quiet --branch "$BRANCH" "$REPO" $APP
fi
sudo -u passe git -C $APP fetch --quiet origin "$BRANCH"
sudo -u passe git -C $APP reset --quiet --hard "origin/$BRANCH"
(cd $APP && sudo -u passe npm ci --omit=dev --no-audit --no-fund --loglevel=error)
install -m 755 $APP/deploy/deploy.sh /usr/local/bin/passeranking-deploy

step "Redis"
# Nur localhost, mit Append-Only-Datei: jede Änderung ist nach spätestens
# einer Sekunde auf der Platte.
cat > /etc/redis/passeranking.conf <<EOF
bind 127.0.0.1 -::1
protected-mode yes
dir $DATA/redis
appendonly yes
appendfsync everysec
EOF
grep -q '^include /etc/redis/passeranking.conf' /etc/redis/redis.conf \
  || echo 'include /etc/redis/passeranking.conf' >> /etc/redis/redis.conf
mkdir -p /etc/systemd/system/redis-server.service.d
cat > /etc/systemd/system/redis-server.service.d/passeranking.conf <<EOF
[Service]
ReadWritePaths=$DATA/redis
EOF

step "Einstellungen der App"
if [ ! -f /etc/passeranking.env ]; then
  cat > /etc/passeranking.env <<EOF
# Geheimnisse und Einstellungen des Pässerankings. Nach Änderungen:
#   systemctl restart passeranking
APP_PASSWORD=
GUEST_PASSWORD=
SESSION_SECRET=
UPLOAD_TOKEN=
MAPTILER_KEY=
MAPTILER_STYLE=outdoor-v2
MATCH_RADIUS_M=3000

REDIS_URL=redis://127.0.0.1:6379
DATA_DIR=$DATA
PORT=3000
HOST=127.0.0.1

# Nur für den einmaligen Umzug (scripts/migrate-from-vercel.mjs), danach löschen:
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
BLOB_READ_WRITE_TOKEN=
EOF
fi
chown root:passe /etc/passeranking.env
chmod 640 /etc/passeranking.env

step "Dienst"
install -m 644 $APP/deploy/passeranking.service /etc/systemd/system/passeranking.service
# passe darf die App neu starten – sonst nichts.
echo 'passe ALL=(root) NOPASSWD: /usr/bin/systemctl restart passeranking' > /etc/sudoers.d/passeranking
chmod 440 /etc/sudoers.d/passeranking
visudo -cf /etc/sudoers.d/passeranking >/dev/null

step "Caddy"
if [ -z "$SITE_HOST" ]; then
  IP=$(curl -fsS http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || curl -4fsS https://ifconfig.co)
  SITE_HOST="${IP//./-}.sslip.io"
fi
install -m 644 $APP/deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d /var/log/caddy
chown caddy:caddy /var/log/caddy
cat > /etc/systemd/system/caddy.service.d/site.conf <<EOF
[Service]
Environment=SITE_HOST=$SITE_HOST
EOF

step "Firewall und SSH"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null
cat > /etc/ssh/sshd_config.d/10-passeranking.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh

# Der Schlüssel der GitHub Action darf genau eins: passeranking-deploy auslösen.
if [ -n "$DEPLOY_KEY" ]; then
  install -d -m 700 -o passe -g passe $BASE/.ssh
  echo "command=\"/usr/local/bin/passeranking-deploy\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $DEPLOY_KEY" \
    > $BASE/.ssh/authorized_keys
  chown passe:passe $BASE/.ssh/authorized_keys
  chmod 600 $BASE/.ssh/authorized_keys
fi

step "Starten"
systemctl daemon-reload
systemctl enable --now redis-server >/dev/null
systemctl restart redis-server
systemctl enable passeranking >/dev/null
systemctl restart passeranking
systemctl restart caddy

sleep 2
if curl -fsS -o /dev/null http://127.0.0.1:3000/api/session; then
  echo "App läuft."
else
  echo "App antwortet noch nicht: journalctl -u passeranking -n 50" >&2
fi

cat <<EOF

Fertig. Adresse: https://$SITE_HOST  (Zweig: $BRANCH)

Noch zu tun:
  1. Geheimnisse eintragen:   nano /etc/passeranking.env && systemctl restart passeranking
  2. Daten übernehmen:        cd $APP && sudo -u passe npm install --no-save @upstash/redis @vercel/blob \\
                                && sudo -u passe node --env-file=/etc/passeranking.env scripts/migrate-from-vercel.mjs
EOF
