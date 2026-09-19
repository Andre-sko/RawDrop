#!/usr/bin/env bash
#
# Rawdrop — refresh the map data behind OSRM and Valhalla.
#
# The OpenStreetMap extract under switzerland/ is a snapshot. Roads get
# built, closed, renamed and re-numbered, and a graph built months ago
# will happily route a van down a street that no longer goes through.
# Geofabrik republishes the extract daily; this brings it down and
# rebuilds both engines from it.
#
# The whole point of this script is that it CANNOT leave you without a
# working router. Everything is built in a staging directory first, the
# live files are only swapped in once the new graph is proven to answer
# a real route request, and anything that goes wrong puts the previous
# data straight back. A rebuild takes tens of minutes and needs several
# GB of RAM: it is a "leave it running over lunch" job, not a quick one.
#
# ./install.sh is for the first time. ./start.sh is for every day. This
# is for the once-a-month (or once-a-quarter) refresh.
#
# Usage:
#   ./update-maps.sh              refresh whatever is out of date, asking first
#   ./update-maps.sh --check      only report whether an update is available
#   ./update-maps.sh --yes        never ask (for cron)
#   ./update-maps.sh --osrm-only
#   ./update-maps.sh --valhalla-only
#   ./update-maps.sh --keep-old   don't delete the replaced data at the end
#   ./update-maps.sh --url URL    use a different Geofabrik extract
#
# Exit codes: 0 done (or already current), 1 something failed, 2 an
# update is available (--check only) — so cron can act on it.

# No `set -e`: a failing step here has to be caught and ROLLED BACK, not
# allowed to end the script halfway through a swap.
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

# --------------------------------------------------------------- options

ASSUME_YES=0
CHECK_ONLY=0
DO_OSRM=1
DO_VALHALLA=1
KEEP_OLD=0
REGION_DIR="switzerland"
REGION_URL="https://download.geofabrik.de/europe/switzerland-latest.osm.pbf"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)        ASSUME_YES=1 ;;
    --check)         CHECK_ONLY=1 ;;
    --osrm-only)     DO_VALHALLA=0 ;;
    --valhalla-only) DO_OSRM=0 ;;
    --keep-old)      KEEP_OLD=1 ;;
    --url)           shift; REGION_URL="${1:-$REGION_URL}" ;;
    --region-dir)    shift; REGION_DIR="${1:-$REGION_DIR}" ;;
    -h|--help)       sed -n '3,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Non-interactive by force when there is no terminal to ask at — a cron
# run must never sit waiting for an answer nobody is there to give.
[ -t 0 ] || ASSUME_YES=1

ask_yn() { # ask_yn "Question" [y|n]
  local question="$1" default="${2:-y}" hint reply
  [ "$ASSUME_YES" -eq 1 ] && return 0
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

# Reads one key out of .env without sourcing the file (which would run
# whatever is in it). Same as install.sh — kept here so this script
# stands on its own.
env_get() {
  [ -f .env ] || return 1
  grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-
}

DOCKER=""
detect_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  if docker info >/dev/null 2>&1; then DOCKER="docker"; return 0; fi
  if sudo -n true 2>/dev/null && sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"; return 0
  fi
  # Unlike install.sh this does not offer to prompt for a password: the
  # run can be unattended, and a sudo prompt in cron hangs forever.
  return 1
}

