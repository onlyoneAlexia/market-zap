#!/usr/bin/env bash
#
# dev-up.sh — Spin up Postgres, Redis, Engine, and Web for local dev.
#
# Usage:
#   ./scripts/dev-up.sh          # start everything
#   ./scripts/dev-up.sh --db     # only DB + Redis
#   ./scripts/dev-up.sh --stop   # tear down all services
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PG_CONTAINER="market-zap-postgres"
PG_PORT=5432
PG_USER="postgres"
PG_PASS="postgres"
PG_DB="market_zap"
PG_VOLUME="market-zap-pg-data"

REDIS_CONTAINER="market-zap-redis"
REDIS_PORT=6379

ENGINE_PORT=3001
WEB_PORT=3000

LOG_DIR="$ROOT_DIR/.dev-logs"
mkdir -p "$LOG_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[  ok]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[ err]${NC}  $*"; }

# ---------------------------------------------------------------------------
# Docker API version compat (rootless docker may need this)
# ---------------------------------------------------------------------------
if docker info &>/dev/null; then
  : # docker works as-is
elif DOCKER_API_VERSION=1.43 docker info &>/dev/null; then
  export DOCKER_API_VERSION=1.43
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
port_in_use() {
  ss -tlnp 2>/dev/null | grep -q ":$1 " && return 0
  return 1
}

wait_for_port() {
  local port=$1 name=$2 timeout=${3:-30}
  local elapsed=0
  while ! port_in_use "$port"; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      err "$name did not start on port $port within ${timeout}s"
      return 1
    fi
  done
  ok "$name is up on port $port (${elapsed}s)"
}

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Killing process(es) on port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

# ---------------------------------------------------------------------------
# --stop: tear everything down
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--stop" ]]; then
  info "Stopping all dev services..."

  # Kill node processes on engine/web ports
  kill_port $ENGINE_PORT
  kill_port $WEB_PORT

  # Stop containers
  docker stop "$PG_CONTAINER" 2>/dev/null && ok "Stopped $PG_CONTAINER" || true
  docker stop "$REDIS_CONTAINER" 2>/dev/null && ok "Stopped $REDIS_CONTAINER" || true

  ok "All services stopped."
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Postgres
# ---------------------------------------------------------------------------
info "Starting Postgres..."

PG_READY=false

if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  ok "Postgres container '$PG_CONTAINER' already running."
  PG_READY=true
elif port_in_use "$PG_PORT"; then
  # Another process/container already holds the port — just use it
  warn "Port $PG_PORT already in use (another Postgres instance?). Reusing it."
  PG_READY=true
else
  # Remove stopped container if it exists
  docker rm "$PG_CONTAINER" 2>/dev/null || true

  if docker run -d \
    --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASS" \
    -e POSTGRES_DB="$PG_DB" \
    -p "$PG_PORT:5432" \
    -v "$PG_VOLUME:/var/lib/postgresql/data" \
    postgres:16-alpine \
    >/dev/null 2>&1; then
    wait_for_port "$PG_PORT" "Postgres" 30 && PG_READY=true
  else
    if port_in_use "$PG_PORT"; then
      warn "Could not start $PG_CONTAINER (port $PG_PORT grabbed while we tried). Reusing existing."
      PG_READY=true
    else
      err "Failed to start Postgres container and port $PG_PORT is not available."
      err "Check: docker logs $PG_CONTAINER"
    fi
  fi
fi

# Ensure the market_zap database exists (try via our container, then via host psql)
if $PG_READY; then
  if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker exec "$PG_CONTAINER" \
      psql -U "$PG_USER" -tc "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'" 2>/dev/null \
      | grep -q 1 \
      || docker exec "$PG_CONTAINER" psql -U "$PG_USER" -c "CREATE DATABASE $PG_DB;" 2>/dev/null || true
  else
    # Try any running postgres container that has the port mapped
    local_pg=$(docker ps --filter "publish=$PG_PORT" --format '{{.Names}}' | head -1)
    if [ -n "$local_pg" ]; then
      docker exec "$local_pg" \
        psql -U "$PG_USER" -tc "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'" 2>/dev/null \
        | grep -q 1 \
        || docker exec "$local_pg" psql -U "$PG_USER" -c "CREATE DATABASE $PG_DB;" 2>/dev/null || true
    else
      warn "Cannot ensure '$PG_DB' database exists — no accessible postgres container found."
    fi
  fi
  ok "Postgres ready (port $PG_PORT, db=$PG_DB)"
else
  warn "Postgres NOT available — engine may fail to connect. Continuing anyway."
fi

# ---------------------------------------------------------------------------
# 2. Redis
# ---------------------------------------------------------------------------
info "Starting Redis..."

REDIS_READY=false

if docker ps --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
  ok "Redis container '$REDIS_CONTAINER' already running."
  REDIS_READY=true
elif port_in_use "$REDIS_PORT"; then
  warn "Port $REDIS_PORT already in use (another Redis instance?). Reusing it."
  REDIS_READY=true
else
  docker rm "$REDIS_CONTAINER" 2>/dev/null || true

  if docker run -d \
    --name "$REDIS_CONTAINER" \
    -p "$REDIS_PORT:6379" \
    redis:7-alpine \
    >/dev/null 2>&1; then
    wait_for_port "$REDIS_PORT" "Redis" 15 && REDIS_READY=true
  else
    if port_in_use "$REDIS_PORT"; then
      warn "Could not start $REDIS_CONTAINER (port $REDIS_PORT grabbed while we tried). Reusing existing."
      REDIS_READY=true
    else
      err "Failed to start Redis container and port $REDIS_PORT is not available."
      err "Check: docker logs $REDIS_CONTAINER"
    fi
  fi
fi

if $REDIS_READY; then
  ok "Redis ready (port $REDIS_PORT)"
else
  warn "Redis NOT available — engine may fail to connect. Continuing anyway."
fi

# Early exit if --db only
if [[ "${1:-}" == "--db" ]]; then
  echo ""
  ok "DB services ready. Start app services manually:"
  echo "   npm run dev:engine"
  echo "   npm run dev:web"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Engine (services/engine)
# ---------------------------------------------------------------------------
info "Starting Engine..."

kill_port $ENGINE_PORT

nohup npm run dev:engine > "$LOG_DIR/engine.log" 2>&1 &
ENGINE_PID=$!
disown "$ENGINE_PID" 2>/dev/null || true

wait_for_port "$ENGINE_PORT" "Engine" 30 || warn "Engine may still be starting — check $LOG_DIR/engine.log"

# ---------------------------------------------------------------------------
# 4. Web (apps/web)
# ---------------------------------------------------------------------------
info "Starting Web..."

kill_port $WEB_PORT

nohup npm run dev:web > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
disown "$WEB_PID" 2>/dev/null || true

wait_for_port "$WEB_PORT" "Web" 30 || warn "Web may still be starting — check $LOG_DIR/web.log"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  All services are up!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Web:      ${CYAN}http://localhost:${WEB_PORT}${NC}"
echo -e "  Engine:   ${CYAN}http://localhost:${ENGINE_PORT}${NC}"
echo -e "  Postgres: ${CYAN}localhost:${PG_PORT}${NC} (db: ${PG_DB})"
echo -e "  Redis:    ${CYAN}localhost:${REDIS_PORT}${NC}"
echo ""
echo -e "  Logs:     ${YELLOW}$LOG_DIR/engine.log${NC}"
echo -e "            ${YELLOW}$LOG_DIR/web.log${NC}"
echo ""
echo -e "  Stop all: ${YELLOW}./scripts/dev-up.sh --stop${NC}"
