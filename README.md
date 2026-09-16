# Route Tracker — server-backed version (protected key)

Web app for planning delivery routes: distance/time between stops, route
optimization (TSP + time windows), OCR-based address extraction from
video/photo, and an interactive map with dynamic road exclusion. The
Google Maps API key lives on the server (`.env`), never sent to the
browser.

> © 2026 André Soares. All rights reserved. See `LICENSE`.

## Setup

Two scripts do all of the below interactively, asking before each step:

```bash
./install.sh   # one-time setup: packages, .env, map data, OSRM, Valhalla
./start.sh     # daily: pick the routing engine, start the containers and the app
```

`start.sh` also asks which browser to open. The rest of this section is
what those scripts do, for when you'd rather run it by hand.

### 1. System prerequisites (OCR only)

The "Video → Address" tab shells out to `ffmpeg` and `tesseract`
(native binaries, not npm packages — lighter and faster than JS/WASM
alternatives):

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y ffmpeg tesseract-ocr tesseract-ocr-por tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ita

# macOS
brew install ffmpeg tesseract tesseract-lang
```

Without these, the rest of the app works normally — only "Video →
Address" errors out.

### 2. Install dependencies

Node packages are listed in `package.json` and pinned in
`package-lock.json` — that pair is the requirements file:

```bash
npm ci        # exact versions from package-lock.json (npm install also works)
```

### 3. Configure the API key

```bash
cp .env.example .env
```

```
GOOGLE_MAPS_API_KEY=your_key_here
PORT=3000
```

Enable in Google Cloud Console: **Distance Matrix API**, **Geocoding
API**, and (optional fallback) **Places API**.

Optional, for the "AI" OCR engine (see [Video → Address](#video--address)):

```
ANTHROPIC_API_KEY=sk-ant-your_key_here
```

`.env` is gitignored.

### 4. Password-protect the app (recommended)

Without this, anyone with the server's address can use it — including
burning your Google API quota.

```
APP_PASSWORD=choose_a_strong_password
SESSION_SECRET=a_long_random_string_here   # openssl rand -hex 32
```

Sessions last 30 days (`/logout` to end one). 5 failed attempts from
the same IP triggers a 15-minute block. If `SESSION_SECRET` is unset, a
new one is generated on every restart (forces re-login each time). If
`APP_PASSWORD` is unset entirely, the app runs open and logs a warning
on startup.

This protects *access to the running app*, not the source files
themselves — don't publish the repo publicly if that matters to you.

### 5. Run

```bash
npm start        # http://localhost:3000
```

## Usage

### Route tab

- **Start/end point** (optional) — used as first and last stop for a
  round trip; saved in the browser.
- **Addresses** — one per line, paste or upload `.txt`/`.csv`. Append
  `| HH:MM` to a line for a delivery deadline.
- **Coordinate aliases** — for addresses Google can't resolve: pair the
  address text with a `lat,lng` or a corrected address. Persisted in
  `data/aliases.json`, matched approximately (typos/word-order
  tolerant) on reuse.
- **Walk-only addresses** — mark stops with no van access. Optionally
  add a parking point (`lat,lng`); the leg then splits into drive-to-park
  + walk-to-door. Persisted in `data/blocked.json`.
- **Delivery time windows** — a saved default `| HH:MM` per address, so
  it doesn't need retyping every route. An inline deadline on the
  address line always overrides this.
- **Calculate** → distances, times, arrival times.
- **Reorder** → runs the optimizer (below), up to 500 addresses.
- **Share / export** — per-stop share links, CSV/TXT/JSON export, QR
  code hand-off to another device (see [QR sharing](#qr-code-sharing)).
- **Schedule** — start time + break + per-stop dwell time drive the
  arrival-time and deadline calculations.
- **Fuel estimate** (export only) — `distance × 11 L/100km ×
  price/L`, using a per-country diesel price table
  (`FUEL_PRICE_BY_COUNTRY` in `server.js`) selected by geolocating the
  requester's IP (`ip-api.com`, free tier). Indicative only.

#### Route optimization

A heuristic solve for the [Traveling Salesman
Problem](https://en.wikipedia.org/wiki/Travelling_salesman_problem):
exact TSP is factorial-time, so instead:

1. **Cost matrix** — N×N driving/walking durations between every pair
   (the expensive step; cached — see [Caching](#caching)).
2. **Nearest-neighbor construction** — greedy initial route.
3. **2-opt refinement** — iteratively reverses segments while it
   reduces total time, until no improving swap remains.

The first stop (and the last, on a round trip) is fixed through both
steps. Walk-only pairs use walking-mode duration in the matrix, so the
optimizer doesn't route the van somewhere it can't go. Optimization
targets **time**, not distance.

With `| HH:MM` deadlines and a start time set, the cost function adds a
heavy per-minute-late penalty (a simplified [VRP with Time
Windows](https://en.wikipedia.org/wiki/Vehicle_routing_problem)) — this
reduces lateness but doesn't guarantee zero, since some deadline sets
are simply infeasible for one vehicle. The result reports which stops,
if any, are still late and by how much.

### Video → Address

Extracts addresses from a screen recording or photo of a delivery
app's stop list.

1. Upload video (`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`) or photo.
2. Extract → each result gets an OCR-confidence tag (`high`/`medium`/`low`,
   based on repeat readings across frames) and a Google-validation tag
   (`confirmed`/`not confirmed`).
3. Copy or add to the Route tab, individually or all at once.

**Reading engines:**

| | Local (default) | AI (Claude) |
|---|---|---|
| Requires | `tesseract` only | `ANTHROPIC_API_KEY` + internet |
| Cost | Free | ~1 request per 8 frames + 1 consolidation call |
| Extracts | address, stop number, recipient name | address only |
| Accuracy | Good | Generally higher, cross-frame context |

Frame rate is configurable (1/2/3 fps). Local engine samples up to 40
frames per video; AI engine up to 200, sampled uniformly if the video
has more. If the AI consolidation call fails, results fall back to
simple deduplication rather than being discarded.

Uploaded files and extracted frames are written to a system temp
directory and deleted after each request. File size limit: 500MB
(`multer` config in `server.js`).

### Fix Addresses

Batch-validates a list against the Geocoding API before it's used in a
route. Each address is classified `confirmed` / `suggested correction`
/ `not precise enough` / `not found`. Corrections can be accepted
individually, in bulk, or edited by hand. Up to 300 addresses per
check, 5 concurrent requests to Google.

"Not precise enough" results are never auto-applied — accepting one
would silently point the route at a village center instead of the
correct door.

## Geocoding: swisstopo (free) + Google

Controlled by `GEOCODING_SOURCE` in `.env`:

| Value | Behavior | Cost |
|---|---|---|
| `auto` (default) | swisstopo first, Google as fallback | Free for resolvable Swiss addresses |
| `swisstopo` | swisstopo only | Free; non-Swiss addresses fail |
| `google` | Google only | All lookups billable |

For every address: try swisstopo's address search (free, no key,
official Swiss government data) first; if it returns a precise
street-level match, done — Google is never called. Otherwise, fall
through to the existing Google chain (Geocoding API → Places
fallbacks). This applies everywhere geocoding happens (aliases, Fix
Addresses, deadlines list, share links, OCR extraction) via one shared
`geocodeAddressBest` function — no per-feature toggle needed, and
Swiss/non-Swiss addresses can be mixed freely in the same list.

Caveats: no `place_id` equivalent (share links use raw coordinates
instead), only one candidate per search (no fallback chain on a
swisstopo miss), Swiss data only. Switching `GEOCODING_SOURCE` doesn't
invalidate the cache — each source's results are cached separately.

Docs: <https://docs.geo.admin.ch/access-data/search.html>. See the
`swisstopo` counter in the [API log](#google-api-request-log) for how
many lookups this saves in practice.

## Self-hosted routing: OSRM

Distance Matrix is usually the largest line item on the Google bill
(optimization needs every pair, n² not n). [OSRM](https://project-osrm.org/)
runs the same computation yourself, on OpenStreetMap data, for free.
Switch with `ROUTING_SOURCE=osrm`.

| | Google Distance Matrix | Self-hosted OSRM |
|---|---|---|
| Cost | ~$5 / 1,000 elements | Free, unlimited |
| Live traffic | Yes | No — speed-limit estimates only |
| Map freshness | Always current | As current as your extract |
| Setup | None | You run and maintain the server |
| Profiles | driving + walking, one API | One profile per instance |

### Docker setup (example: Switzerland)

```bash
mkdir -p switzerland
wget -P switzerland https://download.geofabrik.de/europe/switzerland-latest.osm.pbf