container_exists() { $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
container_running() { $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

# md5 of a local file, on both GNU and BSD/macOS.
md5_of() {
  if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1
  elif command -v md5 >/dev/null 2>&1; then md5 -q "$1"
  else return 1; fi
}

fetch() { # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else return 1; fi
}

fetch_show() { # same, but with a progress bar for the big download
  if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -O "$2" "$1"
  else return 1; fi
}

# Free space where the region dir lives, in MB.
free_mb() {
  df -Pk "$1" 2>/dev/null | awk 'NR==2 {print int($4/1024)}'
}

http_ok() { # http_ok URL  -> is something answering there?
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 10 -o /dev/null "$1" 2>/dev/null
  else
    wget -q -T 10 -O /dev/null "$1" 2>/dev/null
  fi
}

# ------------------------------------------------------------------ setup

printf '%s%sRawdrop — map data update%s\n' "$BOLD" "$CYAN" "$RESET"

PBF_NAME="$(basename "$REGION_URL")"
PBF_PATH="$REGION_DIR/$PBF_NAME"
OSRM_BASE="${PBF_NAME%.osm.pbf}"
STAGE_DIR="$REGION_DIR/.update"
STAMP="$(date +%Y%m%d-%H%M%S)"
OLD_SUFFIX=".old-$STAMP"

if [ ! -d "$REGION_DIR" ]; then
  fail "No '$REGION_DIR' directory — there is nothing to update yet."
  note "Run ./install.sh first to download the extract and build the engines."
  exit 1
fi

# ------------------------------------------------- 1. is there an update?

step "1/5  Checking Geofabrik"

REMOTE_MD5=""
MD5_TMP="$(mktemp)"
if fetch "$REGION_URL.md5" "$MD5_TMP"; then
  REMOTE_MD5="$(awk '{print $1}' "$MD5_TMP" | head -1)"
fi
rm -f "$MD5_TMP"

if [ -z "$REMOTE_MD5" ]; then
  fail "Could not read $REGION_URL.md5 — is the machine online?"
  exit 1
fi

LOCAL_MD5=""
if [ -f "$PBF_PATH" ]; then
  info "Hashing the extract you already have (a few seconds)…"
  LOCAL_MD5="$(md5_of "$PBF_PATH")"
fi

info "published: $REMOTE_MD5"
info "local    : ${LOCAL_MD5:-<none>}"

if [ "$REMOTE_MD5" = "$LOCAL_MD5" ]; then
  ok "The map data is already the published one — nothing to do."
  exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  warn "A newer extract is available."
  note "Run ./update-maps.sh to install it."
  exit 2
fi

# ------------------------------------------------------------ 2. can we?

step "2/5  Room and tools"

if ! detect_docker; then
  fail "Docker is not reachable from this user."
  note "Both engines run in containers, so there is nothing this script can do."
  note "Tip: 'sudo usermod -aG docker \$USER' (then log out and back in)."
  exit 1
fi
ok "Docker: $DOCKER"

# The rebuild writes a whole second copy of the graph before anything is
# swapped — that is what makes it safe — so the disk has to have room for
# it. Filling the root filesystem is a far worse outcome than a skipped
# update, so this refuses rather than "tries and sees".
NEED_MB=4096
HAVE_MB="$(free_mb "$REGION_DIR")"
info "free space: ${HAVE_MB}MB (need about ${NEED_MB}MB to build alongside the live data)"
if [ "${HAVE_MB:-0}" -lt "$NEED_MB" ]; then
  fail "Not enough free space to rebuild safely."
  note "Free some space, or pass --keep-old off and delete an older $REGION_DIR/*.old-* set."
  exit 1
fi
ok "Enough room to build alongside what is running"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" || { fail "Could not create $STAGE_DIR"; exit 1; }

# Whatever happens from here on, the staging directory goes away and the
# live data is left in one piece.
cleanup_stage() { rm -rf "$STAGE_DIR"; }
trap cleanup_stage EXIT

# --------------------------------------------------------- 3. download

step "3/5  Downloading the new extract"

info "$REGION_URL"
if ! ask_yn "Download it now (several hundred MB)?" y; then
  info "Nothing changed."
  exit 0
fi

if ! fetch_show "$REGION_URL" "$STAGE_DIR/$PBF_NAME"; then
  fail "Download failed."
  exit 1
fi

info "Verifying the download…"
GOT_MD5="$(md5_of "$STAGE_DIR/$PBF_NAME")"
if [ "$GOT_MD5" != "$REMOTE_MD5" ]; then
  fail "Checksum mismatch — the download is corrupt, stopping before anything is touched."
  note "expected $REMOTE_MD5"
  note "got      $GOT_MD5"
  exit 1
fi
ok "Downloaded and verified ($(du -h "$STAGE_DIR/$PBF_NAME" | cut -f1))"

# ------------------------------------------------------------- 4. OSRM

OSRM_DONE=0

if [ "$DO_OSRM" -eq 1 ]; then
  step "4/5  Rebuilding the OSRM graph"

  # Speed overrides are hand-made local data, not something the rebuild
  # can regenerate. They live beside the extract and have to be carried
  # into the new graph, or a refresh silently throws the tuning away.
  SPEED_FILE=""
  if [ -f "$REGION_DIR/segment-speed-overrides.csv" ]; then
    cp "$REGION_DIR/segment-speed-overrides.csv" "$STAGE_DIR/" &&
      SPEED_FILE="segment-speed-overrides.csv"
    ok "Carrying your segment-speed-overrides.csv into the new graph"
  fi

  warn "This needs several GB of RAM and usually takes tens of minutes."
  note "The app keeps working on the current graph the whole time."

  if ask_yn "Build it now?" y; then
    OSRM_IMG="ghcr.io/project-osrm/osrm-backend"
    CUSTOMIZE_ARGS=("osrm-customize" "/data/$OSRM_BASE.osrm")
    [ -n "$SPEED_FILE" ] && CUSTOMIZE_ARGS+=("--segment-speed-file" "/data/$SPEED_FILE")

    if $DOCKER run --rm -t -v "$PWD/$STAGE_DIR:/data" "$OSRM_IMG" \
         osrm-extract -p /opt/car.lua "/data/$PBF_NAME" &&
       $DOCKER run --rm -t -v "$PWD/$STAGE_DIR:/data" "$OSRM_IMG" \
         osrm-partition "/data/$OSRM_BASE.osrm" &&
       $DOCKER run --rm -t -v "$PWD/$STAGE_DIR:/data" "$OSRM_IMG" \
         "${CUSTOMIZE_ARGS[@]}"
    then
      if [ -f "$STAGE_DIR/$OSRM_BASE.osrm.mldgr" ]; then
        ok "New graph built"

        # The swap. Renames only, on one filesystem, so it is quick and
        # the old set is still there in full if the new one turns out
        # not to answer.
        info "Swapping it in…"
        if container_running route-tracker-osrm; then
          $DOCKER stop route-tracker-osrm >/dev/null 2>&1
          OSRM_WAS_RUNNING=1
        else
          OSRM_WAS_RUNNING=0
        fi

        mkdir -p "$REGION_DIR/replaced$OLD_SUFFIX"
        for f in "$REGION_DIR/$OSRM_BASE".osrm*; do
          [ -e "$f" ] && mv "$f" "$REGION_DIR/replaced$OLD_SUFFIX/"
        done
        [ -f "$PBF_PATH" ] && mv "$PBF_PATH" "$REGION_DIR/replaced$OLD_SUFFIX/"

        mv "$STAGE_DIR/$OSRM_BASE".osrm* "$REGION_DIR/"
        mv "$STAGE_DIR/$PBF_NAME" "$REGION_DIR/"

        if [ "$OSRM_WAS_RUNNING" -eq 1 ]; then
          $DOCKER start route-tracker-osrm >/dev/null 2>&1
          sleep 5
        fi

        # Proof, not hope: ask the new graph for a real route and see
        # whether it answers. Bern -> Thun, a pair that exists in every
        # Swiss extract; for another region this just reports "could not
        # verify" and leaves the rollback to you.
        OSRM_URL="$(env_get OSRM_URL)"; OSRM_URL="${OSRM_URL:-http://localhost:5000}"
        if [ "$OSRM_WAS_RUNNING" -eq 1 ]; then
          if http_ok "$OSRM_URL/route/v1/driving/7.4474,46.9480;7.6280,46.7580?overview=false"; then
            ok "The new graph is answering route requests"
            OSRM_DONE=1
          else
            fail "The new graph is not answering — rolling back."
            $DOCKER stop route-tracker-osrm >/dev/null 2>&1
            for f in "$REGION_DIR/$OSRM_BASE".osrm*; do
              [ -e "$f" ] && rm -f "$f"
            done
            rm -f "$PBF_PATH"
            mv "$REGION_DIR/replaced$OLD_SUFFIX"/* "$REGION_DIR/"
            rmdir "$REGION_DIR/replaced$OLD_SUFFIX" 2>/dev/null
            $DOCKER start route-tracker-osrm >/dev/null 2>&1
            fail "The previous graph is back in place."
            exit 1
          fi
        else
          ok "New graph in place (OSRM was not running, so nothing to restart)"
          note "./start.sh will pick it up."
          OSRM_DONE=1
        fi
      else
        fail "The build did not produce a graph — the live data was never touched."
        exit 1
      fi
    else
      fail "Pre-processing failed — the live data was never touched."
      exit 1
    fi
  else
    info "Skipped the OSRM rebuild."
  fi
else
  step "4/5  OSRM — skipped (--valhalla-only)"
fi

# --------------------------------------------------------- 5. Valhalla

if [ "$DO_VALHALLA" -eq 1 ]; then
  step "5/5  Rebuilding the Valhalla tiles"

  if ! container_exists valhalla; then
    warn "No 'valhalla' container — run ./install.sh to create it."
  elif [ ! -f "$PBF_PATH" ]; then
    warn "The new extract is not in place (the OSRM step was skipped), so there is"
    warn "nothing new for Valhalla to build from."
  else
    info "Valhalla rebuilds its own tiles from the extract when they are missing."
    warn "That takes a few minutes, and the map view is unavailable while it runs."
    if ask_yn "Rebuild them now?" y; then
      $DOCKER stop valhalla >/dev/null 2>&1

      # Moved, not deleted: if the rebuild does not come up, these go
      # back and the map view returns.
      mkdir -p "$REGION_DIR/replaced$OLD_SUFFIX"
      for t in valhalla_tiles valhalla_tiles.tar; do
        [ -e "$REGION_DIR/$t" ] && mv "$REGION_DIR/$t" "$REGION_DIR/replaced$OLD_SUFFIX/"
      done

      $DOCKER start valhalla >/dev/null 2>&1
      VALHALLA_URL="$(env_get VALHALLA_URL)"; VALHALLA_URL="${VALHALLA_URL:-http://localhost:8002}"

      info "Waiting for the tiles to build…"
      BUILT=0
      for _ in $(seq 1 120); do   # up to 20 minutes, checked every 10s
        if http_ok "$VALHALLA_URL/status"; then BUILT=1; break; fi
        sleep 10
        printf '.'
      done
      printf '\n'

      if [ "$BUILT" -eq 1 ]; then
        ok "Valhalla is back up on the new data"
      else
        fail "Valhalla did not come back within 20 minutes — putting the old tiles back."
        $DOCKER stop valhalla >/dev/null 2>&1
        rm -rf "$REGION_DIR/valhalla_tiles" "$REGION_DIR/valhalla_tiles.tar"
        for t in valhalla_tiles valhalla_tiles.tar; do
          [ -e "$REGION_DIR/replaced$OLD_SUFFIX/$t" ] && mv "$REGION_DIR/replaced$OLD_SUFFIX/$t" "$REGION_DIR/"
        done
        $DOCKER start valhalla >/dev/null 2>&1
        note "Follow what it is doing with: $DOCKER logs -f valhalla"
      fi
    else
      info "Skipped the Valhalla rebuild."
    fi
  fi
else
  step "5/5  Valhalla — skipped (--osrm-only)"
fi

# ------------------------------------------------------------------ done

step "Done"

if [ -d "$REGION_DIR/replaced$OLD_SUFFIX" ]; then
  REPLACED_SIZE="$(du -sh "$REGION_DIR/replaced$OLD_SUFFIX" 2>/dev/null | cut -f1)"
  if [ "$KEEP_OLD" -eq 1 ]; then
    ok "The replaced data is kept in $REGION_DIR/replaced$OLD_SUFFIX ($REPLACED_SIZE)"
  elif [ "$OSRM_DONE" -eq 1 ] || [ "$DO_OSRM" -eq 0 ]; then
    info "Deleting the replaced data ($REPLACED_SIZE)…"
    rm -rf "$REGION_DIR/replaced$OLD_SUFFIX"
    ok "Cleaned up"
  else
    warn "Keeping $REGION_DIR/replaced$OLD_SUFFIX ($REPLACED_SIZE) — the update did not fully succeed."
  fi
fi

ok "Map data is now the extract published as $REMOTE_MD5"
note "Restart the app with ./start.sh if it is not already running."
