#!/usr/bin/env bash
#
# Route Tracker — day-to-day startup.
#
# Asks which routing engine to use, brings up the Docker containers that
# choice needs, waits until they actually answer, starts the server and
# opens it in the browser you pick.
#
# First-time setup lives in ./install.sh instead.

set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

# ---------------------------------------------------------------- output

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
note()  { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '    %s✗%s %s\n' "$RED" "$RESET" "$1"; }

if [ ! -t 0 ]; then
  fail "This script is interactive — run it directly (./start.sh), not piped."
  exit 1
fi

ask_yn() { # ask_yn "Question" [y|n]
  local question="$1" default="${2:-y}" hint reply
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while true; do
    printf '    %s%s%s %s ' "$BOLD" "$question" "$RESET" "$hint"
    read -r reply || return 1
    reply="${reply:-$default}"
    case "$reply" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo])     return 1 ;;
      *) fail "Please answer y or n." ;;
    esac
  done
}

# --------------------------------------------------------------- helpers

DOCKER=""

detect_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  if docker info >/dev/null 2>&1; then DOCKER="docker"; return 0; fi
  if sudo -n true 2>/dev/null && sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"; return 0
  fi
  warn "Docker is installed but this user can't reach its daemon."
  if ask_yn "Use sudo for Docker commands?" y; then
    if sudo docker info >/dev/null 2>&1; then DOCKER="sudo docker"; return 0; fi
    fail "Still can't reach Docker, even with sudo."
  fi
  return 1
}

env_get() {
  [ -f .env ] || return 1
  grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-
}

env_set() {
  local key="$1" value="$2" tmp found=0 line
  tmp="$(mktemp)" || return 1
  if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" == "$key="* ]]; then
        printf '%s=%s\n' "$key" "$value" >> "$tmp"; found=1
      else
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < .env
  fi
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}

# Waits for something to actually accept connections, rather than
# assuming a container that started is a container that's ready.
wait_for_port() { # wait_for_port host port timeout_seconds
  local host="$1" port="$2" timeout="${3:-60}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      exec 3<&- 3>&-
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
    printf '.'
  done
  return 1
}

port_is_open() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3<&- 3>&-; return 0; }; return 1; }

container_exists() { $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
container_running() { $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

# --------------------------------------------------------------- preflight

step "Checking the project"

if [ ! -f .env ]; then
  fail "No .env found — run ./install.sh first."
  exit 1
fi
ok ".env found"

if [ ! -d node_modules ]; then
  fail "No node_modules — run ./install.sh (or 'npm install') first."
  exit 1
fi
ok "Dependencies installed"

if [ -z "$(env_get GOOGLE_MAPS_API_KEY)" ]; then
  fail "GOOGLE_MAPS_API_KEY is empty in .env — the server won't start. Run ./install.sh."
  exit 1
fi
ok "API key configured"

APP_PORT="$(env_get PORT)"; APP_PORT="${APP_PORT:-3000}"

if port_is_open localhost "$APP_PORT"; then
  fail "Something is already listening on port $APP_PORT."
  note "Stop it first, or change PORT in .env."
  exit 1
fi

detect_docker || warn "No usable Docker — self-hosted engines will be unavailable."

# ------------------------------------------------------------ 1. engine

step "Routing engine"

info "  ${BOLD}1${RESET}) OSRM   — self-hosted, free and unlimited, no live traffic"
info "  ${BOLD}2${RESET}) Google — paid per request, includes live traffic"
CURRENT_SOURCE="$(env_get ROUTING_SOURCE)"; CURRENT_SOURCE="${CURRENT_SOURCE:-google}"
note "Currently in .env: $CURRENT_SOURCE"

DEFAULT_CHOICE=2
[ "$CURRENT_SOURCE" = "osrm" ] && DEFAULT_CHOICE=1

ROUTING_SOURCE=""
while [ -z "$ROUTING_SOURCE" ]; do
  printf '    %sChoose 1 or 2:%s [%s] ' "$BOLD" "$RESET" "$DEFAULT_CHOICE"
  read -r choice || choice=""
  choice="${choice:-$DEFAULT_CHOICE}"
  case "$choice" in
    1) ROUTING_SOURCE="osrm" ;;
    2) ROUTING_SOURCE="google" ;;
    *) fail "Please choose 1 or 2." ;;
  esac