docker run -t -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/switzerland-latest.osm.pbf
# Extract needs ~4-6 GB of RAM for Switzerland and dies (sometimes just
# "Killed") without it — check it finished before going on:
ls switzerland/switzerland-latest.osrm.ebg
# No "switzerland-latest.osrm" file is created on current OSRM versions
# (only .osrm.*) — the next two commands still take that name, on purpose.
docker run -t -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-partition /data/switzerland-latest.osrm
docker run -t -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-customize /data/switzerland-latest.osrm

docker run -d -p 5000:5000 -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld /data/switzerland-latest.osrm
```

```
ROUTING_SOURCE=osrm
OSRM_URL=http://localhost:5000
```

```bash
# sanity check — OSRM wants lon,lat, the reverse of most APIs
curl "http://localhost:5000/route/v1/driving/7.4474,46.9481;8.5417,47.3769?overview=false"
```

Other regions: <https://download.geofabrik.de/> — only download the
area you actually operate in.

**Walking legs** need a second instance built with `-p /opt/foot.lua`
on another port, set via `OSRM_URL_WALKING`. Without it, walk-only
legs keep using Google.

If OSRM is unreachable, requests fall back to Google automatically
(logged as `OSRM falhou...`) rather than blocking the route.

## Map + dynamic road exclusion (Valhalla)

Once a route is calculated, the map view ("🗺️ Mapa") renders it on
[MapLibre GL JS](https://maplibre.org/) and lets you mark a stretch as
blocked (🚧 **Bloquear via**) — roadworks, a closed street, restricted
access. This is a real exclusion applied to the routing graph, not a
visual-only change: the next calculation avoids it and re-optimizes the
stop order around it, then shows the distance/time difference against
the previous route before you accept it.

Three ways to pick the segment:

| Mode | How |
|---|---|
| Click the route | One click on the drawn line blocks the whole leg (stop → stop) it belongs to |
| Pick stops | Choose "from stop / to stop" in a dropdown, no map clicking |
| 2 points on the map | Two free clicks — the only one that can cut mid-leg |

Each block gets a duration: **today**, a **specific date**, a **date
range**, or **for ever**. Blocks are stored in
`data/road-restrictions.json`, so a "for ever" one survives a restart,
and a scheduled one starts and stops applying on its own — nothing is
swept on a timer, a block outside its window is simply not applied.
**↩️ Reverter bloqueio** removes the most recent block and puts the
original route back, including the stop order it had changed.

Uses [Valhalla](https://valhalla.github.io/valhalla/), separate from
OSRM, because it supports excluding an arbitrary polygon per request
(`exclude_polygons`) with no shared state — needed for a
preview/compare/cancel flow. OSRM has no equivalent and keeps handling
address-list optimization unaffected.

### Keeping the map data current

The extract is a snapshot. Roads get built, closed, renamed and
re-numbered, and a graph built months ago will route a van down a street
that no longer goes through. Geofabrik republishes daily:

```bash
./update-maps.sh --check   # is there a newer extract? (exit 2 = yes)
./update-maps.sh           # download it and rebuild both engines
```

It builds into `switzerland/.update/` first and only swaps the live files
in once the new graph has answered a real route request — so a failed or
interrupted rebuild leaves the running router untouched. The data it
replaces is kept until the end (`--keep-old` to keep it for good). A full
rebuild needs ~4 GB free and takes tens of minutes; the app keeps serving
from the current graph throughout.

`segment-speed-overrides.csv`, if you have one, is carried into the new
graph — it is hand-made data the rebuild cannot regenerate.

Other flags: `--yes` (never ask, for cron), `--osrm-only`,
`--valhalla-only`, `--url` for a different region.

A monthly cron entry:

```cron
0 4 1 * * cd /path/to/route-tracker && ./update-maps.sh --yes >> /tmp/route-tracker-update.log 2>&1
```

### Docker setup (reuses the OSRM `.osm.pbf`)

```bash
docker run -d --name valhalla -p 8002:8002 \
  -v "${PWD}/switzerland:/custom_files" \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
