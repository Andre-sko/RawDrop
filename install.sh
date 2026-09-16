#!/usr/bin/env bash
#
# Route Tracker — one-time setup.
#
# Walks through every install step and asks before each one, so you can
# skip whatever is already done. Nothing here is destructive: existing
# files, containers and .env values are reused or left alone unless you
# explicitly say otherwise.
#
# Day-to-day startup lives in ./start.sh instead.

# No `set -e`: this script is a conversation, and a single failing
# command should report itself and let you choose what to do next
# rather than making the whole thing vanish.
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

SKIPPED=()
skipped() { SKIPPED+=("$1"); }

if [ ! -t 0 ]; then
  fail "This installer is interactive — run it directly (./install.sh), not piped."
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

ask_value() { # ask_value "Prompt" "default"  -> echoes the answer
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    printf '    %s%s%s [%s] ' "$BOLD" "$prompt" "$RESET" "$default" >&2
  else
    printf '    %s%s%s ' "$BOLD" "$prompt" "$RESET" >&2
  fi
  read -r reply || reply=""
  printf '%s' "${reply:-$default}"
}

# --------------------------------------------------------------- helpers

DOCKER=""

detect_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  if docker info >/dev/null 2>&1; then DOCKER="docker"; return 0; fi
  # The daemon socket is usually root-owned; sudo is the normal answer.
  if sudo -n true 2>/dev/null && sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    return 0
  fi
  warn "Docker is installed but this user can't reach its daemon."
  if ask_yn "Use sudo for Docker commands (you'll be asked for your password)?" y; then
    if sudo docker info >/dev/null 2>&1; then DOCKER="sudo docker"; return 0; fi
    fail "Still can't reach Docker, even with sudo."
  fi
  note "Tip: 'sudo usermod -aG docker \$USER' (then log out and back in) removes the need for sudo."
  return 1
}

# Reads one key out of .env without sourcing the file (which would run
# whatever is in it).
env_get() {
  [ -f .env ] || return 1
  grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-
}

# Rewrites one key in place, leaving every other line byte-for-byte as it
# was. Avoids sed so values containing / & \ or spaces can't corrupt it,
# and so it behaves the same on GNU and BSD/macOS.
env_set() {
  local key="$1" value="$2" tmp found=0 line
  tmp="$(mktemp)" || return 1
  if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" == "$key="* ]]; then
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
        found=1
      else
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < .env
  fi
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}

