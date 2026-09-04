# Route Tracker Híbrido — server-backed version (protected key)

Web interface for calculating distance, time, and schedule for a delivery
route. The Google Maps API key lives on the server (`.env`), never sent
to the browser.

> © 2026 André Soares. All rights reserved. See `LICENSE`.

## 1. System prerequisites (only for "Video → Address")

The "Video → Address" tool uses two programs installed directly on the
operating system (not npm packages) — lighter and much faster than the
JavaScript alternatives:

```bash
# Ubuntu/Debian (including your VM)
sudo apt-get update
sudo apt-get install -y ffmpeg tesseract-ocr tesseract-ocr-por tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ita

# macOS (Homebrew)
brew install ffmpeg tesseract tesseract-lang

# Verify they got installed
ffmpeg -version
tesseract --version
```

If you don't install this, the rest of the app ("Route" and "Fix
Addresses" tabs) keeps working normally — only the "Video → Address" tab
will error out when you try to process a file.

## 2. Install the npm dependencies

```bash
cd route-web-server
npm install
```

This installs `express`, `dotenv`, `multer`, `express-session`, and the
`@anthropic-ai/sdk` — light and fast (a few MB). You don't need anything
heavier as long as you have `ffmpeg` and `tesseract` installed on the
system, as above.

## 3. Configure the key

```bash
cp .env.example .env
```

Open `.env` and fill in your key:

```
GOOGLE_MAPS_API_KEY=your_key_here
PORT=3000
```

Your key needs the following APIs enabled in the Google Cloud Console:
- **Distance Matrix API** — distance and time calculations
- **Geocoding API** — address validation, aliases, sharing, "Fix Addresses"
- **Places API** — fallback used when the Geocoding API can't find an
  address precisely (see note below); without it enabled, the app still
  works, just without that extra fallback

Optionally, if you want to use the "AI" reading engine in the "Video →
Address" tab (more accurate than the local engine, see section 8), also add:
```
ANTHROPIC_API_KEY=sk-ant-your_key_here
```
Without this, the app still works — only the "Local" engine will be
available in that tab.

The `.env` is already in `.gitignore`, so it will never end up on
GitHub if you publish the rest of the code.

## 4. Protect the app with a password (recommended)

Without this, **anyone with the server's address can use the app** —
including burning through your Google API quota without you knowing.
To enable login, add to `.env`:

```
APP_PASSWORD=choose_a_strong_password
SESSION_SECRET=a_long_random_string_here
```

- **`APP_PASSWORD`** — the password you'll use to log in. Pick one you
  don't use anywhere else.
- **`SESSION_SECRET`** — used to sign the session cookie. You can
  generate a strong random value with:
  ```bash
  openssl rand -hex 32
  ```
  If you don't set this, the app still works, but it generates a new
  secret every time it restarts — which forces you to log in again
  every time you restart the server.

Once `APP_PASSWORD` is set, start the server and you'll be asked for the
password before you can use any part of the app (including every
`/api/*` endpoint). The session lasts 30 days — you don't need to log in
every day. To log out, go to `/logout`.

If you leave `APP_PASSWORD` unset, the app keeps working without asking
for a login (as it did before this feature existed) — but a warning
shows up in the terminal to remind you of that every time you start the
server.

**Extra protection included:** after 5 failed attempts in a row from the
same IP, that IP gets blocked for 15 minutes, to make it harder to guess
the password.

**Note on someone "stealing" the app:** this protects *access to the
running app*. It doesn't stop someone from copying the project files if
they have direct access to them (e.g. if you share the folder or the
repository). For that, the protection is organizational, not technical:
don't publish the code in a public repository, and you can add a
copyright notice to the project if you want to make clear it's not free
to use.

## 5. Start it up

```bash
npm start
```

Open your browser at **http://localhost:3000**

## 6. Language

There's a language selector in the top-right corner: Português, English,
Français, Deutsch, Italiano. The choice is saved in the browser (not
shared between users). Error messages coming from Google (e.g.
`ZERO_RESULTS`) are also automatically translated.

## 7. Usage

1. **Start/end point** (optional) — if your route is normally a "round
   trip" to the same place (e.g. a warehouse), write the address here
   once. It's automatically used as the first *and* last stop — no need
   to write it twice in the address list. Saved in the browser so you
   don't have to re-type it every time.
2. **Addresses** — paste the list or upload a `.txt`/`.csv`, one per
   line, in visiting order (the stops in between, not counting the
   start/end point above). Below the box: **"Clear"** empties the list
   (and the calculated results); **"Fix Addresses"** sends a copy of the
   list to the "Fix Addresses" tab, *appended* after whatever is already
   there (rather than overwriting it — handy when you're combining
   addresses from more than one source); and a format selector (CSV,
   TXT, or JSON) next to **"Export addresses"** downloads just the raw
   address list — no distances, times, or totals, unlike the full route
   export in point 8 below.

   **Deadlines** — if a stop needs to be reached by a certain time, add
   `| HH:MM` at the end of that line, e.g.:
   ```
   Warehouse, City
   Client A, City | 10:00
   Client B, City
   Client C, City | 12:00
   ```
   This only affects that one line — addresses without a `|` suffix have
   no deadline. See point 6 (optimization) and point 9 (schedule) below
   for what the app actually does with these.
3. **Coordinate aliases** — if an address isn't recognized, write its
   exact text under "address text" (or pick it from the selector, to
   avoid typos), and in the second field write **either** a GPS
   coordinate in `latitude,longitude` format (e.g. `38.7223,-9.1393`)
   **or** a normal address in text (e.g. `New Street 5, Riddes`) — in
   that case it's automatically geocoded and saved already as
   coordinates, once confirmed that Google recognizes it. Saved in
   `data/aliases.json` on the server — survive server restarts and page
   reloads. The tool also recognizes the same address even if it's not
   written exactly the same way next time (small differences in
   punctuation, capitalization, word order) — when it's an approximate
   match, the "GPS alias (approx.)" tag shows up instead of "GPS alias".
   With many saved aliases, use the search box above the list to
   quickly find what you need — the list has its own scroll instead of
   growing endlessly.