```

First run builds Valhalla's tiles from the `.osm.pbf` (a few minutes).
`./update-maps.sh` rebuilds them the same way when the extract changes.

```
VALHALLA_URL=http://localhost:8002
```

```bash
curl -X POST http://localhost:8002/route -H "Content-Type: application/json" \
  -d '{"locations":[{"lat":46.9481,"lon":7.4474},{"lat":47.3769,"lon":8.5417}],"costing":"auto"}'
```

Without `VALHALLA_URL`, the map section stays hidden; nothing else is
affected.

Restart after a reboot with `docker start valhalla` (instant — tiles
already built). If the container was removed, re-run the `docker run`
command above.

### How much road you can block

Valhalla refuses a request whose `exclude_polygons` exceed a total
circumference — `service_limits.max_exclude_polygons_length`, 10km by
default — **summed across every polygon**, not per polygon. A blocked
segment is buffered 12m to each side, so its perimeter is roughly twice
its length: the real budget is about **5km of blocked road in total,
across all active blocks**.

Two things keep requests inside it:

- Each block covers at most `MAX_BLOCK_SEGMENT_METERS` (default 1000) of
  road, centred on where you clicked. Picking a whole stop-to-stop leg
  blocks the middle kilometre of it rather than all 40 — the road is
  equally impassable either way, and the panel tells you when it trimmed.
- When saved blocks still don't all fit, the newest are applied and the
  rest are reported as not applied, instead of letting Valhalla reject
  the whole request (which would break plain routing too, not just
  blocking).

If you raise the limit in your own Valhalla config, raise
`VALHALLA_MAX_EXCLUDE_CIRCUMFERENCE` (and optionally
`MAX_BLOCK_SEGMENT_METERS`) in `.env` to match.

**Current scope:** not yet implemented — a "penalty" mode (a road that's
merely expensive rather than fully blocked) and multi-level undo. Each
block can still be removed individually from the active-blocks list
under the map.

## Caching

Geocoded addresses and leg distances/times are cached to disk
automatically — no action needed. Reuse happens per-address and
per-leg, not all-or-nothing: adding one address to an already-optimized
list only requests what involves that address.

| | TTL | Config |
|---|---|---|
| Geocoded addresses | 365 days | `GEOCODE_CACHE_TTL_DAYS` |
| Distances/times | 90 days | `DISTANCE_CACHE_TTL_DAYS` |

Entries aren't actively swept — an expired entry is simply re-fetched
and replaced on next use; nothing is deleted on a timer. Stored in
`data/geocode-cache.json` and `data/distance-cache.json` (gitignored).

```bash
curl http://localhost:3000/api/cache-stats
curl -X DELETE http://localhost:3000/api/cache
curl -X DELETE http://localhost:3000/api/cache -H "Content-Type: application/json" -d '{"type":"geocode"}'
curl -X DELETE http://localhost:3000/api/cache -H "Content-Type: application/json" -d '{"type":"distance"}'
```

(Requires an authenticated session if `APP_PASSWORD` is set.)

## Updating safely: rollback for code AND data

Two different things can break after an update, and they need two
different safety nets.

**Code** — git. Tag the version you're running whenever it's known good,
so getting back to it is one command:

```bash
git tag v1.4          # right after you start a version that works
# ... later, an update misbehaves:
git checkout v1.4     # back to the known-good code
# restart the server
```

Commit each finished feature on its own; `git revert <commit>` then rolls
back just that feature while keeping the rest.

**Data** — `data/` is gitignored on purpose (it's yours, not the app's),
so a code rollback never touches it. That cuts both ways: a newer version
may have changed a file's shape, and the older code then misreads it. So
snapshot the data before every update, and restore it if you roll back:

```bash
npm run backup                   # snapshot -> backups/data-YYYY-MM-DD_HHMMSS/
npm run backup:list              # what's there
npm run backup:restore -- NAME   # put a snapshot back (stop the server first)
```

`backup` keeps the newest 20 snapshots (`BACKUP_KEEP` in `.env`) and
writes them next to the project (`BACKUP_DIR` to move them, e.g. onto
another disk). `restore` first snapshots the current state, so restoring
the wrong one is itself undoable. Both honour `DATA_DIR`.

The routine, then: `npm run backup` → `git tag` → update → restart. If
anything's wrong: `git checkout <tag>` → `npm run backup:restore -- <name>`
→ restart.

## Capacity: what the server copes with, and the knobs

Measured, not guessed — the full analysis and the roadmap to
multi-vehicle are in [`docs/ESCALABILIDADE.md`](docs/ESCALABILIDADE.md).

- **Stops per route:** capped at 250 (`MAX_OPTIMIZE_STOPS` in `.env`).
  The optimizer is O(n²) per pass — ~0.1 s at 100 stops, 1-3 s at 200,
  17-74 s at 500 — so the cap is there to keep a single request from
  hogging the optimizer worker for everyone else.
- **The optimizer runs in a worker thread** (`src/optimizerPool.js`), so
  a long optimization never freezes the server for other users: during a
  3.5 s optimize of 240 stops, other requests are still answered in
  ~2 ms. One worker by default; `OPTIMIZER_WORKERS=2` if the machine has
  cores to spare and dispatchers really do optimize at the same moment.
- **Data files are written atomically** (temp file + rename) and cache
  writes are coalesced (`CACHE_SAVE_DEBOUNCE_MS`, default 500 ms, always
  flushed before a response goes out and on shutdown). A crash or power
  cut mid-write leaves the previous file intact instead of a truncated
  JSON — which, for the caches, used to mean every geocode and leg ever
  paid for was gone.
- **Data volume:** JSON files are read/rewritten whole; comfortable up to
  ~10 000 entries per list. Beyond that (or for multi-vehicle work at
  all), the next step is SQLite — see the doc.

## Fuel price (section 08, exports)

The fuel cost line in CSV/TXT exports uses a price per litre that comes
from the first of three sources that works:

1. **Live** — the French government's open station-price feed
   (every French station reports its own prices, refreshed every 10
   minutes, no key). The server averages the diesel price of the
   stations nearest the route's starting point and converts EUR to
   `FUEL_CURRENCY` at the ECB reference rate (Frankfurter, also keyless).
   Switzerland has no equivalent public feed — from the Valais the nearest
   French stations (Chamonix / Abondance, ~35–45 km) are the closest thing
   to a real, current local price.
2. **Manual** — the fallback price and the van's consumption typed into
   section 08 of the sidebar (saved to `data/fuel-settings.json`). Used
   whenever the live lookup fails: no network, no station within range,
   FX service down.
3. A static per-country table in `server.js`, as a last resort.

Section 08 always shows which source is in effect. Both external calls
are cached (prices 1 h, FX rate 24 h). Nothing needs configuring; the
defaults can be overridden in `.env`:

```bash
FUEL_CURRENCY=CHF          # what the estimate is shown in; EUR skips the conversion
FUEL_PRICE_RADIUS_KM=80    # how far from the route's start to look for French stations
FUEL_PRICE_STATIONS=10     # how many of the nearest stations to average
FUEL_PRICE_API_URL=https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records
FUEL_FX_API_URL=https://api.frankfurter.dev/v1/latest
```

## QR code sharing

Every export (route, address list, Fix Addresses list) has a 📱
button: uploads the content to this server, returns a short-lived link
+ QR code. Scanning opens the link on another device with no login
required — the link's random token is what protects it. Content is
held in memory only, for 30 minutes or until opened.

**Reachability:** the link must use an address the *other* device can
reach, not `localhost` (which resolves to the scanning device itself).
If you loaded the app via `localhost`/`127.0.0.1`, the server
auto-substitutes its own LAN IP when building the link. If that guess
is wrong (common on a VM with multiple network adapters), set it
explicitly:

```
SHARE_HOST=192.168.1.100:3000
```

Find your actual LAN IP with `ip addr` / `hostname -I` (the interface
bridged to your LAN, not `docker0`/`vboxnet`/`virbr`). If the QR still
fails to connect, check in order: the firewall on the server machine
(`sudo ufw allow 3000/tcp`), that both devices share a network (not
mobile data), and — on a VM — that the network adapter is **Bridged**,
not NAT-only.

## Driver app (PWA): stable HTTPS access from a phone

The 📱 **"Partilhar com condutor"** button on the map screen creates a
24h-lived, trackable route (see `src/routeShares.js`) and opens it in an
installable PWA at `/pwa/` — the driver scans the QR once, adds it to
their home screen, and uses it offline all day (see `public/pwa/`).
Two things make this different from the plain QR-export sharing above,
and both come with a real constraint:

- **The QR scanner needs the camera.** Browsers only grant camera access
  (`getUserMedia`) on a "secure context" — HTTPS, or `localhost` itself.
  Opening the app over plain `http://<lan-ip>:3000` from a phone (fine
  for everything else in this README) will **not** let the driver scan
  a QR code at all.