container_exists() { $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

# ------------------------------------------------------------------ intro

printf '%s\n' "$BOLD"
cat <<'BANNER'
  ____             _        _____              _
 |  _ \ ___  _   _| |_ ___ |_   _| __ __ _  ___| | _____ _ __
 | |_) / _ \| | | | __/ _ \  | || '__/ _` |/ __| |/ / _ \ '__|
 |  _ < (_) | |_| | ||  __/  | || | | (_| | (__|   <  __/ |
 |_| \_\___/ \__,_|\__\___|  |_||_|  \__,_|\___|_|\_\___|_|
BANNER
printf '%s' "$RESET"
info "Setup — every step asks first, so you can skip what you already have."

# ------------------------------------------------------ 1. prerequisites

step "1/7  Checking prerequisites"

# Everything the app needs from the operating system, in one place —
# the "requirements file" for the non-npm side. Node packages themselves
# are in package.json / package-lock.json (installed in step 3).
#   node >= 18 + npm   required
#   curl or wget       map extract download (step 5)
#   docker             OSRM + Valhalla (optional — routing falls back to Google)
#   ffmpeg, tesseract  "Video → Address" tab only (step 2)

# install_pkg <apt-name> <brew-name> <dnf-name> — best effort, one package.
install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y "$1"
  elif command -v brew >/dev/null 2>&1; then brew install "$2"
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$3"
  else return 1
  fi
}

# Node 18+ via the NodeSource repo on apt (Ubuntu/Debian's own `nodejs`
# is often too old), the package manager elsewhere.
install_node() {
  if command -v apt-get >/dev/null 2>&1; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
    else
      sudo apt-get update && sudo apt-get install -y nodejs npm
    fi
  elif command -v brew >/dev/null 2>&1; then brew install node@20 && brew link --overwrite node@20
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs npm
  else return 1
  fi
}

MISSING_CORE=0

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  warn "Neither curl nor wget is installed (needed to download the map extract)."
  if ask_yn "Install curl now?" y; then install_pkg curl curl curl && ok "curl installed" || fail "could not install curl"; fi
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then NODE_OK=1; ok "Node $(node -v)"; else fail "Node $(node -v) is too old — this app needs Node 18 or newer."; fi
else
  fail "Node is not installed."
fi
if [ "$NODE_OK" -eq 0 ]; then
  if ask_yn "Install Node 20 now?" y; then
    install_node && command -v node >/dev/null 2>&1 && ok "Node $(node -v)" || { fail "Node install failed — get it from https://nodejs.org (18 or newer)."; MISSING_CORE=1; }
  else
    MISSING_CORE=1
  fi
fi

if command -v npm >/dev/null 2>&1; then ok "npm $(npm -v)"; else fail "npm is not installed (it ships with Node)."; MISSING_CORE=1; fi

if detect_docker; then
  ok "Docker reachable ($DOCKER)"
else
  warn "No usable Docker — the OSRM and Valhalla steps will be skipped."
  note "The app still runs without them: routing falls back to Google and the map stays hidden."
  if command -v apt-get >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
    if ask_yn "Install Docker (docker.io) now?" n; then
      sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable --now docker \
        && detect_docker && ok "Docker reachable ($DOCKER)" || fail "Docker install failed — see https://docs.docker.com/engine/install/"
    fi
  fi
fi

if [ "$MISSING_CORE" -eq 1 ]; then
  fail "Install the missing core tools above, then run this script again."
  exit 1
fi

# --------------------------------------------------- 2. system packages

step "2/7  System packages for 'Video → Address' (ffmpeg + tesseract)"

HAVE_FFMPEG=0; HAVE_TESSERACT=0
command -v ffmpeg    >/dev/null 2>&1 && HAVE_FFMPEG=1
command -v tesseract >/dev/null 2>&1 && HAVE_TESSERACT=1

if [ "$HAVE_FFMPEG" -eq 1 ] && [ "$HAVE_TESSERACT" -eq 1 ]; then
  ok "ffmpeg and tesseract are already installed"
else
  [ "$HAVE_FFMPEG" -eq 0 ]    && info "ffmpeg:    missing"
  [ "$HAVE_TESSERACT" -eq 0 ] && info "tesseract: missing"
  note "Only the 'Video → Address' tab needs these. Everything else works without them."
  if ask_yn "Install them now?" y; then
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y \
        ffmpeg tesseract-ocr tesseract-ocr-por tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ita
    elif command -v brew >/dev/null 2>&1; then
      brew install ffmpeg tesseract tesseract-lang
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y ffmpeg tesseract tesseract-langpack-por tesseract-langpack-fra tesseract-langpack-deu tesseract-langpack-ita
    else
      fail "No apt-get, brew or dnf found — install ffmpeg and tesseract manually."
    fi
    if command -v ffmpeg >/dev/null 2>&1 && command -v tesseract >/dev/null 2>&1; then
      ok "Installed"
    else
      warn "Still missing — the 'Video → Address' tab will report an error when used."
    fi
  else
    skipped "system packages (ffmpeg/tesseract)"
  fi
fi

# ------------------------------------------------------ 3. npm packages

step "3/7  Node dependencies"

if [ -d node_modules ]; then
  ok "node_modules already present"
  if ask_yn "Run 'npm ci' anyway (to pick up changes)?" n; then
    npm ci && ok "Dependencies up to date" || fail "npm ci failed"
  else
    skipped "npm ci"
  fi
else
  # npm ci = exactly what package-lock.json says, nothing newer — the same
  # versions on every machine, and it refuses to run if the lock is stale.
  if ask_yn "Run 'npm ci' now?" y; then
    npm ci && ok "Dependencies installed" || fail "npm ci failed"
  else
    skipped "npm ci"
    warn "The server will not start without this."
  fi
fi

# ------------------------------------------------------ 4. configuration

step "4/7  Configuration (.env)"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env && ok "Created .env from .env.example"
  else
    : > .env && ok "Created an empty .env"
  fi
else
  ok ".env already exists — only empty values will be filled in"
fi

# Google Maps key: the server refuses to start without it.
if [ -n "$(env_get GOOGLE_MAPS_API_KEY)" ]; then
  ok "GOOGLE_MAPS_API_KEY is set"
else
  warn "GOOGLE_MAPS_API_KEY is empty — the server exits at startup without it."
  note "Needs Distance Matrix API + Geocoding API enabled (Places API optional)."
  if ask_yn "Enter it now?" y; then
    KEY="$(ask_value 'Google Maps API key:')"
    [ -n "$KEY" ] && env_set GOOGLE_MAPS_API_KEY "$KEY" && ok "Saved"
  else
    skipped "GOOGLE_MAPS_API_KEY"
  fi
fi

# App password: optional, but without it anyone who can reach the port
# can spend your Google quota.
if [ -n "$(env_get APP_PASSWORD)" ]; then
  ok "APP_PASSWORD is set"
else
  warn "APP_PASSWORD is empty — the app would run with no login at all."
  if ask_yn "Set a password now?" y; then
    printf '    %sApp password:%s ' "$BOLD" "$RESET"; read -rs PW1; printf '\n'
    printf '    %sConfirm:%s ' "$BOLD" "$RESET";      read -rs PW2; printf '\n'
    if [ -n "$PW1" ] && [ "$PW1" = "$PW2" ]; then
      env_set APP_PASSWORD "$PW1" && ok "Saved"
    else
      fail "Passwords did not match (or were empty) — left unset."
    fi
    unset PW1 PW2
  else
    skipped "APP_PASSWORD"
  fi
fi

# Session secret: no reason to ever type this one by hand.
if [ -n "$(env_get SESSION_SECRET)" ]; then
  ok "SESSION_SECRET is set"
elif command -v openssl >/dev/null 2>&1; then
  env_set SESSION_SECRET "$(openssl rand -hex 32)" && ok "Generated a random SESSION_SECRET"
else
  warn "openssl not found — SESSION_SECRET left empty (you'll be logged out on every restart)."
fi

# Anthropic key: only the AI reading engine needs it.
if [ -n "$(env_get ANTHROPIC_API_KEY)" ]; then
  ok "ANTHROPIC_API_KEY is set"
else
  note "Optional: only for the AI reading engine in 'Video → Address'."
  if ask_yn "Add an Anthropic API key?" n; then
    AKEY="$(ask_value 'Anthropic API key:')"
    [ -n "$AKEY" ] && env_set ANTHROPIC_API_KEY "$AKEY" && ok "Saved"
  else
    skipped "ANTHROPIC_API_KEY (local OCR engine still works)"
  fi
fi

[ -z "$(env_get PORT)" ] && env_set PORT "3000"
APP_PORT="$(env_get PORT)"; APP_PORT="${APP_PORT:-3000}"

# ------------------------------------------------------- 5. map extract

step "5/7  Map data (OpenStreetMap extract)"

REGION_DIR="switzerland"
REGION_URL="https://download.geofabrik.de/europe/switzerland-latest.osm.pbf"

if [ -z "$DOCKER" ]; then
  warn "Skipping — Docker is not usable, so OSRM/Valhalla can't run anyway."
  skipped "map extract, OSRM and Valhalla (no Docker)"
else
  info "Default region: Switzerland (~400MB)"
  if ! ask_yn "Use Switzerland?" y; then
    REGION_URL="$(ask_value 'Geofabrik .osm.pbf URL:' "$REGION_URL")"
    DEFAULT_DIR="$(basename "$REGION_URL" | sed 's/-latest\.osm\.pbf$//')"
    REGION_DIR="$(ask_value 'Folder to keep it in:' "$DEFAULT_DIR")"
  fi

  PBF_NAME="$(basename "$REGION_URL")"
  PBF_PATH="$REGION_DIR/$PBF_NAME"
  OSRM_BASE="${PBF_NAME%.osm.pbf}"

  mkdir -p "$REGION_DIR"

  if [ -f "$PBF_PATH" ]; then
    ok "Extract already downloaded ($(du -h "$PBF_PATH" | cut -f1))"
  else
    info "Will download: $REGION_URL"
    if ask_yn "Download it now (large file)?" y; then
      if command -v wget >/dev/null 2>&1; then
        wget -O "$PBF_PATH" "$REGION_URL"
      elif command -v curl >/dev/null 2>&1; then
        curl -L -o "$PBF_PATH" "$REGION_URL"
      else
        fail "Neither wget nor curl is available."
      fi
      if [ -s "$PBF_PATH" ]; then
        ok "Downloaded"
      else
        fail "Download failed."
        rm -f "$PBF_PATH"
      fi
    else
      skipped "map extract download"
    fi
  fi

  # ---------------------------------------------------------- 6. OSRM

  step "6/7  OSRM (free self-hosted routing)"

  if [ ! -f "$PBF_PATH" ]; then
    warn "No extract present — nothing to pre-process."
    skipped "OSRM pre-processing"
  elif [ -f "$REGION_DIR/$OSRM_BASE.osrm.mldgr" ]; then
    ok "OSRM data already processed"
  else
    info "Pre-processing turns the .osm.pbf into OSRM's routing graph."
    warn "This needs several GB of RAM and can take a long time (tens of minutes)."
    if ask_yn "Run it now?" y; then
      OSRM_IMG="ghcr.io/project-osrm/osrm-backend"
      $DOCKER run -t -v "$PWD/$REGION_DIR:/data" "$OSRM_IMG" \
        osrm-extract -p /opt/car.lua "/data/$PBF_NAME" &&
      $DOCKER run -t -v "$PWD/$REGION_DIR:/data" "$OSRM_IMG" \
        osrm-partition "/data/$OSRM_BASE.osrm" &&
      $DOCKER run -t -v "$PWD/$REGION_DIR:/data" "$OSRM_IMG" \
        osrm-customize "/data/$OSRM_BASE.osrm"
      if [ -f "$REGION_DIR/$OSRM_BASE.osrm.mldgr" ]; then
        ok "OSRM data ready"
      else
        fail "Pre-processing did not finish — check the output above."
      fi
    else
      skipped "OSRM pre-processing"
    fi
  fi

  [ -z "$(env_get OSRM_URL)" ] && env_set OSRM_URL "http://localhost:5000"

  # ------------------------------------------------------- 7. Valhalla

  step "7/7  Valhalla (map view + road blocking)"

  if container_exists valhalla; then
    ok "Container 'valhalla' already exists — ./start.sh will just start it"
  elif [ ! -f "$PBF_PATH" ]; then
    warn "No extract present — Valhalla has nothing to build its tiles from."
    skipped "Valhalla container"
  else
    info "Creates the container and builds Valhalla's own tiles from the extract."
    warn "The first run takes a few minutes while it builds those tiles."
    if ask_yn "Create it now?" y; then
      $DOCKER run -d --name valhalla -p 8002:8002 \
        -v "$PWD/$REGION_DIR:/custom_files" \
        ghcr.io/gis-ops/docker-valhalla/valhalla:latest
      if container_exists valhalla; then
        ok "Container created — it keeps building tiles in the background"
        note "Follow it with: $DOCKER logs -f valhalla"
      else
        fail "Could not create the container — check the output above."
      fi
    else
      skipped "Valhalla container"
    fi
  fi

  # Without this the map section stays hidden and it isn't obvious why.
  [ -z "$(env_get VALHALLA_URL)" ] && env_set VALHALLA_URL "http://localhost:8002"

  # Remembered so ./start.sh mounts the same folder — it has no other way
  # to know which region you picked. The server ignores this key.
  env_set MAP_REGION_DIR "$REGION_DIR"
fi

# ----------------------------------------------------------- 8. wrap up

step "Done"

ok "Configuration is in .env"
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  info "Skipped:"
  for item in "${SKIPPED[@]}"; do note "  - $item"; done
  note "Re-run ./install.sh any time to pick these up."
fi

printf '\n'
info "Start everything with:  ${BOLD}./start.sh${RESET}"
info "The app will be at:     ${CYAN}http://localhost:$APP_PORT${RESET}"
printf '\n'