4. **Walk-only addresses** — to mark places where the delivery is made on
   foot (narrow street, rooftop, dirt road, no van access), write the
   address and, optionally, the reason. Saved in `data/blocked.json` on
   the server, with the same approximate matching as aliases.

   If you know where the van can park near that address, also fill in
   the **parking point** (GPS coordinates). In that case, the leg
   automatically splits into two parts: 🚗 driving to the parking spot +
   🚶 walking to the door — much more realistic than walking the entire
   distance between two stops. Without a defined parking point, the
   whole leg is calculated on foot (a less precise fallback, but
   functional). A warning shows up listing which addresses are affected.
5. **Delivery deadlines** — for regular clients with a fixed delivery
   window (e.g. always by 10:00), pick the address from the list (or
   type it) and set a time. Saved in `data/delivery-times.json` on the
   server, with the same approximate matching as aliases and walk-only
   addresses — so you don't need to retype `| HH:MM` in the address box
   (point 2) every single time that address comes up in a route. If a
   line in the address box *does* have its own inline `| HH:MM`, that
   always overrides whatever's saved here for that address — the inline
   one is more specific to that particular route.
6. **Calculate route** — click to see the times and distances.
7. **Reorder route** — after calculating, a button appears at the end of
   the results to automatically reorder out-of-place addresses into the
   fastest sequence. The first address always stays as the starting
   point — and, if you've set a start/end point, the last one also
   stays fixed (round trip). Clicking recalculates everything on its own
   with the new order. Supports up to 500 addresses per optimization —
   this limit is tighter than the plain calculation (see the note on
   caching below) because the optimization needs the distance between
   **every pair** of addresses (n², not n).

   ### How route optimization works

   This is a variant of the [Traveling Salesman
   Problem](https://en.wikipedia.org/wiki/Travelling_salesman_problem) —
   finding the shortest possible route that visits every stop exactly
   once isn't something that can be solved exactly for anything but a
   small number of stops (the number of possible orderings explodes
   factorially). Instead, the app uses a fast heuristic that gets close
   to optimal in a fraction of a second, even for a few hundred stops:

   1. **Build the cost matrix.** The server asks Google for the driving
      (or walking, for legs involving a walk-only address — see below)
      duration between every pair of addresses, and assembles it into an
      N×N matrix. This is the expensive part, cost- and time-wise —
      it's also the part that benefits the most from the
      [persistent cache](#persistent-cache-saves-money) on repeat runs.
   2. **Nearest-neighbor construction.** Starting from the first address
      (always fixed), the algorithm repeatedly jumps to whichever
      unvisited stop is closest in time, building a route greedily one
      stop at a time. Fast, but on its own this can leave an obviously
      "silly" route in some cases (e.g. it might visit a nearby stop
      late because a closer one was picked first at an earlier step).
   3. **2-opt improvement pass.** The route from step 2 is then refined
      with [2-opt](https://en.wikipedia.org/wiki/2-opt): repeatedly try
      reversing a segment of the route, and keep the reversal if it
      makes the total time shorter. This is the step that untangles the
      "crossed paths" nearest-neighbor tends to produce, and it runs
      until no more improving swap can be found.

   The **first stop** is never moved by either step. If you have a
   start/end point set (round trip), the **last stop** is fixed too —
   both nearest-neighbor and 2-opt are constrained to leave it in the
   last position, so the loop out and back to base stays intact.

   **Walk-only addresses** are handled specially: the cost matrix used
   for optimization is *mixed* — for any pair of stops where either one
   is marked walk-only, the walking-mode duration is used for that cell
   instead of the driving one, so the algorithm doesn't try to
   "optimize" a route as if the van could drive somewhere it can't.

   The optimizer minimizes **time**, not distance — two routes with the
   same total kilometers can take very different amounts of time
   depending on roads and speed limits, and time is what actually
   matters for scheduling a workday.

   This whole process (matrix + nearest-neighbor + 2-opt) is what's
   behind the *n² not n* limitation mentioned above — building the cost
   matrix is the one part of the app that genuinely can't scale past a
   few hundred stops without becoming slow and expensive, which is why
   optimization has a tighter cap (500) than plain route calculation.
   Just calculating a route you've already put in order doesn't have a
   hard-coded limit in the code, since it only needs one distance per
   consecutive leg (n, not n²) — for a very long list, that just means
   more sequential requests the first time through, which the
   [persistent cache](#persistent-cache-saves-money) then makes free on
   every recalculation after that.

   ### Delivery deadlines

   If some stops have a `| HH:MM` deadline (point 2 above) and a start
   time is set (point 9 below), both the plain calculation and the
   optimizer become deadline-aware:

   - **Plain calculation** just reports reality: each stop shows its
     estimated arrival time, and if that's after its deadline, a red
     "⚠ X min late" warning shows up next to it. It doesn't try to fix
     anything — this is what happens with the addresses in the order
     you gave them.
   - **Optimization** actively tries to avoid lateness, not just
     minimize total distance. This is a simplified take on the [Vehicle
     Routing Problem with Time
     Windows](https://en.wikipedia.org/wiki/Vehicle_routing_problem) —
     genuinely solving that exactly is a much harder problem than plain
     TSP, so the app uses a practical heuristic instead of an exact
     solver: both the nearest-neighbor construction and the 2-opt pass
     use a cost function that adds a heavy penalty for every minute a
     stop would arrive past its deadline — heavy enough that avoiding
     lateness always wins over a shorter route, but ties among equally
     late (or equally on-time) options still favor less driving.

   **This doesn't guarantee every deadline gets met.** If the deadlines
   are simply too tight for one vehicle to reach every stop on time —
   not enough hours in the day, or two urgent stops too far apart — no
   reordering fixes that, and the app doesn't pretend otherwise: after
   optimizing, it reports exactly which stops (if any) are still going
   to be late and by how many minutes, both in the status message and
   in the individual stop's warning after recalculating. Take that as a
   sign to reconsider the deadlines, the start time, or split the
   addresses across more than one vehicle/route — not something the
   algorithm can solve by trying harder.
8. **Share / copy** — every stop has a share button. If the address has a
   GPS alias, it uses that coordinate directly; otherwise, the server
   asks Google for the exact location (geocoding) and uses it to build
   the link — much more precise than a plain text search. Copies
   automatically and, on supported devices, also opens the native share
   menu.
9. **Export route** — after calculating, two buttons appear (⬇ CSV, ⬇
   TXT) to download the route with distances, times, and totals — handy
   for printing or sharing outside the tool. This full route export
   includes the exact date and time it was generated as its first line.
   The address-only export (point 2 above) and the "Fix Addresses"
   export (section 9) are plain address lists instead — no timestamp
   line mixed into the content, so they're clean to re-import elsewhere
   (the timestamp still shows up in the filename, e.g.
   `addresses_2026-08-23_1620.csv`).

   All exports try to open the browser's native "Save As" dialog first,
   so you can pick the exact filename and folder yourself. This needs
   **both**: a Chromium-based browser (Chrome, Edge — not supported on
   Firefox or Safari, even on localhost) **and** a secure context (the
   page loaded over `https://`, or over `http://localhost`
   specifically — if you're opening the app from another device on your
   network using its local IP, e.g. `http://192.168.1.50:3000`, that's
   plain HTTP on a non-localhost address, which browsers don't treat as
   secure). Neither of these can be worked around from the app's code —
   they're browser rules. When the dialog isn't available, the app
   falls back to a regular download (the browser decides the folder,
   usually Downloads) and shows a message that says exactly which of
   the two reasons applies, instead of a generic "something went wrong".
10. **Schedule** — start time, break, and time per stop; the arrival time
   shows up automatically, both in the totals and after each individual
   leg. The **start time specifically is what makes deadlines work** —
   without it, the app has no way to convert a stop's driving-time-from-
   start into an actual clock time to compare against a `| HH:MM`
   deadline, so no lateness warnings show up until you set one.
11. **Fuel (in exports)** — doesn't show up in the interface; it's
    calculated automatically and only appears in the CSV/TXT. The server
    geolocates the IP of whoever is using the tool to figure out the
    country and uses a table of average diesel prices per country
    (`FUEL_PRICE_BY_COUNTRY` in `server.js`), combined with an assumed
    consumption of **11 L/100km** (typical for a delivery van with a
    ~3.0L diesel engine, e.g. Sprinter, Crafter, Daily). If you want to
    fine-tune the consumption or prices for your reality, edit the
    `DEFAULT_VAN_CONSUMPTION_L_PER_100KM` and `FUEL_PRICE_BY_COUNTRY`
    constants at the top of `server.js`. The cost is calculated only
    over the distance driven by car (walking parts don't count).

    The geolocation uses the free `ip-api.com` API (no key needed). If
    the machine is running on `localhost`, the geolocation detects the
    server's own outgoing public IP instead of yours, which is a
    reasonable approximation but may not be 100% accurate — the prices
    themselves are always indicative values, not a real-time quote.

## 8. Video → Address (second tab)

There's a second tab at the top of the page: **"🎥 Video → Address"**. It
extracts addresses automatically from a video or photo — for example, a
recording of several parcel labels before heading out on the route.

### How to use it

1. Switch to the "Video → Address" tab.
2. Upload a file (click the upload area, or drag the file there).
   Accepts video (`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, etc.) or photo
   (`.jpg`, `.png`, etc.). Works particularly well with a **screen
   recording scrolling** through the stop list of a delivery app (e.g.
   Planzer or similar) — the tool recognizes the same stop appearing in
   several frames during the scroll and uses that to boost confidence.
3. Click "Extract addresses". For photos it's quick; for videos it can
   take a while, depending on the length.
4. Each address found shows up with two tags:
   - **OCR confidence** (based on how many times the same stop was read
     throughout the video): "high" (stop number recognized and read 2+
     times), "medium" (read 2+ times but with no associated stop
     number), "low" (only one reading — more error-prone, usually from
     motion blur during fast scrolling).
   - **"confirmed"/"not confirmed"** (Google's validation, as always):
     confirmed = Google recognizes this address with street-level
     precision; not confirmed = either not found, or only the general
     area was found.
   When available, the stop number and recipient name also show up,
   read from the line above the address in the video.
5. For each address: **"Copy"** (clipboard) or **"Add to route"** (goes
   straight to the address list in the "Route" tab). There's also a
   button to add all of them at once.
6. Below the results, "View recognized text (OCR)" shows the full text
   as it was read (only available for photos — for video the text is
   split across many frames and showing it all together wouldn't make
   sense).

### Reading engines: Local vs AI

There's a **"Reading engine"** selector with two options:

- **Local (offline)** — uses `tesseract` (traditional OCR), runs
  entirely on your machine, doesn't need internet or an extra key. This
  is the default engine. Recognizes the stop number and recipient name
  (read from the line above the address), and confidence is based on how
  many times the same stop was read throughout the video.

- **AI (Claude)** — sends frames to the Claude API **in batches of 8**
  (not one at a time, in isolation), so Claude has context between
  neighboring frames — if an address appears cut off at the top/bottom
  of a frame, it can complete it using the previous/next frame in the
  same batch, similar to what would happen if you gave it all the
  images together in a normal conversation. After reading all the
  batches, it makes one final "consolidation" call that cleans up,
  deduplicates, and fixes small spelling variations between readings of
  the same address. Generally more accurate than the local engine, but:
  - Needs **`ANTHROPIC_API_KEY`** set in `.env` (see section 3). Without
    it, the "AI" option in the selector errors out when you try to use
    it — use "Local" in that case.
  - Needs an **internet connection** (calls `api.anthropic.com`).
  - **Has a cost** — each batch of 8 frames is one API call with 8
    images, plus one final consolidation call. For a ~60s video at 2
    fps (~120 frames), that's about 15 requests + 1 consolidation (much
    less than one frame per request). To cut costs further: use `fps=1`
    if the scroll isn't very fast, or switch to a cheaper model via
    `ANTHROPIC_MODEL` in `.env` (e.g. `claude-haiku-4-5-20251001`), at
    the cost of some accuracy on very small/blurry text.
  - Doesn't extract stop number or recipient name (only the address) —
    the AI is instructed to ignore everything else.
  - Processes up to **200 frames** per video (much more than the local
    engine, since here the limit is cost/time, not VM resources). If
    the video has more frames than that, they're chosen uniformly
    across the whole video — from start to finish — instead of just
    from the start, so you don't lose stops that appear later in the
    video. The batch size (5 frames per call) lives in the
    `FRAME_BATCH_SIZE` constant inside `extractStopsFromVideoAI`, in
    `server.js`, if you want to adjust it.
  - **Never loses everything at once**: if the final "consolidation"
    call fails for some reason (truncated response, network error,
    etc.), the tool doesn't discard the addresses already read
    successfully — it falls back to a simple deduplication, so you
    always get something back instead of zero results. If this happens,
    the result is a bit less "tidy" (it may have some uncorrected
    spelling variation), but it never loses real addresses.

The **"Frames per second"** field controls how many frames are analyzed
per second of video, for both engines: 1 fps (faster/cheaper), 2 fps
(recommended), or 3 fps (for very fast scrolling, where 2 fps could miss
stops). If you have a long video (more than ~100s at 2 fps) and feel
like stops are still missing, try lowering it to `1 fps` — that reduces
the total number of frames generated, which helps ensure the whole video
fits within the limit without needing to sample.

### How it works under the hood

- **Video:** the server uses the system's `ffmpeg` to extract frames at
  a configurable rate (2 per second by default). If the video has many
  frames (more than 40), it samples uniformly across the whole duration
  instead of processing everything — keeps coverage without blowing up
  processing time. If the format isn't readable directly (rare), it
  tries converting to mp4/h264 first and retries.
- **Photo:** used directly, no frame-extraction step.
- **OCR:** each image goes through the system's `tesseract`, recognizing
  the interface language + English as a backup (not every language at
  once — faster and lighter on memory).
- **Pattern recognition:** each line of text is compared against a
  Swiss/European address pattern ("Street/Route/Via ... number, postal
  code City"). When it finds one, it also looks at the line (or two)
  immediately above for an "N. Name" pattern (stop number + recipient),
  typical of delivery apps.
- **Deduplication across frames:** the same address usually appears in
  several consecutive frames during scrolling. These repeated readings
  are grouped — by stop number when available, or by text similarity
  (comparing shared words) otherwise — and that's what determines the
  "OCR confidence" of each result.
- **Validation:** each final (already deduplicated) address is sent to
  the Google Geocoding API — the same logic used throughout the rest of
  the app, including the Places API fallbacks for old locality names or
  small spelling mistakes.

### Things to know

- The file size limit is **500MB** — can be changed in `server.js`, in
  the `limits: { fileSize: ... }` constant of `multer`. Uploading a file
  over the limit gives a clear "file too large" message rather than a
  raw server error page.
- Both upload and extraction show progress: a real, byte-based progress
  bar while the file is uploading, followed by an indeterminate
  animated bar once the server starts working (frame extraction, OCR,
  or AI calls) — there isn't a way to show a real percentage for that
  second phase without a bigger rework (e.g. streaming updates back to
  the browser), so the animation is there to make clear the app is
  still working, not stuck.
- Uploaded files and extracted frames go in a system temp folder
  (outside the project) and are automatically deleted after each
  request, whether it succeeds or fails.
- OCR quality depends heavily on how sharp the video/photo is — blurry
  text, poor lighting, or very small text on screen will give worse
  results. If many addresses come back as "not confirmed" or "low
  confidence", it's worth trying with better lighting, closer to the
  label, or a slower scroll in the video.
- The "N. Name" pattern recognition above the address was designed for
  the typical layout of delivery apps (e.g. Planzer). If the app you're
  recording from has a different layout, the stop number and name may
  not show up — the address itself is still found regardless, just
  without those two extra fields.

### On resource usage on a VM

Unlike an earlier version of this tool (which used heavy JavaScript
packages for OCR and video extraction, and was likely behind a lockup
already reported on this VM), this version uses the **native** `ffmpeg`
and `tesseract` system binaries — much faster and lighter on memory than
the JavaScript/WASM alternatives. It only loads at most 2 OCR languages
at a time, and never processes more than 40 frames per video, even if
it's very long.

Even so, processing video is still heavier than processing a single
photo. If you notice slowness:
- **Prefer photos over video whenever possible.**
- Lower the `fps` on the client side if you ever want to expose that
  control in the interface (the endpoint already accepts an `fps` field
  in the request).
- Lower `MAX_FRAMES` at the top of the "VIDEO / PHOTO -> ADDRESS" module
  in `server.js`, if you need to process very long videos often.

## 9. Fix Addresses (third tab)

**"✓ Fix Addresses"** tab — to check an entire list of addresses at once,
before using them in the route. Handy, for example, after exporting a
list from an order system and wanting to confirm they're all correct
before calculating the route.

### How to use it

1. Paste the list (or upload a `.txt`/`.csv`), one address per line. A
   **"Clear list"** button below the upload field empties the textarea
   and any results already shown, in case you want to start over. Note
   that sending addresses here from the Route tab or from Video →
   Address *adds* them after whatever is already in the box, rather
   than replacing it — so you can build up a list from more than one
   source before checking it all at once.
2. Click "Check addresses". Each one is compared against the Google
   Geocoding API — the same "address database" already used throughout
   the app (there isn't a separate database; it's the most reliable one
   available for this).
3. Each address gets classified:
   - **confirmed** (green) — Google recognizes this address without any
     doubt, no correction needed.
   - **suggested correction** (yellow) — Google found the same address
     (street + number kept), only the format changed (for example, you
     wrote "Rte" and it suggests "Route" spelled out). Shows the
     original text struck through and the suggested version next to it,
     with a confirmation checkbox already checked by default.
   - **not precise enough** (red) — Google only recognized the general
     area (the village, the neighborhood), but **lost the street and
     number** of the original address. This happens when the exact
     address doesn't exist on Google's map, when the text uses an
     old/informal locality name (e.g. "Glis" instead of the official
     name of the merged municipality "Brig-Glis"), or when there's a
     spelling mistake in the street name (e.g. "Bielweg" instead of
     "Bielaweg"). The tool already tries two automatic fallbacks before
     giving up: first the Places API (Text Search, closer to the Maps
     search box), then the Places Autocomplete API (the same technology
     behind the "did you mean...?" suggestions while typing — more
     tolerant of small spelling mistakes). Even so, **no API catches
     100% of errors** — some uncommon street names with one wrong letter
     can slip past all three levels. That's why this category is
     **never offered as an automatic correction** — accepting it would
     make the route point to the village center instead of the right
     door. It's worth checking by hand or creating a GPS coordinate
     alias in the Route tab.
   - **not found** (red) — Google didn't find anything similar, not even
     the general area. Worth checking by hand or creating a GPS
     coordinate alias in the Route tab.
4. For each suggested correction, uncheck the box if you don't want to
   apply it. Or use the **"Accept all corrections"** / **"Apply none"**
   buttons to decide all at once.
5. On any address — even "confirmed", "not found", or "not precise
   enough" — you have two extra buttons in the corner of the card:
   - **🔗 (Open in Google Maps)** — opens a new tab with that address
     searched on Maps, so you can visually confirm what the right
     address is.
   - **✎ (Edit manually)** — opens a text box where you write the
     correct version by hand (for example, after confirming it on
     Maps). Clicking "Save" makes that address show the **"manually
     edited"** tag, and that's the version that will be used in the end,
     whatever state it was in before (even a "not found" one, where no
     automatic correction was available). To undo it, edit again and
     clear the text before saving.
6. At the end: **"Use this list in the Route tab"** replaces the address
   list in the Route tab with the final list (with the corrections you
   accepted and manual edits applied, the rest as it was). Or **"Export
   corrected list (.txt)"** to download it without going through the
   Route tab.

### Things to know

- Supports up to 300 addresses per check, with 5 concurrent requests to
  Google (to be faster without overloading the API). For large lists,
  it can still take a while — each address is one request to the
  Geocoding API.
- "Not found" addresses stay as they were in the final list; the tool
  never invents a correction when it isn't sure.

## Tests

```bash
npm test
```

37 tests, ~15 seconds, no network access and no API key needed — every
external service (Google, swisstopo, OSRM) is replaced by a
deterministic mock, so the suite never costs money or depends on
someone else's server being up.

They run against the **real endpoints** of an unmodified server
instance, with mocks injected via `node --require` rather than by
editing the source. That's deliberate: nothing in the suite depends on
any string inside server.js, so files can be split and moved freely and
the tests keep working — which is exactly what makes them useful as a
safety net during refactoring. The frontend tests follow the same
principle: they find the page JavaScript wherever it lives, inline or
in external files.

What's covered:
- **Hybrid geocoding** — each `GEOCODING_SOURCE` mode calls the right
  service and, just as importantly, *doesn't* call the wrong one
- **Hybrid routing** — OSRM vs Google, including falling back to Google
  when OSRM is down instead of failing the whole route
- **Cache correctness** — keys stay separated per source, repeated legs
  are served from cache, clearing distances leaves addresses alone
- **Optimization** — first (and, on round trips, last) stop stays fixed,
  no stop is ever lost or duplicated
- **Deadlines** — reordering to avoid lateness even at the cost of a
  longer route, and reporting lateness honestly when it's impossible
- **Login hardening** — including the accented-password crash
- **Share links** — public without a session, all three download formats
- **Cost accounting** — free sources priced at zero, Distance Matrix
  counted per element rather than per request
- **Frontend integrity** — every referenced asset loads, all page
  JavaScript parses, key interface elements exist, and the five
  translations stay complete with matching placeholders

Several are explicit regression tests for bugs found during
development, marked as such in the code. The suite was itself verified
by re-introducing two of those bugs and confirming the relevant tests
went red.

## Free geocoding for Swiss addresses

### Choosing the source (`GEOCODING_SOURCE`)

By default the app uses both sources, swisstopo first. You can change
that in `.env`:

| `GEOCODING_SOURCE` | Behaviour | Cost |
|---|---|---|
| `auto` (default) | swisstopo first; Google only if swisstopo can't resolve it | Free for most Swiss addresses, paid for the rest |
| `swisstopo` | swisstopo only — Google's geocoding is never called | Free, but **only Swiss addresses resolve at all** |
| `google` | Google only, as before the hybrid geocoding existed | Every lookup is billable, including Swiss ones |

An invalid value falls back to `auto` with a warning at startup, and
both non-default modes print a reminder of their trade-off when the
server starts, so it's never silently in a mode you forgot about.

**This setting only affects address lookups** (address text →
coordinates). Route distances and travel times are a separate concern,
controlled by `ROUTING_SOURCE` — see [Self-hosted routing with
OSRM](#self-hosted-routing-with-osrm) below. swisstopo itself has no
routing service, so it's never an option for that part.

Note that switching modes doesn't invalidate the cache: results are
cached per source, so changing this gives you fresh results from the
source you just picked rather than stale ones from the other, and
switching back reuses what was already cached before.

Before ever paying Google for geocoding, the app tries the **Swiss
Federal Office of Topography's (swisstopo) address search** first —
free, official government open data, no API key or registration
needed. If the address is genuinely in Switzerland, this often
resolves it with full street-level precision on its own, and Google's
Geocoding API is never even called for it.

This applies everywhere an address gets geocoded: aliases, "Fix
Addresses", the delivery deadlines list, share links, and video/photo
address extraction — all of it goes through the same
`geocodeAddressBest` function, so this is automatic, no separate
setting to turn on.

**How the decision works, for every address:**
1. Try swisstopo's address search first.
2. If it comes back with a precise street-level match (a real house
   number, not just the general area) → use it, done, Google was never
   contacted.
3. Otherwise (most likely: the address isn't in Switzerland at all, but
   this also covers swisstopo being briefly unreachable) → fall through
   to the exact same Google chain used before (Geocoding API, then the
   Places API fallbacks) — nothing changes for non-Swiss addresses.

This is why the address list (point 2 above) can safely mix Swiss and
non-Swiss addresses in the same route — each one is decided
independently, automatically, with no need to tell the app which
country an address is in.

**Why only Switzerland:** this was specifically researched for this
app's actual use case (Switzerland and Portugal). swisstopo only covers
Switzerland — that's expected, it's the Swiss national mapping agency.
For Portugal, no equivalent free, unrestricted forward-geocoding
service (address text → coordinates) was found — the closest Portuguese
open-data project found (`geoapi.pt`) only does *reverse* geocoding
(coordinates → address), which doesn't help here, and has its own rate
limits. So Portuguese (and any other non-Swiss) addresses always use
the regular Google chain, exactly as before this feature existed.

**Limitations of the free source, honestly:**
- No `place_id` equivalent — share links for a swisstopo-resolved
  address use the coordinates directly (still precise) instead of a
  Google `place_id`-based link.
- Only returns one candidate per search, so there's no equivalent to
  Google's Places fallback chain (Text Search, Autocomplete) for a
  swisstopo miss — if swisstopo doesn't find it outright, the address
  goes to Google's full chain, spelling-correction fallbacks included.
- Swiss data only — a Swiss-looking address with a typo severe enough
  that swisstopo can't match it will simply fall through to Google
  (same outcome as if swisstopo didn't exist for that one request, just
  one extra free, fast lookup first).

API docs: <https://docs.geo.admin.ch/access-data/search.html>. Terms of
use: <https://www.geo.admin.ch/en/general-terms-of-use-fsdi>. You can
see exactly how much this is saving you in practice via the [API
request log](#google-api-request-log) below — the `swisstopo` counter
shows every attempt (free, never billed), and comparing it against the
`geocoding` counter shows how many of those attempts meant Google
wasn't needed at all.

## Self-hosted routing with OSRM

By default, distances and travel times come from Google's Distance
Matrix API — which is usually the **largest line on the bill**, since
optimizing a route needs the distance between every pair of addresses
(n², not n). [OSRM](https://project-osrm.org/) is an open-source
routing engine you run yourself on OpenStreetMap data: once it's up,
routing is free and unlimited forever.

Switch with `ROUTING_SOURCE=osrm` in `.env`.

### Trade-offs — read before trusting it in production

| | Google Distance Matrix | Self-hosted OSRM |
|---|---|---|
| Cost | ~$5 per 1,000 elements | Free, unlimited |
| Live traffic | Yes | **No** — routes on speed limits only |
| Map freshness | Google's, always current | As current as the extract you downloaded |
| Setup/maintenance | None | You run and update the server |
| Travel profiles | driving + walking in one API | **One profile per instance** |

The traffic difference is the one that matters most day to day: OSRM
gives you free-flowing-traffic estimates. For planning tomorrow's route
that's usually fine; for "how long will this take right now, at 5pm",
Google is more realistic.

### Setting it up (Docker, Switzerland as the example)

```bash
# 1. Download the map extract for your region (Switzerland ~400MB) into
#    its own folder — keeps it separate from the rest of the project
mkdir -p switzerland
wget -P switzerland https://download.geofabrik.de/europe/switzerland-latest.osm.pbf

# 2. Pre-process it (one-off; needs several GB of RAM and some patience)
docker run -t -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/switzerland-latest.osm.pbf
docker run -t -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-partition /data/switzerland-latest.osrm
docker run -t -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-customize /data/switzerland-latest.osrm

# 3. Run the routing server
docker run -d -p 5000:5000 -v "${PWD}/switzerland:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld /data/switzerland-latest.osrm
```

Then in `.env`:
```
ROUTING_SOURCE=osrm
OSRM_URL=http://localhost:5000
```

Check it's alive with a direct request (note OSRM wants **lon,lat**,
the reverse of most APIs):
```bash
curl "http://localhost:5000/route/v1/driving/7.4474,46.9481;8.5417,47.3769?overview=false"
```

Other regions: browse <https://download.geofabrik.de/> for the extract
you need. Only download the area you actually deliver in — the whole
of Europe would need far more RAM and disk than a single region.

**Walking legs.** A profile (car, foot, bike) is baked in during
pre-processing, so one instance only knows one. If you use walk-only
addresses and want those on OSRM too, run a second instance with
`-p /opt/foot.lua` on another port and set `OSRM_URL_WALKING`. If you
don't, walking legs quietly keep using Google — usually fine, since
there are normally very few of them.

### How the app uses it

OSRM only understands coordinates, never address text. So when it's
enabled, every address is geocoded first (through the same cached
`geocodeAddressBest` used everywhere else) and OSRM gets coordinates.
In practice, switching to OSRM trades expensive Distance Matrix
elements for a few more geocoding lookups — which are cheaper, cached
for a year, and often free anyway via swisstopo.

Optimization also gets structurally cheaper: Google needs the matrix
split into 10×10 blocks to respect its limits, while OSRM returns the
whole thing in **one** request regardless of size.

**If OSRM is unreachable, the app falls back to Google automatically**
rather than failing your route — a routing server that's down
shouldn't stop you working. It logs `OSRM falhou...` to the server
console when this happens, so while testing, watch that log to confirm
OSRM is genuinely being used and you're not silently paying Google.
You can also confirm from the [API request log](#google-api-request-log):
the `osrm` counter shows real OSRM usage and never has a cost attached.

## Persistent cache (saves money)

The app automatically stores, in a file on the server, addresses already
geocoded and distances/times already calculated between points. Next
time you need the same address or the same leg, it uses what's already
stored instead of paying Google again — no action needed on your part,
it's automatic.

Where this helps the most in practice:
- **Recalculating the same route** after only changing the start time,
  the break, or the fuel settings — the addresses haven't changed, so
  the distances all come from the cache.
- **Reordering the route** (optimization) — reuses the cache address by
  address, not all-or-nothing. If you add or remove one address from a
  list you've already optimized before, only what involves that new
  address is requested from Google — the rest still comes from the
  cache. If the list is exactly the same as a previous time, no request
  is made at all.
- **Addresses that repeat** across different routes (e.g. the same
  warehouse, the same regular customers) — only geocoded the first time.
- **Aliases and blocked addresses** you've already geocoded before — if
  you reuse the same address anywhere in the app, it doesn't pay for it
  again.

### How long the cache lasts

- **Geocoded addresses**: 365 days (rarely change location).
- **Distances/times between points**: 90 days (gives some margin for new
  roads or changes in traffic, without keeping it forever).

**Important — nothing is actively deleted.** There's no timer clearing
the file on its own. What happens is: as long as an entry is within this
window, it's always used, for free. If you request **exactly that
address/leg** again after the window has passed, then yes, it pays
Google once, and that entry gets replaced with a new one. If you never
request that specific address again, the old entry just stays in the
file forever, harmless, just unused — it's not something worth worrying
about in terms of disk space.

You can adjust both values in `.env`:

```
GEOCODE_CACHE_TTL_DAYS=365
DISTANCE_CACHE_TTL_DAYS=90
```

If you always work in the same region and want to save as much as
possible (accepting the small risk that a road may have changed in the
meantime without you knowing), you can set much higher values — there's
no problem setting `DISTANCE_CACHE_TTL_DAYS=3650` (10 years, effectively
"never expires") if you'd rather never pay for the same leg again. Use
`DELETE /api/cache` (below) if you ever need to force fresh data
manually.

### Where it's stored

In two files inside `data/` (the same folder as the aliases and blocked
addresses, already excluded from `.gitignore`): `data/geocode-cache.json`
and `data/distance-cache.json`. They grow with usage, but are plain text
— for most use cases this never becomes a disk space concern.

### Viewing or clearing the cache

If you ever need to force fresh data (e.g. a street changed direction,
or you just want to make sure everything is up to date):

```bash
# See how many entries are in each cache
curl http://localhost:3000/api/cache-stats

# Clear everything
curl -X DELETE http://localhost:3000/api/cache

# Clear only one of the two
curl -X DELETE http://localhost:3000/api/cache -H "Content-Type: application/json" -d '{"type":"geocode"}'
curl -X DELETE http://localhost:3000/api/cache -H "Content-Type: application/json" -d '{"type":"distance"}'
```

(If you have password protection enabled, you need to be authenticated
in the browser for these requests to work — easiest to do this from a
tab that already has a session started, or temporarily without
`APP_PASSWORD` set.)

## Sharing an export via QR code

Next to every export button (route CSV/TXT, address-only export, "Fix
Addresses" corrected list) there's a small **📱** button. Clicking it
doesn't download anything — instead, it uploads the content to this
server, gets back a short-lived link and a QR code, and shows both in a
popup. Scanning the code with another device (e.g. a driver's phone)
opens the link directly in its browser — no login needed on that
device, and no need to physically transfer a file between devices.

**For an address list specifically** (the address-only export, and the
"Fix Addresses" corrected list), the other device gets a clean, plain
list of addresses — no CSV-style quoting marks cluttering the view,
since those only mean something once a file is actually opened in a
spreadsheet app, not when reading it on a screen. Below the list, that
device has its own **⬇ CSV / ⬇ TXT / ⬇ JSON** buttons, so whoever
opens the link can save it in whichever format they want, independently
of whatever format (if any) was selected back on the sending device —
the CSV button there still produces a properly quoted, valid CSV file,
the quoting just doesn't show up in the on-screen list above it.

The full route export (with distances/times/totals, a genuinely
tabular format where the quoting is structurally necessary) doesn't
have this format-switching — the CSV button shares an actual CSV file
as-is, the TXT one shares the plain, already quote-free text version.

**Why not just put the file directly in the QR code?** QR codes can
only reliably hold a few hundred characters — nowhere near enough for a
real route with more than a handful of stops. So the code only encodes
a short link; the actual content stays on this server temporarily (in
memory only, never written to disk) until either it's opened or **30
minutes** pass, whichever comes first.

**About reaching the other device.** The link needs to use an address
the scanning device can actually reach — not `http://localhost:3000`,
which would mean the phone doing the scanning, not this server, since
every device has its own "localhost". The app handles the common case
automatically: if you loaded it via `localhost` (or `127.0.0.1`), the
server detects this and swaps in this machine's own LAN IP address
before building the link and QR code — no need to remember to browse to
a different address first. The popup tells you when this happened. If
the app is deployed with a real domain/HTTPS, none of this is a concern
in the first place.

**If the QR code opens the phone's browser but the connection fails**
(e.g. it times out, or shows something like `ERR_CONNECTION_ABORTED` /
`ERR_CONNECTION_REFUSED` / `ERR_CONNECTION_TIMED_OUT`), the automatic
guess most likely picked an address the phone can't actually reach.
This is especially common when the server runs inside a **VM with more
than one virtual network adapter** (e.g. a NAT adapter for outbound
internet plus a separate bridged/host-only adapter for LAN access) —
the automatic detection can't always tell which one your phone can
reach, since from the server's point of view they're all just "a
network interface with an IP address". Work through these in order:

1. **Set `SHARE_HOST` in `.env`** to skip the guessing entirely:
   ```
   SHARE_HOST=192.168.1.50:3000
   ```
   Use the address you'd actually type into another device's browser to
   reach this server — find it with `ip addr` or `hostname -I` on
   Linux (look for the address on the interface that's actually bridged
   to your LAN, not a `docker0`/`vboxnet`/`virbr` one), or check your
   VM software's network settings if you're not sure which adapter is
   bridged. Restart the server after setting this.
2. **Check the firewall on the machine running the server.** Even with
   the right address, something has to allow the incoming connection.
   On Ubuntu: `sudo ufw status` — if it's active and there's no rule
   allowing the app's port, add one with `sudo ufw allow 3000/tcp`
   (replace `3000` with your actual `PORT`). A firewall actively
   rejecting the connection (rather than silently dropping it) is
   exactly the kind of thing that produces `ERR_CONNECTION_ABORTED`
   specifically.
3. **Confirm both devices are actually on the same network** — a phone
   on mobile data (not WiFi) can't reach a LAN address no matter how
   correctly everything else is configured.
4. If this is a VM, double check its network adapter is set to
   **Bridged** (or has a LAN-reachable IP some other way) rather than
   **NAT-only** — a NAT-only adapter gives the VM internet access but
   makes it unreachable from other devices on your physical network,
   which no server-side setting can work around.

Creating a share link (clicking 📱) requires being logged in, exactly
like any other action in the app. **Opening** the resulting link does
not — the random token in the URL is what protects it, the same idea
as any "shareable link" feature elsewhere. Treat a link you've
generated as something you wouldn't want to fall into the wrong hands
until it expires.

## Google API request log

The app keeps a running count of every real request it makes to
Google's APIs — grouped by which API (Geocoding, Distance Matrix,
Places Text Search, Places Autocomplete), broken down per day, and
totaled since you started using this data directory. This only counts
requests that actually reach Google — a cache hit doesn't touch
Google's servers or cost anything, so it's never counted here.
Distance Matrix specifically is counted in **elements** (origins ×
destinations), not HTTP calls — that's what Google actually bills per,
and a single optimization run can bundle many origins/destinations into
one HTTP request, so counting "1 per call" would badly undercount it.

This is a plain counter, not a detailed audit log — it doesn't record
which address was requested or at what time, just how many requests of
each kind happened. That keeps the file tiny forever, and matches what
this is actually useful for: keeping an eye on usage and cost over
time, not investigating a specific past request.

```bash
# See today's counts, totals per API, the full day-by-day history, and
# an estimated cost
curl http://localhost:3000/api/api-log
```

This returns something like:

```json
{
  "totals": { "geocoding": 512, "distanceMatrix": 18300, "placesTextSearch": 40, "placesAutocomplete": 12 },
  "grandTotal": 18864,
  "today": { "date": "2026-08-25", "counts": { "geocoding": 8, "distanceMatrix": 450 }, "total": 458 },
  "daily": {
    "2026-08-24": { "geocoding": 15, "distanceMatrix": 1200 },
    "2026-08-25": { "geocoding": 8, "distanceMatrix": 450 }
  },
  "estimatedCost": {
    "currency": "USD",
    "lifetime": { "byApi": { "geocoding": 2.56, "distanceMatrix": 91.50, "placesTextSearch": 1.28, "placesAutocomplete": 0.03 }, "total": 95.37 },
    "thisMonth": { "byApi": { "geocoding": 0, "distanceMatrix": 41.50 }, "total": 41.50, "counts": { "geocoding": 512, "distanceMatrix": 18300 } },
    "note": "Estimate only, based on Google's first-tier list prices — not a real bill."
  }
}
```

### About the cost estimate

`estimatedCost` isn't a real bill — it's a best-effort estimate using
Google's own published prices, meant to give you a sense of scale, not
an exact figure. It only covers Google's paid APIs — the `swisstopo`
counter (see [Free geocoding for Swiss
addresses](#free-geocoding-for-swiss-addresses) above) never has a
price attached, since it's free regardless of volume. Two numbers are
given, for different purposes:

- **`lifetime`** — every request ever logged, priced at the standard
  rate, *ignoring* Google's free monthly quota entirely. Not accurate
  for a period spanning several months (the quota resets every month,
  so it would have applied more than once) — think of this as a simple
  worst-case ceiling, not a real total.
- **`thisMonth`** — only the current calendar month's usage, with each
  API's free monthly quota subtracted first. This is the one that's
  actually close to what you'd see on this month's Google invoice.

Prices used (first paid pricing tier, 0–100,000 billable events/month,
current as of August 2026 — see [Google's official pricing
page](https://developers.google.com/maps/billing-and-pricing/pricing)
for the current numbers and higher-volume tiers, which get cheaper per
unit at scale):

| API | Price per 1,000 | Free per month |
|---|---|---|
| Geocoding | $5.00 | 10,000 |
| Distance Matrix (per element) | $5.00 | 10,000 |
| Places Text Search (legacy) | $32.00 | 5,000 |
| Places Autocomplete (legacy, per request) | $2.83 | 10,000 |

Places Text Search is the one to watch — at $32 per 1,000, it's over
6× the price of Geocoding, since the legacy endpoint this app uses
falls under Google's "Pro" pricing tier. It's only called as a
fallback when the plain Geocoding API can't find an address precisely
(see the "Fix Addresses" and route calculation sections above), so it
should normally stay a small fraction of total usage — if `placesTextSearch`
ever makes up a large share of your `thisMonth` cost, that's worth a
look (it may mean a lot of your addresses are hard for Google to match
directly, which is also useful to know on its own).

If Google changes these prices, the numbers here will drift out of
date — this app doesn't fetch pricing live, since that's not something
Google exposes as an API. Update the `API_PRICING` constant near the
top of `server.js` if you notice the estimate looking obviously wrong.

To reset the counters (e.g. you're starting to track a new billing
period and want to begin from zero):

```bash
curl -X DELETE http://localhost:3000/api/api-log
```

Stored in `data/api-request-log.json` — same folder as everything else,
already excluded from `.gitignore`. Writes to disk are debounced by a
couple of seconds (an optimization run can trigger dozens of requests
in a row; no need to hit the disk on every single one), so the very
latest count might lag slightly behind reality if you check it
mid-request, but it always catches up within a couple of seconds.

## How the key protection works

The browser never talks to Google directly. It calls `POST
/api/distance` on your own Node/Express server, and it's the server
(`server.js`) that adds the key (read from
`process.env.GOOGLE_MAPS_API_KEY`) and makes the request to the Google
Distance Matrix API. The key never shows up in the HTML, in the
browser's JavaScript, or in developer tools.

If you ever want to publish this online (Render, Railway, Fly.io, etc.),
just set the `GOOGLE_MAPS_API_KEY` environment variable in the service's
settings — no code changes needed.

## For production

As an extra precaution, in the Google Cloud Console you can also
restrict the key by **IP** (the IP of the server this will run on), so
even if something goes wrong the key can't be used from anywhere else.