- **IndexedDB is bound to the origin** (scheme + hostname + port) —
  everything the PWA stores (the route, delivery statuses, the pending
  sync queue) lives under whatever hostname the driver first opened the
  app from. Change that hostname later and every phone's local data
  becomes unreachable — not corrupted, not lost from the server (route
  shares themselves live in `data/route-shares.json`), just invisible to
  the app that wrote it, because a browser never lets one origin read
  another's storage.

**The hostname the driver installs the app under has to be stable from
day one.** Don't pick something you plan to change later (a temporary
LAN IP, a router's dynamic DNS you might swap, an ngrok URL that
rotates on every restart). [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
gives a free, fixed `.ts.net` hostname with automatic HTTPS, with no
domain purchase required — a good default for exactly this constraint.

### Setting it up

1. Install Tailscale on the machine running this server and join your
   tailnet: <https://tailscale.com/download>, then `tailscale up`.
2. In the [admin console](https://login.tailscale.com/admin/settings/general),
   enable **HTTPS Certificates** and **Funnel** for your tailnet
   (one-time, account-level settings — Funnel is off by default).
3. Expose this app's port (`PORT` in `.env`, default `3000`) publicly,
   keeping it running in the background:

   ```bash
   sudo tailscale funnel --bg 3000
   ```

4. Check the assigned hostname and that Funnel is actually serving it:

   ```bash
   tailscale funnel status
   ```

   You'll get something like `https://your-machine.your-tailnet.ts.net`
   — that HTTPS URL, on port 443, is what Funnel forwards to your local
   port 3000. **This is the hostname every driver's phone should use,
   for as long as this app runs** — bookmark it, don't rediscover it.

5. Set it explicitly as `SHARE_HOST` in `.env`, so every generated QR
   link uses it instead of the LAN-IP auto-detection meant for the
   same-network case above:

   ```
   SHARE_HOST=your-machine.your-tailnet.ts.net
   ```

Funnel terminates HTTPS itself and forwards plain HTTP to your local
`PORT` — nothing else in this app needs to change. `tailscale funnel
status` and `tailscale funnel --bg 3000` are also how you check it's
still running and restart it after a reboot (Tailscale itself normally
survives a reboot once enabled as a service; Funnel's exposure does not
restart on its own on every platform — check `tailscale funnel status`
after rebooting the server machine).

### Migrating to your own domain later

If you outgrow the `.ts.net` hostname and move to a real domain
(`entregas.example.com`, fronted by Tailscale Funnel, a reverse proxy,
or anything else), that is, from the browser's point of view, a
**completely different origin** — every driver's phone starts with
empty IndexedDB under it, exactly as if they'd never scanned a QR
before. There is no automatic way to carry that local data across a
hostname change; plan around it instead of trying to migrate it:

- **Do it between routes, not mid-route.** Let every driver finish
  their current day (or at least sync their last pending marks —
  the "N por sincronizar" badge should read 0) under the old hostname
  before switching.
- **The server-side data survives regardless.** A route share's stops
  and statuses already synced live in `data/route-shares.json`, not in
  the browser — switching hostnames doesn't touch that. What's lost is
  only whatever a phone had marked locally but not yet synced, plus the
  convenience of the already-installed home-screen icon.
- **Re-onboarding is just a re-scan.** A driver on the new domain gets
  a fresh install by scanning a new QR code (or opening a fresh
  `/pwa/?token=...` link) generated from the new hostname — the app
  doesn't need any special "migration mode".
- Update `SHARE_HOST` to the new hostname and re-issue Tailscale
  Funnel/your reverse proxy against it before generating any new route
  shares, so the QR codes you hand out already point to where you're
  moving to, not where you're moving from.

## Google API request log

Tracks request counts per API (Geocoding, Distance Matrix, Places Text
Search, Places Autocomplete), daily and lifetime — cache hits aren't
counted, since they never reach Google. Distance Matrix is counted in
**elements** (origins × destinations), matching how Google bills it.

```bash
curl http://localhost:3000/api/api-log
curl -X DELETE http://localhost:3000/api/api-log   # reset counters
```

Includes an `estimatedCost` based on Google's published list prices
(not a real bill): `lifetime` ignores the monthly free quota
(worst-case ceiling), `thisMonth` subtracts it (closer to the actual
invoice). Prices are hardcoded in `API_PRICING` in `server.js` — update
there if Google changes them.

Stored in `data/api-request-log.json`, debounced writes (a couple of
seconds lag under heavy request bursts).

## How key protection works

The browser never talks to Google directly — it calls this server's
own `/api/*` endpoints, which hold `GOOGLE_MAPS_API_KEY` server-side.
The key never appears in HTML, browser JS, or dev tools. To deploy
(Render, Railway, Fly.io, etc.), just set the env var in the host's
settings.

For production, also restrict the key by IP in Google Cloud Console
(the IP of the server running it).

## Where everything comes from

Downloads and documentation for every moving part, so a future update
doesn't start with a search.

### Map data

| | |
|---|---|
| Geofabrik extracts (the `.osm.pbf`) | https://download.geofabrik.de/ |
| — Switzerland, the default here | https://download.geofabrik.de/europe/switzerland.html |
| OpenStreetMap (the source data, and where to fix a wrong road) | https://www.openstreetmap.org/ |
| How to edit OSM | https://wiki.openstreetmap.org/wiki/Beginners%27_guide |

A wrong or missing road is fixed in OpenStreetMap itself; it reaches the
routing engines on the next `./update-maps.sh` after Geofabrik picks it
up (a day or two).

### Routing engines

| | |
|---|---|
| OSRM — project site | https://project-osrm.org/ |
| OSRM — HTTP API reference | https://project-osrm.org/docs/v5.24.0/api/ |
| OSRM — source and issues | https://github.com/Project-OSRM/osrm-backend |
| OSRM — Docker image used here | https://github.com/Project-OSRM/osrm-backend/pkgs/container/osrm-backend |
| Valhalla — documentation | https://valhalla.github.io/valhalla/ |
| Valhalla — API reference | https://valhalla.github.io/valhalla/api/ |
| Valhalla — source and issues | https://github.com/valhalla/valhalla |
| Valhalla — Docker image used here (gis-ops) | https://github.com/gis-ops/docker-valhalla |

The two exist side by side on purpose: OSRM does the distance matrix for
optimization, Valhalla does the map view and road blocking
(`exclude_polygons`). See the sections above for why.

### Geocoding

| | |
|---|---|
| swisstopo — free Swiss geocoder used first | https://api3.geo.admin.ch/services/sdiservices.html#search |
| Google Geocoding API | https://developers.google.com/maps/documentation/geocoding |
| Google Distance Matrix API | https://developers.google.com/maps/documentation/distance-matrix |
| Google Cloud console (keys, quotas, billing) | https://console.cloud.google.com/google/maps-apis |

### Video → Address

| | |
|---|---|
| Anthropic API (the Claude engine) | https://docs.claude.com/en/api/overview |
| Anthropic console (keys, usage) | https://console.anthropic.com/ |
| Tesseract OCR (the offline engine) | https://github.com/tesseract-ocr/tesseract |
| Tesseract language data | https://github.com/tesseract-ocr/tessdata |
| FFmpeg (frame extraction) | https://ffmpeg.org/documentation.html |

### Map rendering

| | |
|---|---|
| MapLibre GL JS | https://maplibre.org/maplibre-gl-js/docs/ |
| Turf.js (the geometry used for road blocking) | https://turfjs.org/ |
| Turf.js — source and issues | https://github.com/Turfjs/turf |

## Tests

```bash
npm test
```

37 tests, ~15s, no network access or API key needed — Google, swisstopo,
and OSRM are all replaced by deterministic mocks injected via `node
--require` (not by editing source), so the suite runs against
unmodified server code and survives files being split/moved.

Covers: hybrid geocoding/routing source selection and fallback,
cache-key correctness, optimizer invariants (fixed endpoints, no
lost/duplicated stops), deadline-aware reordering and honest lateness
reporting, login hardening, share-link access control, cost-accounting
correctness, and frontend integrity (assets load, JS parses, all
translations complete).
