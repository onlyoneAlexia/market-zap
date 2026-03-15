#!/usr/bin/env bash
set -euo pipefail

# ── MarketZap Droplet Setup Script ──────────────────────────────────
# Run on a fresh Ubuntu 22.04+ / Debian 12+ DigitalOcean droplet.
#
# Usage:
#   ssh root@<droplet-ip>
#   curl -sSL <raw-url-to-this-script> | bash
#   — or —
#   scp deploy/setup-droplet.sh root@<droplet-ip>:~/
#   ssh root@<droplet-ip> bash ~/setup-droplet.sh

echo "==> MarketZap Droplet Setup"

# ── 1. System packages ──────────────────────────────────────────────
echo "==> Installing system packages..."
apt-get update -qq
apt-get install -y -qq git curl ufw

# ── 2. Docker (if not installed) ────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# ── 3. Firewall ─────────────────────────────────────────────────────
echo "==> Configuring firewall..."
ufw allow OpenSSH
ufw allow 80/tcp     # HTTP (Caddy redirect)
ufw allow 443/tcp    # HTTPS
ufw allow 443/udp    # HTTP/3
ufw --force enable

# ── 4. Create app user ──────────────────────────────────────────────
if ! id marketzap &>/dev/null; then
  echo "==> Creating marketzap user..."
  useradd -m -s /bin/bash marketzap
  usermod -aG docker marketzap
fi

# ── 5. Clone repo ───────────────────────────────────────────────────
APP_DIR="/home/marketzap/market-zap"
if [ ! -d "$APP_DIR" ]; then
  echo "==> Cloning repository..."
  sudo -u marketzap git clone https://github.com/onlyoneAlexia/market-zap.git "$APP_DIR"
else
  echo "==> Pulling latest changes..."
  sudo -u marketzap git -C "$APP_DIR" pull
fi

# ── 6. Environment setup ────────────────────────────────────────────
DEPLOY_DIR="$APP_DIR/deploy"
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo ""
  echo "==> IMPORTANT: Create your .env file before starting:"
  echo "    cp $DEPLOY_DIR/.env.production.example $DEPLOY_DIR/.env"
  echo "    nano $DEPLOY_DIR/.env"
  echo ""
  echo "    Then start with:"
  echo "    cd $DEPLOY_DIR"
  echo "    docker compose -f docker-compose.prod.yml up -d"
  echo ""
  echo "    Verify with:"
  echo "    curl https://api.marketzap.app/api/health"
  echo ""
else
  echo "==> .env exists. Starting services..."
  cd "$DEPLOY_DIR"
  docker compose -f docker-compose.prod.yml up -d --build
  echo ""
  echo "==> Services started. Check status:"
  echo "    docker compose -f docker-compose.prod.yml ps"
  echo "    docker compose -f docker-compose.prod.yml logs -f engine"
  echo ""
fi

echo "==> Setup complete!"
echo ""
echo "DNS: Point api.marketzap.app A record to this droplet's IP."
echo "Caddy will automatically obtain SSL certificates once DNS propagates."