done
ok "Using $ROUTING_SOURCE"

# ------------------------------------------------------------- 2. OSRM

OSRM_PORT=5000

if [ "$ROUTING_SOURCE" = "osrm" ]; then
  step "OSRM container"

  if port_is_open localhost "$OSRM_PORT"; then
    ok "Already running on port $OSRM_PORT"
  elif [ -z "$DOCKER" ]; then
    warn "Docker unavailable — the app will fall back to Google automatically."
  else
    # Whichever region ./install.sh set up, falling back to finding any
    # folder that has processed OSRM data in it.
    REGION_DIR="$(env_get MAP_REGION_DIR)"
    REGION_DIR="${REGION_DIR:-switzerland}"
    OSRM_FILE=""
    for candidate in "$REGION_DIR" */; do
      candidate="${candidate%/}"
      [ -d "$candidate" ] || continue
      for f in "$candidate"/*.osrm.mldgr; do
        [ -f "$f" ] && { OSRM_FILE="$f"; REGION_DIR="$candidate"; break 2; }
      done
    done

    if [ -z "$OSRM_FILE" ]; then
      warn "No pre-processed OSRM data in $REGION_DIR/ — run ./install.sh."
      note "The app will fall back to Google for this session."
    else
      OSRM_BASE="$(basename "$OSRM_FILE" .osrm.mldgr)"
      if container_exists route-tracker-osrm; then
        info "Starting existing container..."
        $DOCKER start route-tracker-osrm >/dev/null 2>&1
      else
        info "Creating the OSRM container..."
        $DOCKER run -d --name route-tracker-osrm -p "$OSRM_PORT:5000" \
          -v "$PWD/$REGION_DIR:/data" ghcr.io/project-osrm/osrm-backend \
          osrm-routed --algorithm mld "/data/$OSRM_BASE.osrm" >/dev/null 2>&1
      fi

      printf '    Waiting for OSRM'
      if wait_for_port localhost "$OSRM_PORT" 60; then
        printf '\n'; ok "OSRM is up on port $OSRM_PORT"
      else
        printf '\n'; fail "OSRM did not come up in time."
        note "Check with: $DOCKER logs route-tracker-osrm"
        note "The app will fall back to Google automatically."
      fi
    fi
  fi
fi

# --------------------------------------------------------- 3. Valhalla

VALHALLA_PORT=8002
step "Valhalla (map view + road blocking)"

if port_is_open localhost "$VALHALLA_PORT"; then
  ok "Already running on port $VALHALLA_PORT"
elif [ -z "$DOCKER" ]; then
  warn "Docker unavailable — the map section will stay hidden."
elif ask_yn "Start Valhalla? (needed for the map and for blocking roads)" y; then
  if container_exists valhalla; then
    $DOCKER start valhalla >/dev/null 2>&1
    printf '    Waiting for Valhalla'
    if wait_for_port localhost "$VALHALLA_PORT" 120; then
      printf '\n'; ok "Valhalla is up on port $VALHALLA_PORT"
    else
      printf '\n'; warn "Valhalla did not answer in time — the map may stay hidden."
      note "If this is the first run it may still be building tiles: $DOCKER logs -f valhalla"
    fi
  else
    warn "No 'valhalla' container exists — run ./install.sh to create it."
    note "Without it the map and road blocking stay hidden; everything else works."
  fi
else
  note "Skipped — the map section will stay hidden this session."
fi

# ------------------------------------------------- 4. remember the choice

if [ "$ROUTING_SOURCE" != "$CURRENT_SOURCE" ]; then
  step "Save this choice?"
  if ask_yn "Make ROUTING_SOURCE=$ROUTING_SOURCE permanent in .env?" n; then
    env_set ROUTING_SOURCE "$ROUTING_SOURCE" && ok "Saved to .env"
  else
    note "Using it for this session only — .env left as it was."
  fi
fi

# ----------------------------------------------------------- 5. the app

step "Starting the server"

# Job control gives the server its own process group, so the whole tree
# can be stopped at once later: npm spawns a shell, which spawns node.
set -m
ROUTING_SOURCE="$ROUTING_SOURCE" npm start &
SERVER_PID=$!
set +m

# Ctrl+C should take the server down with the script, not orphan it.
stop_server() {
  kill -0 "$SERVER_PID" 2>/dev/null || return 0
  # Signal the whole process group (the leading '-'), not just npm: npm
  # does not pass signals down to the node process it spawned, so
  # killing it alone leaves node running and holding the port, and the
  # next ./start.sh then refuses to start.
  kill -TERM -"$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}

cleanup() {
  printf '\n'
  step "Shutting down"
  stop_server
  # Confirm rather than assume: a port still held here is exactly what
  # breaks the next run, and it's better to say so than to look clean.
  local waited=0
  while [ "$waited" -lt 5 ] && port_is_open localhost "$APP_PORT"; do
    sleep 1; waited=$((waited + 1))
  done
  if port_is_open localhost "$APP_PORT"; then
    kill -KILL -"$SERVER_PID" 2>/dev/null # last resort, own group only
    sleep 1
  fi
  if port_is_open localhost "$APP_PORT"; then
    warn "Port $APP_PORT is still in use — something outlived the server."
    note "Find it with: lsof -i :$APP_PORT   (then kill that PID)"
  else
    ok "Server stopped"
  fi
  if [ -n "$DOCKER" ]; then
    note "Containers are still running. Stop them with:"
    note "  $DOCKER stop valhalla route-tracker-osrm"
  fi
  exit 0
}
trap cleanup INT TERM

printf '    Waiting for the app'
if ! wait_for_port localhost "$APP_PORT" 45; then
  printf '\n'
  fail "The server did not start — see the output above."
  kill "$SERVER_PID" 2>/dev/null
  exit 1
fi
printf '\n'
APP_URL="http://localhost:$APP_PORT"
ok "Running at $CYAN$APP_URL$RESET"

# -------------------------------------------------------- 6. the browser

step "Open in a browser"

BROWSER_LABELS=()
BROWSER_CMDS=()
add_browser() { # add_browser command "Label"
  if command -v "$1" >/dev/null 2>&1; then
    BROWSER_CMDS+=("$1"); BROWSER_LABELS+=("$2")
  fi
}
add_browser firefox           "Firefox"
add_browser google-chrome     "Google Chrome"
add_browser chromium          "Chromium"
add_browser chromium-browser  "Chromium"
add_browser brave-browser     "Brave"
add_browser microsoft-edge    "Microsoft Edge"
add_browser vivaldi           "Vivaldi"
add_browser opera             "Opera"
if command -v xdg-open >/dev/null 2>&1; then
  BROWSER_CMDS+=("xdg-open"); BROWSER_LABELS+=("System default")
elif command -v open >/dev/null 2>&1; then
  BROWSER_CMDS+=("open"); BROWSER_LABELS+=("System default")
fi

if [ "${#BROWSER_CMDS[@]}" -eq 0 ]; then
  warn "No browser found — open $APP_URL yourself."
else
  for i in "${!BROWSER_LABELS[@]}"; do
    printf '      %s%s%s) %s\n' "$BOLD" "$((i + 1))" "$RESET" "${BROWSER_LABELS[$i]}"
  done
  printf '      %s0%s) Don'"'"'t open a browser\n' "$BOLD" "$RESET"

  while true; do
    printf '    %sWhich one?%s [1] ' "$BOLD" "$RESET"
    read -r pick || pick=""
    pick="${pick:-1}"
    if [ "$pick" = "0" ]; then
      note "Not opening. The app is at $APP_URL"
      break
    fi
    if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#BROWSER_CMDS[@]}" ]; then
      CHOSEN="${BROWSER_CMDS[$((pick - 1))]}"
      nohup "$CHOSEN" "$APP_URL" >/dev/null 2>&1 &
      ok "Opening in ${BROWSER_LABELS[$((pick - 1))]}"
      break
    fi
    fail "Please choose a number from the list."
  done
fi

# ------------------------------------------------------------ 7. hold

printf '\n'
info "${BOLD}Press Ctrl+C to stop the server.${RESET}"
printf '\n'
wait "$SERVER_PID"
