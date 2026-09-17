// MapLibre GL JS map view + "Excluir troço" (dynamic road exclusion).
//
// Owns everything visual (the MapLibre instance, all its layers) AND all
// the fetch() calls to /api/route + /api/road-exclusion/* +
// /api/road-restrictions — but NOT the routing/optimization logic
// itself, which lives entirely on the server (src/valhalla.js,
// src/routeGeometry.js, src/roadRestrictions.js, src/optimizer.js).
// index.html only ever hands this module plain request parameters
// (addresses/deadlines/roundTrip/...) and gets back a call to
// window.applyReorderedRoute(order) when the user confirms a new route —
// it never has to know anything about MapLibre.
(function () {
  'use strict';

  let map = null;
  let mapReadyResolve = null;
  let mapReady = null; // resolves once map 'load' has fired and sources/layers exist
  // Set when MapLibre couldn't get a WebGL context (seen on Chrome inside
  // some VMs/sandboxes — the browser refuses to fall back to software
  // rendering; Firefox does fall back, so this is browser-specific, not a
  // server/config problem). Checked after `await mapReady` so callers show
  // a real explanation instead of a blank map box.
  let mapUnavailable = false;
  let t = (key) => key;
  let escapeHtml = (s) => String(s);
  // Called after "Agrupar (a pé)" saves its bulk walk-only + parking
  // point changes — index.html owns the blocked-addresses picker and the
  // address list's 🚶 tags, so map.js hands the outcome back up instead
  // of touching that state (or the top status banner) itself.
  let onBlockedAddressesChanged = null;

  // Called when the master "Endereços a pé" toggle flips — index.html's
  // own findBlockedMatch() (and therefore /api/optimize's restricted[]
  // flags) needs to know too, since map.js only owns the map-side view.
  let onWalkOnlyEnabledChanged = null;

  let lastRequestParams = null; // { addresses, roundTrip, deadlines, startMinutes, stopMinutes }
  let lastRoute = null; // last successful /api/route response
  let routeIsOptimized = false; // true when lastRoute came from "Reorganizar rota" / applying an alternative, not a plain recalculation

  // ---------- "Ver rota antes da otimização" ----------
  // Captured by index.html (setPreOptimizeSnapshot) right when "Otimizar"
  // succeeds, from the request shape as it stood *before* reordering — no
  // server round trip at that point. The actual geometry/stops for that
  // snapshot are only fetched (once, then cached) the first time the
  // toggle button is clicked.
  let preOptimizeSnapshot = null; // { addresses, roundTrip, deadlines, startMinutes, stopMinutes }
  let preOptimizeRouteCache = null; // full /api/route response for that snapshot, once fetched
  let showingPreOptimizeRoute = false;
  let savedOptimizedState = null; // { lastRoute, routeIsOptimized, routeCumulative, routeStopMarkers } stashed while showing it
  let mode = 'idle'; // 'idle' | 'block-line' | 'exclude-a' | 'exclude-b' | 'access-point' | 'group-draw' | 'group-parking'
  let pickedA = null; // [lng, lat]
  let pickedB = null;
  let pendingPreview = null; // last /api/road-exclusion/preview response, while its panel is open
  let stopPopup = null; // the one open stop-info popup, if any
  // Address waiting for a manual access-point click (see "Marcar ponto de
  // acesso manual" in the unreachable-stop notice) — set only while
  // mode === 'access-point'.
  let pendingAccessOverrideAddress = null;

  // A plain 'crosshair' reads as "click a point", not "draw here" — a
  // custom pencil cursor is what actually tells the driver they're in a
  // free-drawing mode, not about to place a single pin.
  const PENCIL_CURSOR = "url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2728%27 height=%2728%27 viewBox=%270 0 28 28%27%3E%3Cg stroke=%27%23171208%27 stroke-width=%271%27 stroke-linejoin=%27round%27%3E%3Cpolygon points=%2724,2 26,4 10,20 6,22 8,18%27 fill=%27%23F2C572%27/%3E%3Cpolygon points=%276,22 3,25 2,24 5,21%27 fill=%27%235B4636%27/%3E%3Cpolygon points=%278,18 6,22 5,21 7,17%27 fill=%27%23171208%27/%3E%3Cpolygon points=%2719,0 28,9 24,13 15,4%27 fill=%27%23E2665B%27/%3E%3C/g%3E%3C/svg%3E') 3 24, crosshair";

  // ---------- "Agrupar (a pé)": draw a shape, bulk-apply walk-only ----------
  // Same idea as the single-address "Endereços interditos" + parking
  // point (src/routeGeometry.js's own comment on that pair applies here
  // too) — this just lets the driver draw a shape around a whole
  // pedestrian area instead of picking addresses one at a time. Every
  // address inside the shape still stays its own stop for the optimizer
  // (own order, own deadline, own status) — only its walk-only flag and
  // parking point are set, in bulk, via the SAME /api/blocked endpoint
  // the manual picker already uses.
  let groupIsDrawing = false; // true strictly between mousedown and mouseup
  let groupDrawPoints = []; // [[lng,lat], ...] traced during the current drag
  let groupMatchedAddresses = []; // resolved once the shape closes, awaiting a parking-point click
  let groupParkingPoint = null; // [lng, lat], set once the parking click lands

  // ---------- "Bloquear via" ----------
  // Matches server.js's own default — kept in sync there, not imported,
  // since this is a static UI default and the server independently
  // clamps/validates whatever the client actually sends.
  const DEFAULT_BLOCK_BUFFER_METERS = 12;
  // How the user picks the segment: click the drawn route ('line'),
  // choose a pair of stops from the list ('stops'), or click two free
  // points on the map ('points' — the most flexible, can cut mid-leg).
  let blockPanelOpen = false;
  let blockSelectionMode = 'line';
  let blockWindowChoice = 'today'; // 'today' | 'date' | 'range' | 'forever'
  let pendingBlockWindow = null; // { type, startsAt, expiresAt } awaiting confirmation
  let pendingBlockReason = '';
  // How far to each side of the clicked line the exclusion reaches — see
  // server.js's /api/road-exclusion/preview comment on why this isn't a
  // fixed constant: a wide buffer on a short, precise block can still
  // swallow a real parallel street in a tight cluster of houses.
  let pendingBlockBufferMeters = DEFAULT_BLOCK_BUFFER_METERS;
  // Where the user actually clicked on the route, so the server can
  // centre the blocked piece there when the leg is too long to block whole.
  let blockAnchorPoint = null;

  // Restrictions the server last reported: everything still valid
  // (in force + scheduled for later), and the subset applying right now.
  let knownRestrictions = [];
  let inForceRestrictions = [];

  const DURATION_CHOICES = [
    { id: 'today', key: 'blockDurationToday' },
    { id: 'date', key: 'blockDurationDate' },
    { id: 'range', key: 'blockDurationRange' },
    { id: 'forever', key: 'blockDurationForever' },
  ];

  // Cumulative distances + per-stop distances for the route currently on
  // screen. Built once per route and shared by the animation and the
  // segment picking, both of which need "how far along the route is X".
  let routeCumulative = null;
  let routeStopMarkers = null;

  // Addresses currently marked walk-only (section 04's list AND "Agrupar
  // (a pé)" both write to the same server-side list — this is just the
  // last GET /api/blocked this map has seen). Kept as its own Set,
  // refreshed by refreshWalkOnlyList(), so buildStopsFeatureCollection
  // can tag each stop feature without an extra round trip per render.
  let walkOnlyAddresses = new Set();

  // Master switch for walk-only treatment, next to the "Endereços a pé"
  // label. Off means every walk-only address is temporarily routed and
  // drawn like a normal stop, WITHOUT touching data/blocked.json — so
  // flipping it back on restores everything exactly as it was. Persisted
  // so it survives a page reload.
  let walkOnlyEnabled = true;
  try { walkOnlyEnabled = localStorage.getItem('walkOnlyEnabled') !== '0'; } catch (err) { /* localStorage indisponível */ }

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  // ---------- Base map style ----------
  // Raster tile sets only (no vector styles/API keys needed) — each one
  // just swaps the single 'base-raster' source, everything else (route
  // line, stop markers, blocked segments, ...) is added back on top by
  // addOverlayLayers() after every style switch, since MapLibre's
  // setStyle() wipes all sources/layers that aren't part of the new style.
  // 'raster': a single XYZ tile source we build ourselves. 'url': a full
  // MapLibre style (vector, with its own sources/sprite/glyphs) fetched
  // from its own URL — MapLibre accepts a style URL anywhere it accepts
  // a style object, both at map creation and in setStyle().
  //
  // dark/light used to be CARTO's Dark Matter / Positron raster tiles,
  // which were free without a key for years — CARTO has since locked
  // basemaps.cartocdn.com behind a required API key (the "free" tiles
  // now render with an "API KEY REQUIRED" watermark baked into the
  // image instead of failing the request, so this is easy to miss by
  // only checking the HTTP status). OpenFreeMap hosts the same
  // Positron/Dark-Matter designs as open vector styles on its own free,
  // no-key infrastructure, so those replace CARTO here instead of
  // asking for an account.
  //
  // 'topo' is the swisstopo national map (free WMTS, no key) — the map
  // every Swiss driver already knows — with OSM house numbers drawn on
  // top from OpenFreeMap's vector tiles, since swisstopo's own raster
  // has none at any zoom. Replaced the old OpenFreeMap dark style as the
  // default; the same style object lives in public/pwa/js/config.js.
  const TOPO_STYLE = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      'base-raster': {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg'],
        attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>',
      },
      'osm': { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '&copy; OpenStreetMap contributors' },
    },
    layers: [
      { id: 'base-raster-layer', type: 'raster', source: 'base-raster' },
      {
        id: 'housenumbers', type: 'symbol', source: 'osm', 'source-layer': 'housenumber', minzoom: 16,
        layout: { 'text-field': ['get', 'housenumber'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 16, 9, 19, 13], 'text-padding': 1 },
        paint: { 'text-color': '#B3261E', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
    ],
  };
  const MAP_STYLES = {
    topo: { type: 'style', style: TOPO_STYLE },
    light: { type: 'url', url: 'https://tiles.openfreemap.org/styles/positron' },
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    // the original topographic style, kept as its own button alongside
    // the swisstopo 'topo' above instead of being replaced by it.
    topoClassic: {
      type: 'raster',
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    },
  };
  const DEFAULT_MAP_STYLE = 'topo';
  const MAP_STYLE_STORAGE_KEY = 'routeTrackerMapStyle';

  function loadStoredMapStyle() {
    try {
      const stored = window.localStorage.getItem(MAP_STYLE_STORAGE_KEY);
      return stored && MAP_STYLES[stored] ? stored : DEFAULT_MAP_STYLE;
    } catch (_) { return DEFAULT_MAP_STYLE; } // private browsing etc — just use the default
  }

  let currentMapStyle = loadStoredMapStyle();

  function buildBaseStyle(styleId) {
    const chosen = MAP_STYLES[styleId] ? styleId : DEFAULT_MAP_STYLE;
    const style = MAP_STYLES[chosen];
    if (style.type === 'url') return style.url; // MapLibre fetches+owns this style entirely
    if (style.type === 'style') return style.style;
    return {
      version: 8,
      sources: { 'base-raster': { type: 'raster', tiles: style.tiles, tileSize: 256, attribution: style.attribution } },
      layers: [{ id: 'base-raster-layer', type: 'raster', source: 'base-raster' }],
    };
  }

  // ---------- Pin/route visual style ("Clássico" vs "Moderno") ----------
  // Independent from the base tile style above: this one only reskins the
  // route line + stop markers, via paint/layout overrides applied in
  // applyPinStyle() — it never touches map.setStyle()/sources.
  const MODERN_GREY = '#5B6472'; // "before optimizing" / "already visited" — neutral, not a state color
  const MODERN_AMBER = '#E8A33D'; // matches the app's existing amber accent
  const ROUTE_BLUE = '#1E5BFF'; // the route line in 'classic' — readable on the swisstopo base (was amber, invisible there)
  const MODERN_ROUTE_BLUE = '#3B7CF5'; // the un-travelled route line in 'modern' — sampled from the reference "Animar rota" video the user pointed to
  const MODERN_PROGRESS_GREEN = '#4FAE7C'; // the travelled stretch during "Animar rota" in 'modern' — same green as the moving marker
  const WALK_ONLY_BLUE = '#5B8FD6'; // same blue as the "Agrupar (a pé)" tool and its list — one colour, one meaning, everywhere: "the van doesn't drive here"
  const DEFAULT_PIN_STYLE = 'classic';
  const PIN_STYLE_STORAGE_KEY = 'routeTrackerPinStyle';

  function loadStoredPinStyle() {
    try {
      const stored = window.localStorage.getItem(PIN_STYLE_STORAGE_KEY);
      return (stored === 'modern' || stored === 'legacy') ? stored : DEFAULT_PIN_STYLE;
    } catch (_) { return DEFAULT_PIN_STYLE; }
  }

  let pinStyle = loadStoredPinStyle();

  // 'modern' style's stop markers: two pin icons from the same icon set
  // instead of a plain circle — pin-pending.svg while a stop is still
  // pending, swapped in place for check-pin.svg (the same pin body, plus
  // a ✓ roundel) once "Animar rota" reaches it. Both multi-colour, so
  // unlike the circle they replace neither can be recoloured per-feature
  // via a paint expression (that needs a single-channel SDF image); state
  // is the swap itself. 512x512 sources, loaded once and reused across
  // every style switch (map.setStyle() wipes addImage() too, so
  // addOverlayLayers() re-adds them every time it runs).
  //
  // Placement numbers below come from each SVG's own geometry (512x512
  // viewBox), so a size tweak stays a one-line change:
  //  - pin-pending.svg: tip at (256, 512), number roundel centred at
  //    (256, 198.7).
  //  - check-pin.svg: the same pin drawn at x=198.7 instead of 256 to make
  //    room for the ✓ roundel off to the bottom-right — so tip at
  //    (198.7, 512), roundel centred at (198.7, 198.7).
  const PIN_ICON_SIZE = 0.085; // ~44px tall on screen
  const PIN_TEXT_SIZE = 11;
  const PIN_ROUNDEL_ABOVE_TIP = 512 - 198.7; // identical for both pins
  const PIN_PENDING_IMAGE_ID = 'pin-pending';
  const CHECK_PIN_IMAGE_ID = 'check-pin';
  const CHECK_PIN_TIP_RIGHT_OF_CENTER = 256 - 198.676; // tip is left of the image's centre line
  const mapImageElements = {}; // id -> loaded <img>, filled in as each one's onload fires

  function preloadMapImage(id, url) {
    if (typeof Image === 'undefined') return; // test harness loads this file with no DOM/Image global
    const img = new Image();
    img.onload = () => {
      mapImageElements[id] = img;
      if (ensureMapImagesRegistered()) redrawStopsForLateIcons();
    };
    img.src = url;
  }
  preloadMapImage(PIN_PENDING_IMAGE_ID, '/icons/pin-pending.svg');
  preloadMapImage(CHECK_PIN_IMAGE_ID, '/icons/check-pin.svg');

  // Registers every loaded image the map doesn't have yet. Also reports
  // whether anything NEW was added, because a symbol layer whose icon
  // didn't exist yet when its features were last drawn does NOT pick up
  // a later addImage() on its own — MapLibre bakes icon placement into
  // the layer's data at setData() time, so a late-arriving icon (the SVG
  // fetch losing the race against the very first route render, which is
  // likely on a real page load: WebGL init + style/tile loading + this
  // fetch are all happening at once) needs that data re-applied once the
  // image is finally available. Callers do that redraw themselves (see
  // the addOverlayLayers()/onload call sites below) — this function only
  // touches the image manager.
  function ensureMapImagesRegistered() {
    if (!map) return false;
    let addedAny = false;
    Object.keys(mapImageElements).forEach((id) => {
      if (!map.hasImage(id)) { map.addImage(id, mapImageElements[id]); addedAny = true; }
    });
    return addedAny;
  }

  // Forces the 'stops' symbol layers to re-lay-out with whatever icons are
  // registered right now — see ensureMapImagesRegistered()'s comment.
  // Safe to call whenever: a no-op with no route on screen, and preserves
  // "Animar rota" progress (uses animationPassedSeqs, not renderStops()).
  function redrawStopsForLateIcons() {
    if (map && lastRoute) setSourceData('stops', buildStopsFeatureCollection(lastRoute.stops, animationPassedSeqs));
  }

  function updateMapStyleUI() {
    const group = $('mapStyleGroup');
    if (!group) return;
    group.querySelectorAll('.map-style-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-style') === currentMapStyle);
    });
  }

  // Redraws everything that lives on top of the base map — called once
  // after the initial 'load' and again after every style switch, since
  // setStyle() throws away all sources/layers/data that aren't part of
  // the new style JSON.
  function addOverlayLayers() {
    map.addSource('route-line', { type: 'geojson', data: EMPTY_FC });
    // White casing under the line: on the swisstopo map (white ground,
    // black buildings, green trees) a bare coloured line vanished into
    // the roads it followed — the halo is what keeps it readable.
    map.addLayer({
      id: 'route-line-casing-layer', type: 'line', source: 'route-line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'route-line-layer', type: 'line', source: 'route-line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ROUTE_BLUE, 'line-width': 4 },
    });

    map.addSource('preview-route-line', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'preview-route-line-layer', type: 'line', source: 'preview-route-line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      // A leg the preview found no route for at all (see runPreview's
      // doc comment) is drawn in red instead of the usual preview green,
      // same signal as the confirmed route-line-layer uses.
      paint: { 'line-color': ['case', ['get', 'unreachable'], '#E2665B', '#4FAE7C'], 'line-width': 4, 'line-dasharray': [1, 1.4] },
    });

    ensureMapImagesRegistered();

    map.addSource('stops', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'stops-circle-layer', type: 'circle', source: 'stops',
      paint: {
        'circle-radius': 10, 'circle-color': '#171D26',
        'circle-stroke-width': 2, 'circle-stroke-color': '#E8A33D',
      },
    });
    map.addLayer({
      id: 'stops-label-layer', type: 'symbol', source: 'stops',
      layout: {
        'text-field': ['to-string', ['get', 'seq']],
        'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      },
      paint: { 'text-color': '#E8A33D' },
    });

    // "Moderno" only: the two pin icons (see PIN_PENDING_* / CHECK_PIN_*
    // above) plus their number, replacing stops-circle-layer/
    // stops-label-layer above for that style — the layer sets are toggled
    // by visibility in applyPinStyle (classic keeps the plain circle,
    // modern shows these). Pending vs visited is a plain swap: the two
    // layers carry opposite static filters on the feature's `passed`
    // flag, so the moment markStopPassed() flips it the pending pin
    // vanishes and the ✓ pin takes its place at the exact same point.
    //
    // Both use icon-anchor 'bottom' (plus, for the ✓ pin, an icon-offset
    // in source px scaled by icon-size) so that each pin's own TIP — not
    // its image centre — sits on the stop's real coordinate, same as any
    // teardrop map pin; text then shares that anchor and is pulled up into
    // the pin's roundel with text-offset (ems of text-size).
    const pinText = {
      'text-field': ['case', ['get', 'optimized'], ['to-string', ['get', 'seq']], '●'],
      'text-size': PIN_TEXT_SIZE,
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-offset': [0, -(PIN_ROUNDEL_ABOVE_TIP * PIN_ICON_SIZE) / PIN_TEXT_SIZE],
      'text-allow-overlap': true,
    };
    const pinTextPaint = {
      'text-color': ['case', ['get', 'walkOnly'], WALK_ONLY_BLUE, '#171D26'],
      // White halo keeps 2-3 digit numbers readable over the roundel's edge.
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 1.5,
    };
    map.addLayer({
      id: 'stops-pin-icon-layer', type: 'symbol', source: 'stops',
      filter: ['!', ['get', 'passed']],
      layout: {
        visibility: 'none',
        'icon-image': PIN_PENDING_IMAGE_ID,
        'icon-size': PIN_ICON_SIZE,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        ...pinText,
      },
      paint: pinTextPaint,
    });
    map.addLayer({
      id: 'stops-pin-badge-layer', type: 'symbol', source: 'stops',
      filter: ['get', 'passed'],
      layout: {
        visibility: 'none',
        'icon-image': CHECK_PIN_IMAGE_ID,
        'icon-size': PIN_ICON_SIZE,
        'icon-anchor': 'bottom',
        'icon-offset': [CHECK_PIN_TIP_RIGHT_OF_CENTER, 0],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        ...pinText,
      },
      paint: pinTextPaint,
    });

    // "Moderno" only: the departure point drawn distinct from the rest
    // (bigger, solid, no stroke, no number) — same 'stops' source, just
    // filtered down to seq 1. Hidden in 'classic' and once seq 1 has
    // been visited during "Animar rota" (see applyPinStyle()), at which
    // point it folds into stops-circle-layer/stops-label-layer like any
    // other passed stop.
    map.addLayer({
      id: 'start-point-layer', type: 'circle', source: 'stops',
      filter: ['==', ['get', 'seq'], 1],
      layout: { visibility: 'none' },
      paint: { 'circle-radius': 14, 'circle-color': MODERN_AMBER },
    });

    map.addSource('excluded-segments', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'excluded-segments-layer', type: 'line', source: 'excluded-segments',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#E2665B', 'line-width': 6, 'line-dasharray': [0.2, 1.6] },
    });
    map.addLayer({
      id: 'excluded-segments-label-layer', type: 'symbol', source: 'excluded-segments',
      layout: {
        'symbol-placement': 'line-center',
        'text-field': '🚧 ' + t('blockedRoadLabel'),
        'text-size': 12, 'text-offset': [0, -1],
      },
      paint: { 'text-color': '#E2665B', 'text-halo-color': '#171D26', 'text-halo-width': 1.5 },
    });

    map.addSource('pick-points', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'pick-points-layer', type: 'circle', source: 'pick-points',
      paint: { 'circle-radius': 7, 'circle-color': '#E2665B', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
    });

    // "Agrupar (a pé)": the freehand shape while it's being drawn (line)
    // and, once closed, its interior (fill) — both fed by the SAME
    // source, since a fill layer simply has nothing to paint yet while
    // the geometry is still an open LineString.
    map.addSource('group-draw', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'group-draw-fill-layer', type: 'fill', source: 'group-draw',
      paint: { 'fill-color': '#5B8FD6', 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'group-draw-line-layer', type: 'line', source: 'group-draw',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#5B8FD6', 'line-width': 3, 'line-dasharray': [2, 1.5] },
    });
    // A ring around each stop the closed shape actually matched — drawn
    // on its own source (not by touching 'stops' itself) so highlighting
    // a group never risks disturbing the main stop numbering/colouring.
    map.addSource('group-selected-points', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'group-selected-points-layer', type: 'circle', source: 'group-selected-points',
      paint: { 'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3, 'circle-stroke-color': '#5B8FD6' },
    });

    // "Animar rota": a highlight line traces over the route as a marker
    // travels along it — both fed by the same precomputed cumulative
    // distances (see buildCumulative/pointAtDistance below).
    map.addSource('animation-progress-line', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'animation-progress-line-layer', type: 'line', source: 'animation-progress-line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 4 },
    });

    map.addSource('animation-marker', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'animation-marker-layer', type: 'circle', source: 'animation-marker',
      paint: {
        'circle-radius': 8, 'circle-color': '#4FAE7C',
        'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
      },
    });

    // A one-off ring flashed over a stop the instant the animation reaches
    // it (see pulseStopMarker()) — its own layer so it never has to fight
    // the main stops layer's own paint expressions. circle-radius/opacity
    // both carry a transition, so a plain setPaintProperty() eases smoothly
    // instead of needing a manual per-frame animation loop.
    map.addSource('animation-pulse', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'animation-pulse-layer', type: 'circle', source: 'animation-pulse',
      paint: {
        'circle-radius': 8,
        'circle-radius-transition': { duration: 200 },
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 3,
        'circle-stroke-color': '#4FAE7C',
        'circle-stroke-opacity': 0,
        'circle-stroke-opacity-transition': { duration: 200 },
      },
    });

    applyPinStyle();
  }

  // Applies the current pinStyle ('classic' | 'modern') to every layer it
  // touches. Called once right after the layers above are (re)created —
  // at init and after every base-style switch, since setStyle() wipes
  // paint overrides along with everything else — and again whenever the
  // user toggles the pin-style buttons. Per-feature state that these
  // paint expressions read (optimized, passed) lives on the GeoJSON
  // features themselves (see buildStopsFeatureCollection/renderRoute) and
  // updates on its own via setData(), so it never needs a call here.
  function applyPinStyle() {
    if (!map || !map.getLayer('stops-circle-layer')) return;
    const modern = pinStyle === 'modern';
    // 'legacy': the pre-swisstopo look — amber route line matching the
    // marker colour, no white casing under it. Markers themselves never
    // changed, so legacy shares every marker rule below with 'classic'.
    const legacy = pinStyle === 'legacy';
    ensureMapImagesRegistered(); // in case an SVG finished loading after this style switch's addOverlayLayers()

    // 'classic': plain numbered circle, unchanged, every stop including
    // seq 1. 'modern': the pin icons (stops-pin-icon-layer/-badge-layer)
    // instead — the two circle layers are simply hidden rather than
    // repurposed, since a multi-colour icon can't reuse their paint
    // expressions (see PIN_PENDING_IMAGE_ID's comment above).
    map.setFilter('stops-circle-layer', null);
    map.setFilter('stops-label-layer', null);
    map.setLayoutProperty('stops-circle-layer', 'visibility', modern ? 'none' : 'visible');
    map.setLayoutProperty('stops-label-layer', 'visibility', modern ? 'none' : 'visible');
    map.setPaintProperty('stops-circle-layer', 'circle-color', '#171D26');
    // NB: a 'case' expression is [cond, value, ..., fallback] — the
    // fallback stands alone, never as a trailing "true, value" pair (an
    // even argument count fails validation and MapLibre silently drops
    // the whole setPaintProperty, leaving the previous colour in place).
    map.setPaintProperty('stops-circle-layer', 'circle-stroke-color', ['case', ['get', 'walkOnly'], WALK_ONLY_BLUE, MODERN_AMBER]);
    map.setLayoutProperty('stops-label-layer', 'text-field', ['to-string', ['get', 'seq']]);
    map.setPaintProperty('stops-label-layer', 'text-color', ['case', ['get', 'walkOnly'], WALK_ONLY_BLUE, MODERN_AMBER]);

    // Every stop gets a pin, seq 1 included — start-point-layer below (the
    // old "bigger dot, no number" treatment for the departure point) is
    // retired in 'modern' in its favour. The pending/visited split is the
    // pair of static `passed` filters set where the layers are created.
    map.setLayoutProperty('stops-pin-icon-layer', 'visibility', modern ? 'visible' : 'none');
    map.setLayoutProperty('stops-pin-badge-layer', 'visibility', modern ? 'visible' : 'none');
    map.setLayoutProperty('start-point-layer', 'visibility', 'none');

    // A leg with no route at all (see renderRoute's doc comment) always
    // wins the colour regardless of pin style — it isn't a real road, so
    // it must never read as just another optimized/unoptimized stretch.
    // The optimized-route blue below is what "Animar rota" traces over in
    // green as it goes (see animation-progress-line-layer just below).
    map.setPaintProperty('route-line-layer', 'line-color', modern
      ? ['case', ['get', 'unreachable'], '#E2665B', ['get', 'optimized'], MODERN_ROUTE_BLUE, MODERN_GREY]
      : ['case', ['get', 'unreachable'], '#E2665B', legacy ? MODERN_AMBER : ROUTE_BLUE]);
    // legacy has no halo under the line (that's what it looked like before
    // the swisstopo base needed one for contrast) — hidden, not removed,
    // so addOverlayLayers() doesn't have to know about pinStyle at all.
    map.setLayoutProperty('route-line-casing-layer', 'visibility', legacy ? 'none' : 'visible');

    // The traced "already traveled" highlight during "Animar rota" — white
    // (today's look) in 'classic'/'legacy', green in 'modern' (same green
    // as the moving marker and the ✓ pin's roundel) so the covered stretch
    // reads as "done" against the still-blue rest of the route.
    map.setPaintProperty('animation-progress-line-layer', 'line-color', modern ? MODERN_PROGRESS_GREEN : '#ffffff');

    updateRouteLineDasharray();
  }

  // line-dasharray isn't a data-driven paint property in MapLibre (unlike
  // line-color/line-width above), so it can't ride the 'optimized' feature
  // property via an expression — it has to be re-applied imperatively
  // whenever pinStyle or routeIsOptimized change.
  function updateRouteLineDasharray() {
    if (!map || !map.getLayer('route-line-layer')) return;
    const dashed = pinStyle === 'modern' && !routeIsOptimized;
    map.setPaintProperty('route-line-layer', 'line-dasharray', dashed ? [1, 1.4] : null);
  }

  function updatePinStyleUI() {
    const group = $('pinStyleGroup');
    if (!group) return;
    group.querySelectorAll('[data-pin-style]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-pin-style') === pinStyle);
    });
  }

  function setPinStyle(styleId) {
    if (!['classic', 'modern', 'legacy'].includes(styleId) || styleId === pinStyle) return;
    pinStyle = styleId;
    try { window.localStorage.setItem(PIN_STYLE_STORAGE_KEY, styleId); } catch (_) { /* private browsing etc */ }
    updatePinStyleUI();
    applyPinStyle();
  }

  // Redraws whatever data was already on screen (route, stops, blocked
  // segments) on top of a freshly rebuilt set of layers — needed after a
  // style switch, since addOverlayLayers() above only recreates empty
  // sources. Transient interactive state (a block preview mid-edit, the
  // two picked points, an in-progress animation frame) is deliberately
  // NOT restored: switching the base map is rare enough that resetting
  // those is simpler and safer than trying to resume them mid-style-load.
  function redrawOverlaysAfterStyleSwitch() {
    if (lastRoute) {
      renderRoute(lastRoute, false);
      renderStops(lastRoute.stops);
    }
    renderExcludedSegments(inForceRestrictions);
  }

  function setMapStyle(styleId) {
    if (!MAP_STYLES[styleId] || styleId === currentMapStyle) return;
    currentMapStyle = styleId;
    try { window.localStorage.setItem(MAP_STYLE_STORAGE_KEY, styleId); } catch (_) { /* private browsing etc */ }
    updateMapStyleUI();
    if (!map) return; // just remembered for when the map is actually created
    stopAnimation();
    resetPicking();
    map.once('style.load', () => {
      addOverlayLayers();
      redrawOverlaysAfterStyleSwitch();
    });
    map.setStyle(buildBaseStyle(currentMapStyle));
  }

  // ---------- "Animar rota" (stop-to-stop playback) ----------
  // Duration scales with the route's real length (see computeAnimationDuration)
  // instead of a single fixed value — a 2km round and a 200km round used to
  // take the exact same 8s, which either crawled or blitzed by depending on
  // the route. MIN/MAX just keep both extremes watchable.
  const ANIMATION_MIN_DURATION_MS = 8000;
  const ANIMATION_MAX_DURATION_MS = 120000;
  const ANIMATION_REFERENCE_SPEED_MPS = 25; // ~90km/h "demo" pace before clamping
  const ANIMATION_DWELL_MS = 900; // pause length at each stop
  // Camera zoom while following the moving marker never goes tighter/wider
  // than this, however dense or sparse the stops around it are — mirrors the
  // maxZoom already used by fitBounds elsewhere (renderRoute/recenterOnRoute).
  const MIN_ANIMATION_ZOOM = 11;
  const MAX_ANIMATION_ZOOM = 16;
  // Below this next-stop distance the camera zooms all the way to
  // MAX_ANIMATION_ZOOM; beyond it, all the way to MIN_ANIMATION_ZOOM;
  // linearly interpolated in between.
  const ANIMATION_ZOOM_NEAR_M = 150;
  const ANIMATION_ZOOM_FAR_M = 3000;
  // "Safe zone" for the follow camera, as a fraction of the shorter viewport
  // dimension — while the animated marker stays within this radius of the
  // screen centre, the camera holds still; only once it nears the edge does
  // it ease back to centred, so the map doesn't tremble every frame.
  const ANIMATION_SAFE_ZONE_RATIO = 0.32;
  const ANIMATION_CAMERA_EASE_MS = 500;
  let animating = false; // true while frames are actively advancing
  let animationSessionActive = false; // true from "Animar rota" until stop/reset or natural end
  let animationFrameId = null;
  let animationCumulative = null; // precomputed once per route: { coords, distances, total }
  let animationDurationMs = ANIMATION_MIN_DURATION_MS; // computed once per session by computeAnimationDuration()
  let animationProgress = 0; // meters traveled so far — persists across pause/resume
  let animationSpeed = 1; // multiplier, changed via the speed preset buttons
  let animationLastFrameTime = null;
  let animationStopMarkers = null; // [{ seq, address, distance }], in route order
  let animationNextStopIdx = 0;
  // pointAtDistance()'s own fromIndex cursor for the per-frame scan below
  // — animationProgress only ever increases while playing, so each frame
  // can resume scanning right where the last one left off instead of
  // re-walking the whole route geometry from the start every time.
  let animationScanIndex = 1;
  // nextStopPoint only actually changes when animationNextStopIdx does —
  // recomputing it via a full pointAtDistance() scan on every frame
  // (as opposed to once per stop) was pure waste.
  let animationNextStopPointCache = null;
  let animationDwellTimeoutId = null;
  let animationTooltipEl = null;
  let animationPassedSeqs = new Set(); // seqs already reached — drives the "modern" style's greyed-out/checkmark look
  // True from the first click on "Animar rota" (revealing speed + pin-style
  // controls and a "▶ Play" button to actually start it) until the
  // animation is stopped/reset — lets the person configure before playing
  // instead of the animation starting immediately.
  let animateControlsExpanded = false;
  // Follow-camera state — separate from the animation timeline itself (the
  // route keeps progressing at its own pace no matter what the camera does).
  let animationFollowMode = true;
  let animationCameraEasing = false; // true while an easeTo() from the safe-zone check is in flight
  let animationBounds = null; // computed once per session, reused by the initial and final framing

  function $(id) { return document.getElementById(id); }

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  function formatDelta(meters, seconds) {
    const km = meters / 1000;
    const kmStr = (km >= 0 ? '+' : '') + km.toFixed(1) + ' km';
    const minutes = Math.round(seconds / 60);
    const minStr = (minutes >= 0 ? '+' : '') + minutes + ' min';
    return { kmStr, minStr };
  }

  // ---------- Map + layer setup ----------

  // WebGL context creation can fail synchronously (thrown from the
  // constructor) or asynchronously (an unhandled promise rejection deep in
  // MapLibre's own init chain, depending on browser/GPU) — both look like
  // the same "Failed to initialize WebGL" message, so one handler covers
  // both entry points.
  function isWebglInitError(err) {
    const msg = err && (err.message || String(err));
    return typeof msg === 'string' && /webgl/i.test(msg);
  }

  function handleMapInitFailure() {
    if (mapUnavailable) return; // already handled
    mapUnavailable = true;
    if (map) { try { map.remove(); } catch (_) { /* already broken, nothing to clean up */ } }
    map = null;
    showMapUnavailable();
    if (mapReadyResolve) mapReadyResolve(); // unblock any pending `await mapReady`
  }

  function showMapUnavailable() {
    $('mapContainer').style.display = 'none';
    $('mapToolbar').style.display = 'none';
    $('mapStyleGroup').style.display = 'none';
    $('pinStyleGroup').style.display = 'none';
    $('mapEmptyState').style.display = '';
    $('mapEmptyState').textContent = t('mapWebglUnavailable');
    $('stopsPanel').style.display = 'none';
  }

  function ensureMap() {
    if (map || mapUnavailable) return map;

    mapReady = new Promise((resolve) => { mapReadyResolve = resolve; });

    // Only ours to handle while this init is in flight — cleared as soon
    // as the map either loads or fails, so it never intercepts unrelated
    // promise rejections elsewhere on the page.
    const onUnhandledRejection = (e) => {
      if (isWebglInitError(e.reason)) {
        e.preventDefault();
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        handleMapInitFailure();
      }
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    try {
      map = new maplibregl.Map({
        container: 'mapContainer',
        style: buildBaseStyle(currentMapStyle),
        center: [7.4474, 46.9481],
        zoom: 9,
      });
    } catch (err) {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      if (isWebglInitError(err)) { handleMapInitFailure(); return null; }
      throw err;
    }

    map.on('error', (e) => {
      if (isWebglInitError(e && e.error)) {
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        handleMapInitFailure();
        return;
      }
      // Having an 'error' listener at all stops MapLibre logging on its
      // own — so anything else (a rejected layer spec, a bad paint
      // expression, a missing image) would otherwise vanish without a
      // trace. Tile/glyph fetch hiccups are routine and noisy, so those
      // stay quiet; everything else is a real bug worth seeing.
      const msg = e && e.error && e.error.message;
      if (msg && !/AJAXError|glyph|tile/i.test(msg)) console.error('[map] ' + msg);
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      addOverlayLayers();

      map.on('click', onMapClick);

      // "Agrupar (a pé)": a freehand drag traces the shape. mousedown/up
      // gate the drawing session; mousemove keeps firing throughout
      // (dragPan is disabled for the duration in startGroupDrawing, so it
      // never competes with the map's own pan gesture). Touch equivalents
      // for a tablet, same handlers — MapLibre normalises both to the
      // same {lngLat} shape.
      map.on('mousedown', onGroupDrawStart);
      map.on('touchstart', onGroupDrawStart);
      map.on('mousemove', onGroupDrawMove);
      map.on('touchmove', onGroupDrawMove);
      map.on('mouseup', onGroupDrawEnd);
      map.on('touchend', onGroupDrawEnd);

      // Clicking a numbered stop shows its address in a popup — only
      // while idle, so it doesn't fight with "Excluir troço" point-picking
      // (that mode's own onMapClick handler runs regardless of layer).
      // Circle layer only for 'classic' (the number label sits inside the
      // circle, so binding both would open two identical popups on one
      // click); the two 'modern' pin layers each carry their own number,
      // so they bind directly. Only one set is ever visible at a time.
      ['stops-circle-layer', 'stops-pin-icon-layer', 'stops-pin-badge-layer'].forEach((layerId) => {
        map.on('click', layerId, onStopClick);
        map.on('mouseenter', layerId, () => { if (mode === 'idle') map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
      });

      // Clicking the drawn route while blocking picks the whole leg
      // (stop → stop) the click landed on.
      map.on('click', 'route-line-layer', onRouteLineClick);
      map.on('mouseenter', 'route-line-layer', () => { if (mode === 'block-line') map.getCanvas().style.cursor = 'crosshair'; });
      map.on('mouseleave', 'route-line-layer', () => { map.getCanvas().style.cursor = ''; });

      // "Animar rota"'s follow camera backs off the moment the driver
      // touches the map themselves — checked via originalEvent, which
      // MapLibre only sets on gestures that came from the mouse/touch/wheel,
      // never on our own fitBounds()/easeTo() calls. Re-armed by clicking
      // "Centrar rota" (see recenterOnRoute()) rather than a second control.
      const disableFollowOnUserGesture = (e) => {
        if (animationSessionActive && e.originalEvent) animationFollowMode = false;
      };
      map.on('dragstart', disableFollowOnUserGesture);
      map.on('zoomstart', disableFollowOnUserGesture);
      map.on('rotatestart', disableFollowOnUserGesture);

      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      mapReadyResolve();
    });

    return map;
  }

  function setSourceData(id, data) {
    if (!map) return; // clear()/resetPicking() can run before the map exists
    const src = map.getSource(id);
    if (src) src.setData(data);
  }

  // ---------- Rendering ----------

  function computeBounds(coords) {
    if (!coords || coords.length === 0) return null;
    return coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  }

  // `route` is the full lastRoute-shaped object (geometry + legs), not
  // just the geometry — a leg valhallaRouteAllowingGaps() couldn't find
  // any path for (several saved road blocks combined sealing a stop off,
  // see server.js's /api/route comment) carries `unreachable: true`, and
  // that needs to reach the paint expression in applyPinStyle() as its
  // own feature so it can be drawn in a visibly different colour instead
  // of blending into the rest of the route as if it were a real road.
  //
  // `fitBounds` defaults to true (a genuinely new route is worth framing)
  // but every caller that's really just refreshing the SAME route in
  // place — removing/editing a restriction, toggling "Ver rota antes da
  // otimização", switching map style — passes false, so the driver's own
  // pan/zoom survives instead of snapping back on every small change.
  function renderRoute(route, fitBounds = true) {
    const geometry = route.geometry;
    const legs = Array.isArray(route.legs) && route.legs.length > 0 ? route.legs : [{ geometry, unreachable: false }];
    setSourceData('route-line', {
      type: 'FeatureCollection',
      features: legs.map((leg) => ({
        type: 'Feature',
        geometry: leg.geometry,
        properties: { optimized: routeIsOptimized, unreachable: !!leg.unreachable },
      })),
    });
    updateRouteLineDasharray();
    if (fitBounds) {
      const bounds = computeBounds(geometry.coordinates);
      if (bounds) map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 300 });
    }
  }

  // Public "recentre on the route" action — for when the driver has
  // panned/zoomed away (to check a restriction, read a street name, etc.)
  // and wants back without recalculating anything.
  // ---------- Fullscreen ----------
  // Purely a CSS switch on #mapSection (see .map-fullscreen in styles.css):
  // the same map, toolbar, stops panel and restriction lists just take
  // over the viewport, so an animation or a block being edited carries
  // on untouched. Nothing is recreated — MapLibre only needs a resize().
  function isFullscreen() {
    return document.body.classList.contains('map-fullscreen');
  }

  function updateFullscreenUI() {
    const btn = $('mapToolFullscreen');
    if (!btn) return;
    btn.textContent = isFullscreen() ? t('mapFullscreenExit') : t('mapFullscreen');
    btn.classList.toggle('active', isFullscreen());
  }

  function toggleFullscreen() {
    document.body.classList.toggle('map-fullscreen');
    updateFullscreenUI();
    if (map) {
      map.resize();
      // resize() alone keeps the old centre/zoom; a second pass after the
      // layout settles reframes the route in the new, much larger canvas.
      setTimeout(() => { map.resize(); if (lastRoute && !animationSessionActive) recenterOnRoute(); }, 50);
    }
  }

  function recenterOnRoute() {
    if (!map || !lastRoute) return;
    // Mid-animation, "centrar rota" doubles as the follow camera's own
    // re-enable switch (section 19 of the animation brief: reuse the
    // existing mechanism instead of adding a second control) — snapping
    // back to the moving marker reads better here than framing the whole
    // route, which recenterOnRoute() otherwise does for the non-animating
    // case just below.
    if (animationSessionActive && animationCumulative) {
      animationFollowMode = true;
      const { point } = pointAtDistance(animationCumulative, animationProgress, 1);
      const nextStop = animationStopMarkers[animationNextStopIdx];
      const nextStopPoint = nextStop ? pointAtDistance(animationCumulative, nextStop.distance, 1).point : null;
      const distanceToNextStop = nextStopPoint ? haversineMeters(point, nextStopPoint) : null;
      animationCameraEasing = true;
      map.easeTo({ center: point, zoom: computeAnimationZoom(distanceToNextStop), duration: 600, essential: true });
      map.once('moveend', () => { animationCameraEasing = false; });
      return;
    }
    const bounds = computeBounds(lastRoute.geometry.coordinates);
    if (bounds) map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 600 });
  }

  // /api/route echoes back exactly the (alias-resolved) string that was
  // sent for each stop — which is raw "lat,lng" text whenever an alias
  // points at bare coordinates instead of a postal address. `labels` is
  // what's actually typed/shown in the address box (index.html's
  // `rawAddresses`, before alias resolution), which every on-map display
  // (pins, popups, sidebar list) should show instead.
  function withDisplayLabels(route, labels) {
    if (!Array.isArray(labels) || labels.length !== route.stops.length) return route;
    return { ...route, stops: route.stops.map((s, i) => ({ ...s, address: labels[i] || s.address })) };
  }

  // Shared by renderStops() (fresh route load) and markStopPassed() (an
  // "Animar rota" stop arrival) so the 'passed'/'optimized' properties
  // driving applyPinStyle()'s expressions are built the same way both times.
  function buildStopsFeatureCollection(stops, passedSeqs) {
    return {
      type: 'FeatureCollection',
      features: stops.map((s, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: {
          seq: i + 1, address: s.address, optimized: routeIsOptimized, passed: passedSeqs.has(i + 1),
          walkOnly: walkOnlyEnabled && walkOnlyAddresses.has(s.address),
        },
      })),
    };
  }

  function renderStops(stops) {
    animationPassedSeqs = new Set();
    setSourceData('stops', buildStopsFeatureCollection(stops, animationPassedSeqs));
    renderStopsPanel(stops);
  }

  // Called as "Animar rota" reaches each stop (see beginDwell()) — updates
  // just the 'stops' source so that stop turns grey/checkmarked in
  // 'modern' style, without touching the sidebar panel.
  function markStopPassed(seq) {
    if (!lastRoute) return;
    animationPassedSeqs.add(seq);
    setSourceData('stops', buildStopsFeatureCollection(lastRoute.stops, animationPassedSeqs));
  }

  // ---------- Stops panel (sidebar list, click centers the map) ----------

  function renderStopsPanel(stops) {
    const panel = $('stopsPanel');
    const list = $('stopsPanelList');
    if (!panel || !list) return;
    panel.style.display = stops.length > 0 ? '' : 'none';
    list.innerHTML = '';
    stops.forEach((s, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'stops-panel-item';
      item.title = t('stopsPanelItemTitle');
      item.innerHTML = '<span class="num">' + (i + 1) + '</span><span>' + escapeHtml(s.address) + '</span>';
      item.addEventListener('click', () => {
        map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 15), essential: true });
        showStopPopup(i + 1, s.address, { lng: s.lng, lat: s.lat });
      });
      list.appendChild(item);
    });
  }

  function renderExcludedSegments(restrictions) {
    setSourceData('excluded-segments', {
      type: 'FeatureCollection',
      features: restrictions.map((r) => ({ type: 'Feature', geometry: r.geometry, properties: { id: r.id } })),
    });
  }

  // Pans/zooms the camera to frame a restriction's excluded segment —
  // same fitBounds pattern renderRoute() uses for the whole route, just
  // tighter (a street segment is small) and with a visible camera move
  // since this is a deliberate "take me there" click, not an auto-fit.
  function focusOnRestriction(geometry) {
    if (!map) return;
    const coords = geometry.coordinates;
    if (!coords || coords.length === 0) return;
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 600 });
  }

  // "sempre" / "até 7/9/2026" / "7/9/2026 → 9/9/2026", so a block's
  // window is visible in the list without opening anything.
  function restrictionWindowText(r) {
    const asDate = (iso) => new Date(iso).toLocaleDateString();
    if (!r.startsAt && !r.expiresAt) return t('restrictionForever');
    if (r.startsAt && r.expiresAt) return t('restrictionFromUntil', { from: asDate(r.startsAt), until: asDate(r.expiresAt) });
    if (r.expiresAt) return t('restrictionUntil', { date: asDate(r.expiresAt) });
    return t('restrictionFromUntil', { from: asDate(r.startsAt), until: '…' });
  }

  function renderActiveRestrictionsList(restrictions) {
    const section = $('activeRestrictionsSection');
    const box = $('activeRestrictionsList');
    if (!section || !box) return;
    section.style.display = restrictions.length > 0 ? '' : 'none';
    box.innerHTML = '';
    restrictions.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'alias-list-item';
      row.style.cursor = 'pointer';
      row.title = t('focusRestrictionTitle');
      row.innerHTML =
        '<div><div class="from">🚧 ' + escapeHtml(r.reason || t('blockedRoadLabel')) + '</div>' +
        '<div class="to">' + escapeHtml(restrictionWindowText(r)) + '</div></div>' +
        '<button class="alias-remove" data-id="' + escapeHtml(r.id) + '" title="' + escapeHtml(t('removeRestrictionTitle')) + '">✕</button>';
      row.addEventListener('click', () => focusOnRestriction(r.geometry));
      box.appendChild(row);
    });
    box.querySelectorAll('.alias-remove').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // nao acionar o focusOnRestriction da linha
        const id = e.currentTarget.getAttribute('data-id');
        try {
          await fetch('/api/road-restrictions/' + encodeURIComponent(id), { method: 'DELETE' });
          if (lastRequestParams) await loadRoute({ ...lastRequestParams, preserveView: true });
        } catch (err) { /* falha silenciosa — a lista fica como estava */ }
      });
    });
  }

  // Turns the server's "no alternative route" into something the driver
  // can act on. Nearly always the block has sealed off one delivery — not
  // necessarily because its polygon covers the doorstep (it usually cuts
  // the street short of it instead, see server.js's comment on
  // blockedByNewBlock), but because the new block is the whole reason no
  // detour exists — so the fix is to move/shorten IT, not to go hunting
  // through already-saved blocks that have nothing to do with it.
  function blockErrorMessage(data){
    const stranded = Array.isArray(data && data.unreachable) ? data.unreachable : [];
    if(stranded.length === 0) return (data && data.error) || t('mapPreviewError');

    const names = stranded.map(s => s.address).join(', ');
    return stranded.some(s => s.blockedByNewBlock)
      ? t('blockSealsStopInside', {stops: names})
      : t('blockSealsStopElsewhere', {stops: names});
  }

  async function refreshActiveRestrictions() {
    try {
      const res = await fetch('/api/road-restrictions?includeScheduled=1');
      const list = res.ok ? await res.json() : [];
      knownRestrictions = list;
      // Only blocks whose window is already open are drawn on the map —
      // a 🚧 overlay on a road that is still perfectly usable today
      // would be a lie.
      const now = Date.now();
      inForceRestrictions = list.filter((r) => !r.startsAt || new Date(r.startsAt).getTime() <= now);
      renderExcludedSegments(inForceRestrictions);
      renderActiveRestrictionsList(list);
    } catch (err) { /* mapa continua a funcionar sem a lista */ }
  }

  // Same list "Endereços interditos" (section 04 in the sidebar) already
  // maintains — mirrored here, right next to "Troços excluídos ativos",
  // so a walk-only group just created with "Agrupar (a pé)" is visible
  // (and removable) without leaving the map screen. Shows every walk-only
  // address, not just ones the drawing tool created — the sidebar picker
  // and this list are two views of the exact same server-side list.
  function renderWalkOnlyList(list) {
    const section = $('walkOnlySection');
    const box = $('walkOnlyList');
    if (!section || !box) return;
    section.style.display = list.length > 0 ? '' : 'none';
    box.innerHTML = '';
    list.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'alias-list-item';
      row.innerHTML =
        '<div><div class="from">🚶 ' + escapeHtml(b.address) + '</div>' +
        (b.reason ? '<div class="to">' + escapeHtml(b.reason) + '</div>' : '') +
        (b.parkingPoint ? '<div class="to">🅿️ ' + escapeHtml(b.parkingPoint) + '</div>' : '') +
        '</div>' +
        '<button class="alias-remove" data-address="' + escapeHtml(b.address) + '" title="' + escapeHtml(t('aliasRemoveTitle')) + '">✕</button>';
      box.appendChild(row);
    });
    box.querySelectorAll('.alias-remove').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const address = e.currentTarget.getAttribute('data-address');
        try {
          await fetch('/api/blocked', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
          });
          await refreshWalkOnlyList();
          if (onBlockedAddressesChanged) onBlockedAddressesChanged({ successCount: 1, total: 1 });
        } catch (err) { /* a lista fica como estava */ }
      });
    });
  }

  async function refreshWalkOnlyList() {
    try {
      const res = await fetch('/api/blocked');
      const list = res.ok ? await res.json() : [];
      renderWalkOnlyList(list);
      walkOnlyAddresses = new Set(list.map((b) => b.address));
      // Re-tag the markers already on screen — via setSourceData directly
      // (not renderStops(), which would reset animationPassedSeqs and
      // undo "Animar rota" progress if this runs mid-animation).
      if (lastRoute) setSourceData('stops', buildStopsFeatureCollection(lastRoute.stops, animationPassedSeqs));
    } catch (err) { /* mapa continua a funcionar sem a lista */ }
  }

  // ---------- "Animar rota" ----------

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Cumulative distance (meters) up to each coordinate, walked once per
  // route so per-frame animation work is just a scan forward from the
  // last position found (progress only ever increases).
  function buildCumulative(coords) {
    const distances = [0];
    for (let i = 1; i < coords.length; i++) {
      distances.push(distances[i - 1] + haversineMeters(coords[i - 1], coords[i]));
    }
    return { coords, distances, total: distances[distances.length - 1] };
  }

  // Returns { point, slicedCoords } for how far along the route
  // `targetDistance` meters gets you — slicedCoords is every coordinate
  // up to and including the interpolated point, ready for the
  // progressively-drawn highlight line.
  function pointAtDistance(cumulative, targetDistance, fromIndex) {
    const { coords, distances, total } = cumulative;
    const target = Math.min(Math.max(targetDistance, 0), total);
    let i = Math.max(fromIndex, 1);
    while (i < distances.length && distances[i] < target) i++;
    i = Math.min(i, distances.length - 1);
    const segStart = distances[i - 1];
    const segEnd = distances[i];
    const segLen = segEnd - segStart;
    const t2 = segLen > 0 ? (target - segStart) / segLen : 0;
    const a = coords[i - 1];
    const b = coords[i];
    const point = [a[0] + (b[0] - a[0]) * t2, a[1] + (b[1] - a[1]) * t2];
    return { point, slicedCoords: coords.slice(0, i).concat([point]), nextIndex: i };
  }

  // For each stop, finds the closest point along the route's cumulative
  // distances and records its distance-from-start. Stops are assumed to
  // appear in route order (the routing engine visits them in the given
  // sequence), so this walks the coordinate list once forward instead of
  // re-searching it in full for every stop.
  function computeStopMarkers(cumulative, stops) {
    const { coords, distances } = cumulative;
    let coordIdx = 0;
    return stops.map((s, i) => {
      let bestErr = haversineMeters([s.lng, s.lat], coords[coordIdx]);
      let bestIdx = coordIdx;
      for (let idx = coordIdx + 1; idx < coords.length; idx++) {
        const err = haversineMeters([s.lng, s.lat], coords[idx]);
        if (err < bestErr) { bestErr = err; bestIdx = idx; continue; }
        // Only give up once the stop has clearly been found and the
        // route is heading away from it again. Bailing out earlier
        // breaks on geometry that legitimately moves away first (one-way
        // systems, loops), which would collapse this stop onto the
        // previous one and produce a zero-length leg.
        if (bestErr < 100 && err > bestErr + 200) break;
      }
      coordIdx = bestIdx;
      return { seq: i + 1, address: s.address, distance: distances[bestIdx] };
    });
  }

  // Builds (once per route) the cumulative distances and the
  // distance-from-start of every stop. Returns null when there's no
  // route on screen yet.
  function ensureRouteMetrics() {
    if (!lastRoute || !lastRoute.geometry || lastRoute.geometry.coordinates.length < 2) return null;
    if (!routeCumulative) {
      routeCumulative = buildCumulative(lastRoute.geometry.coordinates);
      routeStopMarkers = computeStopMarkers(routeCumulative, lastRoute.stops);
    }
    return routeCumulative;
  }

  // The stretch of the drawn route between two distances-from-start,
  // interpolated at both ends so it starts and finishes exactly where
  // asked rather than at the nearest vertex.
  function sliceCoordsBetween(cumulative, fromDistance, toDistance) {
    const start = pointAtDistance(cumulative, fromDistance, 1).point;
    const end = pointAtDistance(cumulative, toDistance, 1).point;
    const middle = cumulative.coords.filter(
      (_, i) => cumulative.distances[i] > fromDistance && cumulative.distances[i] < toDistance
    );
    return [start].concat(middle, [end]);
  }

  function updateAnimationUI() {
    const animateBtn = $('mapToolAnimate');
    const playBtn = $('mapToolAnimatePlay');
    const stopBtn = $('mapToolAnimateStop');
    const speedGroup = $('animSpeedGroup');
    const styleGroup = $('pinStyleGroup');
    if (!animateBtn) return;

    // Three states: idle ("▶️ Animar rota", nothing else showing),
    // configuring (revealed by that click — speed + pin-style controls and
    // "▶ Play", "Animar rota" itself hidden), playing/paused (back to
    // "Animar rota" doubling as pause/resume, plus "Parar animação").
    const configuring = animateControlsExpanded && !animationSessionActive;

    animateBtn.style.display = configuring ? 'none' : '';
    if (!animationSessionActive) animateBtn.textContent = t('mapToolAnimate');
    else if (animating) animateBtn.textContent = t('mapToolAnimatePause');
    else animateBtn.textContent = t('mapToolAnimateResume');
    animateBtn.classList.toggle('active', animating);

    if (playBtn) playBtn.style.display = configuring ? '' : 'none';
    if (stopBtn) stopBtn.style.display = animationSessionActive ? '' : 'none';
    if (speedGroup) speedGroup.style.display = animateControlsExpanded ? '' : 'none';
    if (styleGroup) styleGroup.style.display = animateControlsExpanded ? 'flex' : 'none';
  }

  function positionAnimationTooltip() {
    if (!animationTooltipEl) return;
    const p = map.project(animationTooltipEl._lngLat);
    // 'modern' pins stand ~PIN_ICON_SIZE*512 px above the point; lift the
    // tooltip clear of the pin so it doesn't hide the ✓ swap it announces.
    const lift = pinStyle === 'modern' ? Math.round(512 * PIN_ICON_SIZE) : 0;
    animationTooltipEl.style.left = p.x + 'px';
    animationTooltipEl.style.top = (p.y - lift) + 'px';
  }

  function hideAnimationTooltip() {
    if (!animationTooltipEl) return;
    map.off('move', positionAnimationTooltip);
    animationTooltipEl.remove();
    animationTooltipEl = null;
  }

  function showAnimationTooltip(seq, address, lngLat) {
    hideAnimationTooltip();
    const el = document.createElement('div');
    el.className = 'animation-stop-tooltip';
    el.textContent = t('stopPopupTitle', { seq }) + ' — ' + address;
    el._lngLat = lngLat;
    map.getContainer().appendChild(el);
    animationTooltipEl = el;
    positionAnimationTooltip();
    map.on('move', positionAnimationTooltip);
  }

  // Route length at 1x -> a watchable duration, clamped so a short hop
  // doesn't blink by and a cross-country round doesn't take minutes.
  function computeAnimationDuration(totalMeters) {
    const rawMs = (totalMeters / ANIMATION_REFERENCE_SPEED_MPS) * 1000;
    return clamp(rawMs, ANIMATION_MIN_DURATION_MS, ANIMATION_MAX_DURATION_MS);
  }

  // Bounds for the initial and final framing — the route geometry alone can
  // miss a stop set slightly off the road (a building set back from it), so
  // every stop's own coordinate is folded in too.
  function computeAnimationBounds() {
    const coords = animationCumulative.coords.concat(lastRoute.stops.map((s) => [s.lng, s.lat]));
    return computeBounds(coords);
  }

  // Nearer next stop -> tighter zoom (streets/marker clearly readable);
  // farther next stop -> wider zoom (the upcoming stretch stays in view).
  // Always within [MIN_ANIMATION_ZOOM, MAX_ANIMATION_ZOOM] — never the
  // "zoom=18 just because stops are close together" the driver would hate.
  function computeAnimationZoom(distanceToNextStop) {
    if (distanceToNextStop == null) return clamp(map.getZoom(), MIN_ANIMATION_ZOOM, MAX_ANIMATION_ZOOM);
    const t = clamp(
      1 - (distanceToNextStop - ANIMATION_ZOOM_NEAR_M) / (ANIMATION_ZOOM_FAR_M - ANIMATION_ZOOM_NEAR_M),
      0, 1
    );
    return MIN_ANIMATION_ZOOM + t * (MAX_ANIMATION_ZOOM - MIN_ANIMATION_ZOOM);
  }

  // Follow camera: holds still while the animated marker is within a "safe
  // zone" around screen centre, and only eases (never snaps) back to
  // centred once it nears the edge — checked, not applied, every frame, so
  // a route with hundreds of stops doesn't trigger a pan on every single
  // one. Independent of the animation timeline itself (section 18 of the
  // brief this implements): the route keeps progressing at its own pace
  // regardless of what the camera is doing.
  function updateAnimationCamera(position, nextStopPoint) {
    if (!animationFollowMode || animationCameraEasing || !map) return;
    const container = map.getContainer();
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const safeRadius = Math.min(w, h) * ANIMATION_SAFE_ZONE_RATIO;
    const screenPoint = map.project(position);
    const dx = screenPoint.x - w / 2;
    const dy = screenPoint.y - h / 2;
    if (Math.sqrt(dx * dx + dy * dy) <= safeRadius) return; // still inside the safe zone — hold the camera

    const distanceToNextStop = nextStopPoint ? haversineMeters(position, nextStopPoint) : null;
    const targetZoom = computeAnimationZoom(distanceToNextStop);
    animationCameraEasing = true;
    map.easeTo({ center: position, zoom: targetZoom, duration: ANIMATION_CAMERA_EASE_MS, essential: true });
    map.once('moveend', () => { animationCameraEasing = false; });
  }

  // A brief ring flash at the exact moment the line reaches a stop — grows
  // then settles back down over ~300ms via the layer's own paint
  // transitions (see addOverlayLayers), so this just sets two values a
  // beat apart instead of running its own animation loop.
  function pulseStopMarker(point) {
    if (!map) return;
    setSourceData('animation-pulse', { type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} });
    map.setPaintProperty('animation-pulse-layer', 'circle-radius', 8);
    map.setPaintProperty('animation-pulse-layer', 'circle-stroke-opacity', 0.9);
    requestAnimationFrame(() => {
      map.setPaintProperty('animation-pulse-layer', 'circle-radius', 22);
      setTimeout(() => {
        map.setPaintProperty('animation-pulse-layer', 'circle-radius', 8);
        map.setPaintProperty('animation-pulse-layer', 'circle-stroke-opacity', 0);
      }, 200);
    });
  }

  function beginDwell(stop) {
    if (animationFrameId !== null) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    const { point } = pointAtDistance(animationCumulative, stop.distance, 1);
    markStopPassed(stop.seq);
    pulseStopMarker(point);
    showAnimationTooltip(stop.seq, stop.address, point);
    animationDwellTimeoutId = setTimeout(() => {
      animationDwellTimeoutId = null;
      hideAnimationTooltip();
      animationLastFrameTime = null;
      if (animating) animationFrameId = requestAnimationFrame(animationStep);
    }, ANIMATION_DWELL_MS);
  }

  function animationStep(now) {
    if (animationLastFrameTime === null) animationLastFrameTime = now;
    const deltaSeconds = (now - animationLastFrameTime) / 1000;
    animationLastFrameTime = now;

    const baseSpeedMps = animationCumulative.total / (animationDurationMs / 1000);
    animationProgress = Math.min(animationProgress + baseSpeedMps * animationSpeed * deltaSeconds, animationCumulative.total);

    const { point, slicedCoords, nextIndex } = pointAtDistance(animationCumulative, animationProgress, animationScanIndex);
    animationScanIndex = nextIndex; // resume from here next frame instead of rescanning from the start
    setSourceData('animation-progress-line', { type: 'Feature', geometry: { type: 'LineString', coordinates: slicedCoords }, properties: {} });
    setSourceData('animation-marker', { type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} });

    // Camera timeline stays entirely separate from the route timeline
    // above — it only ever reads the position just computed, never slows
    // or speeds up the animation itself. nextStopPoint only changes when
    // animationNextStopIdx does (see the cache invalidation below), not
    // every frame, so it's cached instead of rescanned each time.
    const nextStop = animationStopMarkers[animationNextStopIdx];
    if (animationNextStopPointCache === null && nextStop) {
      animationNextStopPointCache = pointAtDistance(animationCumulative, nextStop.distance, 1).point;
    }
    updateAnimationCamera(point, nextStop ? animationNextStopPointCache : null);

    if (animationNextStopIdx < animationStopMarkers.length
        && animationProgress >= animationStopMarkers[animationNextStopIdx].distance) {
      const stop = animationStopMarkers[animationNextStopIdx];
      animationNextStopIdx++;
      animationNextStopPointCache = null; // the next stop changed — recompute its point next frame
      beginDwell(stop);
      return;
    }

    if (animationProgress >= animationCumulative.total) {
      // A last gentle look at the whole route before the usual cleanup —
      // fitBounds() itself just kicks off a map-level tween, so it's safe
      // to let stopAnimation() null out our own bookkeeping right after.
      if (animationBounds) map.fitBounds(animationBounds, { padding: 80, maxZoom: MAX_ANIMATION_ZOOM, duration: 800 });
      stopAnimation(); // also clears the traced line and the moving marker
      return;
    }

    animationFrameId = requestAnimationFrame(animationStep);
  }

  function stopAnimation() {
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    if (animationDwellTimeoutId !== null) clearTimeout(animationDwellTimeoutId);
    animationFrameId = null;
    animationDwellTimeoutId = null;
    animating = false;
    animationSessionActive = false;
    animationCumulative = null;
    animationStopMarkers = null;
    animationProgress = 0;
    animationNextStopIdx = 0;
    animationScanIndex = 1;
    animationNextStopPointCache = null;
    animationLastFrameTime = null;
    animateControlsExpanded = false;
    animationFollowMode = true;
    animationCameraEasing = false;
    animationBounds = null;
    hideAnimationTooltip();
    if (map) {
      setSourceData('animation-progress-line', EMPTY_FC);
      setSourceData('animation-marker', EMPTY_FC);
      setSourceData('animation-pulse', EMPTY_FC);
      if (lastRoute) renderStops(lastRoute.stops); // clears any grey/checkmarked "passed" stops from 'modern' style
    }
    updateAnimationUI();
  }

  function startAnimation() {
    if (!lastRoute || animationSessionActive) return;
    resetPicking(); // "Animar rota" and "Bloquear via" picking are mutually exclusive
    animationCumulative = ensureRouteMetrics();
    animationStopMarkers = routeStopMarkers;
    if (!animationCumulative) return;
    animationProgress = 0;
    animationNextStopIdx = 0;
    animationScanIndex = 1;
    animationNextStopPointCache = null;
    animationLastFrameTime = null;
    animateControlsExpanded = true;
    animationSessionActive = true;
    animating = true;
    animationFollowMode = true;
    animationCameraEasing = false;
    animationDurationMs = computeAnimationDuration(animationCumulative.total);
    animationBounds = computeAnimationBounds();
    updateAnimationUI();

    // Frame the whole route first (section 3 of the brief this implements)
    // and only start drawing once that settles, so the line doesn't begin
    // mid-zoom. Falls back to starting immediately if there's nothing to
    // fit (shouldn't happen with a real route, but ensureRouteMetrics()
    // already guards the geometry-less case above).
    if (animationBounds) {
      map.once('moveend', () => {
        if (animationSessionActive && animating) animationFrameId = requestAnimationFrame(animationStep);
      });
      map.fitBounds(animationBounds, { padding: 80, maxZoom: MAX_ANIMATION_ZOOM, duration: 800 });
    } else {
      animationFrameId = requestAnimationFrame(animationStep);
    }
  }

  function pauseAnimation() {
    if (!animationSessionActive || !animating) return;
    animating = false;
    if (animationFrameId !== null) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (animationDwellTimeoutId !== null) {
      clearTimeout(animationDwellTimeoutId);
      animationDwellTimeoutId = null;
      hideAnimationTooltip();
    }
    updateAnimationUI();
  }

  function resumeAnimation() {
    if (!animationSessionActive || animating) return;
    animating = true;
    animationLastFrameTime = null;
    updateAnimationUI();
    animationFrameId = requestAnimationFrame(animationStep);
  }

  function setAnimationSpeed(speed) {
    animationSpeed = speed;
    document.querySelectorAll('.anim-speed-btn').forEach((btn) => {
      btn.classList.toggle('active', parseFloat(btn.getAttribute('data-speed')) === speed);
    });
  }

  // ---------- Toolbar / interaction modes ----------

  function updateToolbarUI() {
    const blocking = blockPanelOpen || mode !== 'idle';
    $('mapToolSelect').classList.toggle('active', !blocking);
    $('mapToolExclude').classList.toggle('active', blocking);
    $('mapToolGroupWalk').classList.toggle('active', mode === 'group-draw' || mode === 'group-parking');
    const hint = $('mapHint');
    const hintKey = mode === 'block-line' ? 'mapHintPickLine'
      : mode === 'exclude-a' ? 'mapHintPickA'
      : mode === 'exclude-b' ? 'mapHintPickB'
      : mode === 'access-point' ? 'mapHintPickAccessPoint'
      : mode === 'group-draw' ? 'mapHintGroupDraw'
      : mode === 'group-parking' ? 'mapHintGroupParking'
      : null;
    hint.style.display = hintKey ? '' : 'none';
    if (hintKey) hint.textContent = t(hintKey);

    // The pencil only while actually drawing; every other point-picking
    // mode keeps the plain crosshair it already had (set here too, since
    // those modes span the whole map, not one hoverable layer).
    if (map) {
      map.getCanvas().style.cursor = mode === 'group-draw' ? PENCIL_CURSOR
        : (mode === 'exclude-a' || mode === 'exclude-b' || mode === 'access-point' || mode === 'group-parking') ? 'crosshair'
        : '';
    }
  }

  function resetPicking() {
    pickedA = null;
    pickedB = null;
    mode = 'idle';
    blockPanelOpen = false;
    pendingBlockWindow = null;
    pendingBlockReason = '';
    pendingBlockBufferMeters = DEFAULT_BLOCK_BUFFER_METERS;
    pendingPreview = null;
    blockAnchorPoint = null;
    pendingAccessOverrideAddress = null;
    groupIsDrawing = false;
    groupDrawPoints = [];
    groupMatchedAddresses = [];
    groupParkingPoint = null;
    if (map && map.dragPan && !map.dragPan.isEnabled()) map.dragPan.enable();
    setSourceData('pick-points', EMPTY_FC);
    setSourceData('preview-route-line', EMPTY_FC);
    setSourceData('group-draw', EMPTY_FC);
    setSourceData('group-selected-points', EMPTY_FC);
    // Redraw the blocked-segment overlay from what is actually in force:
    // picking a segment draws a draft 🚧 line, and abandoning the flow
    // must not leave that draft behind on a road nobody blocked.
    renderExcludedSegments(inForceRestrictions);
    hideComparisonPanel();
    updateToolbarUI();
  }

  // ---------- "Agrupar (a pé)": draw a shape, bulk-apply walk-only ----------

  function startGroupDrawing() {
    if (!lastRoute) return;
    stopAnimation();
    mode = 'group-draw';
    groupIsDrawing = false;
    groupDrawPoints = [];
    groupMatchedAddresses = [];
    groupParkingPoint = null;
    setSourceData('group-draw', EMPTY_FC);
    setSourceData('group-selected-points', EMPTY_FC);
    setSourceData('pick-points', EMPTY_FC);
    hideComparisonPanel();
    // The map's own pan-by-dragging has to get out of the way for the
    // drag gesture to draw a shape instead of just scrolling the map.
    map.dragPan.disable();
    updateToolbarUI();
  }

  function renderGroupDrawShape() {
    if (groupDrawPoints.length < 2) {
      setSourceData('group-draw', EMPTY_FC);
      return;
    }
    // A LineString while there are too few points for a meaningful area,
    // otherwise a closed ring (first point repeated at the end) so the
    // fill layer actually has something to paint as the driver draws.
    const closed = groupDrawPoints.length >= 3 ? groupDrawPoints.concat([groupDrawPoints[0]]) : groupDrawPoints;
    const geometry = groupDrawPoints.length >= 3
      ? { type: 'Polygon', coordinates: [closed] }
      : { type: 'LineString', coordinates: groupDrawPoints };
    setSourceData('group-draw', { type: 'Feature', geometry, properties: {} });
  }

  function onGroupDrawStart(e) {
    if (mode !== 'group-draw') return;
    groupIsDrawing = true;
    groupDrawPoints = [[e.lngLat.lng, e.lngLat.lat]];
  }

  function onGroupDrawMove(e) {
    if (mode !== 'group-draw' || !groupIsDrawing) return;
    groupDrawPoints.push([e.lngLat.lng, e.lngLat.lat]);
    renderGroupDrawShape();
  }

  function onGroupDrawEnd() {
    if (mode !== 'group-draw' || !groupIsDrawing) return;
    groupIsDrawing = false;
    map.dragPan.enable();
    finishGroupShape();
  }

  // A shape too small/short to have been a deliberate drag (an accidental
  // click-and-release with barely any movement) is treated the same as
  // never having drawn one at all — no confusing "0 addresses" message
  // for what was really just a mis-click.
  const MIN_GROUP_SHAPE_POINTS = 3;

  function finishGroupShape() {
    if (groupDrawPoints.length < MIN_GROUP_SHAPE_POINTS) {
      resetPicking();
      return;
    }

    const stops = lastRoute ? lastRoute.stops : [];
    groupMatchedAddresses = stops
      .filter((s) => pointInPolygon([s.lng, s.lat], groupDrawPoints))
      .map((s) => s.address);
    setSourceData('group-draw', EMPTY_FC); // the outline itself has done its job once we know who's inside it

    if (groupMatchedAddresses.length === 0) {
      mode = 'idle';
      updateToolbarUI();
      showErrorPanel(t('groupWalkNoMatches'));
      return;
    }

    setSourceData('group-selected-points', {
      type: 'FeatureCollection',
      features: stops
        .filter((s) => groupMatchedAddresses.includes(s.address))
        .map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: {} })),
    });

    mode = 'group-parking';
    updateToolbarUI();
  }

  function showConfirmGroupWalkPanel() {
    const list = groupMatchedAddresses.map((a) => '<li>' + escapeHtml(a) + '</li>').join('');
    showComparisonPanel(
      '<div class="totals-panel">' +
        '<p style="margin:0 0 10px;color:var(--text);font-size:14px;">' +
          escapeHtml(t('groupWalkConfirmQuestion', { count: groupMatchedAddresses.length })) +
        '</p>' +
        '<ul style="margin:0 0 14px;padding-left:20px;color:var(--text-dim);font-size:13px;">' + list + '</ul>' +
        '<div class="map-comparison-actions">' +
          '<button class="btn-ghost" id="mapCancelGroupWalkBtn">' + escapeHtml(t('cancelBtn')) + '</button>' +
          '<button class="btn-primary" id="mapConfirmGroupWalkBtn" style="width:auto;">' + escapeHtml(t('groupWalkConfirmBtn')) + '</button>' +
        '</div>' +
      '</div>'
    );
    $('mapCancelGroupWalkBtn').addEventListener('click', resetPicking);
    $('mapConfirmGroupWalkBtn').addEventListener('click', applyGroupWalkOnly);
  }

  // Same endpoint the single-address "Endereços interditos" picker
  // already uses (POST /api/blocked) — this just calls it once per
  // matched address, all with the same parking point, instead of the
  // person doing that by hand one address at a time. Coordinates (not
  // an address string) as the parking point, so the server never has to
  // geocode it — see the isCoord check in server.js's own handler.
  async function applyGroupWalkOnly() {
    const [lng, lat] = groupParkingPoint;
    const parkingPoint = `${lat},${lng}`;
    const addresses = groupMatchedAddresses;

    hideComparisonPanel();
    let successCount = 0;
    try {
      const results = await Promise.all(addresses.map((address) =>
        fetch('/api/blocked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, reason: t('groupWalkReasonDefault'), parkingPoint }),
        }).then((res) => res.ok).catch(() => false)
      ));
      successCount = results.filter(Boolean).length;
    } catch (err) {
      successCount = 0;
    }

    resetPicking();
    // The map's OWN list ("Endereços a pé", right on this screen) is what
    // actually confirms the group took effect without having to go look
    // at the sidebar — refreshed here directly, unlike the sidebar/banner
    // below, which map.js never touches itself.
    await refreshWalkOnlyList();
    // Section 04's picker, the address list's 🚶 tags, and the top status
    // banner all belong to index.html — map.js never touches any of that
    // directly, so the outcome is handed back up instead of shown here.
    if (onBlockedAddressesChanged) onBlockedAddressesChanged({ successCount, total: addresses.length });
  }

  // ---------- Picking the segment to block ----------

  function openBlockPanel() {
    if (!lastRoute) return;
    stopAnimation();
    blockPanelOpen = true;
    setBlockSelectionMode(blockSelectionMode);
  }

  function setBlockSelectionMode(next) {
    blockSelectionMode = next;
    pickedA = null;
    pickedB = null;
    blockAnchorPoint = null;
    setSourceData('pick-points', EMPTY_FC);
    // 'stops' does all its picking in the panel, so the map stays idle.
    mode = next === 'line' ? 'block-line' : next === 'points' ? 'exclude-a' : 'idle';
    showBlockSelectionPanel();
    updateToolbarUI();
  }

  function showBlockSelectionPanel() {
    const stops = lastRoute ? lastRoute.stops : [];
    const stopOptions = stops
      .map((s, i) => '<option value="' + i + '">' + (i + 1) + '. ' + escapeHtml(s.address) + '</option>')
      .join('');
    const modeButton = (id, key) =>
      '<button type="button" class="block-mode-btn' + (blockSelectionMode === id ? ' active' : '') +
      '" data-block-mode="' + id + '">' + escapeHtml(t(key)) + '</button>';

    showComparisonPanel(
      '<div class="totals-panel">' +
        '<label class="field-label">' + escapeHtml(t('blockSelectModeLabel')) + '</label>' +
        '<div class="block-mode-group" id="blockModeGroup">' +
          modeButton('line', 'blockModeLine') +
          modeButton('stops', 'blockModeStops') +
          modeButton('points', 'blockModePoints') +
        '</div>' +
        (blockSelectionMode === 'stops'
          ? '<div class="block-field-pair">' +
              '<div><label class="field-label">' + escapeHtml(t('blockFromStop')) + '</label>' +
                '<select id="blockFromSelect">' + stopOptions + '</select></div>' +
              '<div><label class="field-label">' + escapeHtml(t('blockToStop')) + '</label>' +
                '<select id="blockToSelect">' + stopOptions + '</select></div>' +
            '</div>' +
            '<p class="hint" id="blockStopPairHint" style="display:none;color:var(--red);"></p>'
          : '') +
        '<div class="map-comparison-actions">' +
          '<button class="btn-ghost" id="mapCancelExcludeBtn">' + escapeHtml(t('cancelBtn')) + '</button>' +
          (blockSelectionMode === 'stops'
            ? '<button class="btn-primary" id="blockStopPairContinueBtn" style="width:auto;">' + escapeHtml(t('blockContinueBtn')) + '</button>'
            : '') +
        '</div>' +
      '</div>'
    );

    $('mapCancelExcludeBtn').addEventListener('click', resetPicking);
    $('blockModeGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.block-mode-btn');
      if (btn) setBlockSelectionMode(btn.getAttribute('data-block-mode'));
    });
    if (blockSelectionMode === 'stops') {
      const toSelect = $('blockToSelect');
      if (toSelect && stops.length > 1) toSelect.value = '1'; // default to the first leg
      $('blockStopPairContinueBtn').addEventListener('click', onStopPairContinue);
    }
  }

  function onStopPairContinue() {
    const fromIdx = parseInt($('blockFromSelect').value, 10);
    const toIdx = parseInt($('blockToSelect').value, 10);
    if (fromIdx === toIdx) {
      const hint = $('blockStopPairHint');
      hint.style.display = '';
      hint.textContent = t('blockStopPairError');
      return;
    }
    const from = Math.min(fromIdx, toIdx);
    const to = Math.max(fromIdx, toIdx);
    if (selectSegmentBetweenStops(from, to)) showConfirmExcludePanel();
  }

  // Turns a pair of stop indices into two points that sit exactly ON the
  // drawn route. The stop coordinates themselves are geocoded addresses,
  // which can be a few metres off the road — and the server rejects
  // points that aren't on the route it was given.
  function selectSegmentBetweenStops(idxA, idxB) {
    const cumulative = ensureRouteMetrics();
    if (!cumulative || !routeStopMarkers) return false;
    const a = routeStopMarkers[idxA];
    const b = routeStopMarkers[idxB];
    if (!a || !b) return false;

    pickedA = pointAtDistance(cumulative, a.distance, 1).point;
    pickedB = pointAtDistance(cumulative, b.distance, 1).point;
    setSourceData('pick-points', {
      type: 'FeatureCollection',
      features: [pickedA, pickedB].map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} })),
    });
    setSourceData('excluded-segments', {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: sliceCoordsBetween(cumulative, a.distance, b.distance) },
        properties: {},
      }],
    });
    mode = 'idle';
    updateToolbarUI();
    return true;
  }

  // Index of the stop that CLOSES the leg containing `distance`, so the
  // leg itself is (legEnd - 1) → legEnd. findIndex reports -1 for "past
  // the last stop" and 0 for "before the first one" — opposite ends of
  // the route, so they can't share a fallback.
  function legEndForDistance(stopMarkers, distance) {
    const found = stopMarkers.findIndex((s) => s.distance > distance);
    if (found === -1) return stopMarkers.length - 1;
    if (found === 0) return 1;
    return found;
  }

  function onRouteLineClick(e) {
    if (mode !== 'block-line') return;
    blockAnchorPoint = [e.lngLat.lng, e.lngLat.lat];
    const cumulative = ensureRouteMetrics();
    if (!cumulative || !routeStopMarkers || routeStopMarkers.length < 2) return;

    // How far along the route the click landed, and then the leg (pair
    // of consecutive stops) containing that distance.
    const click = [e.lngLat.lng, e.lngLat.lat];
    let bestIdx = 0;
    let bestErr = Infinity;
    cumulative.coords.forEach((c, i) => {
      const err = haversineMeters(click, c);
      if (err < bestErr) { bestErr = err; bestIdx = i; }
    });
    const clickDistance = cumulative.distances[bestIdx];

    const legEnd = legEndForDistance(routeStopMarkers, clickDistance);
    if (selectSegmentBetweenStops(legEnd - 1, legEnd)) showConfirmExcludePanel();
  }

  // ---------- Stop info popup ----------

  function showStopPopup(seq, address, lngLat) {
    const html =
      '<div class="stop-popup">' +
        '<div class="stop-popup-title">' + escapeHtml(t('stopPopupTitle', { seq })) + '</div>' +
        '<div class="stop-popup-address">' + escapeHtml(address) + '</div>' +
        '<div class="stop-popup-coord">' + lngLat.lat.toFixed(5) + ', ' + lngLat.lng.toFixed(5) + '</div>' +
        '<button type="button" class="stop-popup-copy">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
            '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path>' +
          '</svg>' +
          '<span>' + escapeHtml(t('stopPopupCopyBtn')) + '</span>' +
        '</button>' +
      '</div>';

    // One popup at a time — clicking through the stops panel never fires
    // the map's own close-on-click, so without this they pile up.
    if (stopPopup) stopPopup.remove();
    // focusAfterOpen defaults to true — MapLibre moves keyboard focus into
    // the popup as soon as it opens, which makes the browser scroll that
    // element into view. Since this fires on every click of a stop (in
    // the sidebar list or on the map pin), that shows up as the whole
    // page occasionally jumping. Off, since nothing here needs the popup
    // itself to be keyboard-navigable.
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', focusAfterOpen: false })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
    stopPopup = popup;
    popup.on('close', () => { if (stopPopup === popup) stopPopup = null; });

    const btn = popup.getElement().querySelector('.stop-popup-copy');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(address);
          btn.querySelector('span').textContent = t('stopPopupCopied');
          setTimeout(() => { if (btn.isConnected) btn.querySelector('span').textContent = t('stopPopupCopyBtn'); }, 1200);
        } catch (err) { /* falha silenciosa */ }
      });
    }
  }

  // When two stops sit close together, MapLibre matches all overlapping
  // circles and lists them topmost-first — which is render order (last
  // stop in the route), not necessarily the one nearest the click. Pick by
  // actual distance so a click resolves to the stop the user pointed at,
  // not whichever pin happened to be drawn on top.
  //
  // Two stops sharing the exact same address geocode to identical
  // coordinates (the geocode cache is keyed by address text, see
  // src/cache.js), so their circles fully overlap and distance can't break
  // the tie. In that case fall back to the lowest seq — MapLibre's label
  // layer places symbols in source order and hides later ones that collide,
  // so the number left visible on the map is always the lower one; ties
  // should resolve to whichever stop the user can actually see.
  const CLICK_TIE_EPSILON_M = 0.5;
  function pickClosestFeature(features, click) {
    const withDistance = features.map((f) => ({ f, d: haversineMeters(click, f.geometry.coordinates) }));
    const minD = Math.min(...withDistance.map((x) => x.d));
    const tied = withDistance.filter((x) => x.d - minD <= CLICK_TIE_EPSILON_M).map((x) => x.f);
    return tied.reduce((closest, f) => (f.properties.seq < closest.properties.seq ? f : closest));
  }

  // Ray-casting point-in-polygon: for the "draw a shape, group the
  // addresses inside it" tool — works for whatever shape a freehand drag
  // happens to produce (concave included), never assumes a rectangle or
  // convex hull. `polygon` need not be explicitly closed (the loop wraps
  // from the last point back to the first on its own).
  function pointInPolygon(point, polygon) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function onStopClick(e) {
    if (mode !== 'idle') return; // "Bloquear via" picking takes priority
    if (!e.features || !e.features.length) return;
    const feature = pickClosestFeature(e.features, [e.lngLat.lng, e.lngLat.lat]);
    // The stop's own coordinates, not the click's — otherwise the popup
    // anchors off-marker and reports whatever point was under the cursor.
    const [lng, lat] = feature.geometry.coordinates;
    showStopPopup(feature.properties.seq, feature.properties.address, { lng, lat });
  }

  function onMapClick(e) {
    if (mode === 'idle') return;

    if (mode === 'access-point') {
      confirmAccessOverride({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      return;
    }

    const point = [e.lngLat.lng, e.lngLat.lat];

    if (mode === 'group-parking') {
      groupParkingPoint = point;
      setSourceData('pick-points', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }] });
      mode = 'idle';
      updateToolbarUI();
      showConfirmGroupWalkPanel();
      return;
    }

    if (mode === 'exclude-a') {
      pickedA = point;
      setSourceData('pick-points', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }] });
      mode = 'exclude-b';
      updateToolbarUI();
      return;
    }

    if (mode === 'exclude-b') {
      pickedB = point;
      setSourceData('pick-points', {
        type: 'FeatureCollection',
        features: [pickedA, pickedB].map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} })),
      });
      // Destaque provisório (linha reta entre os 2 cliques) — substituído
      // pelo troço exato assim que o servidor devolver o preview.
      setSourceData('excluded-segments', {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [pickedA, pickedB] }, properties: {} }],
      });
      mode = 'idle';
      updateToolbarUI();
      showConfirmExcludePanel();
    }
  }

  // ---------- Confirm / preview / apply panels ----------

  function showComparisonPanel(html) {
    const panel = $('mapComparisonPanel');
    panel.innerHTML = html;
    panel.style.display = '';
  }

  function hideComparisonPanel() {
    $('mapComparisonPanel').style.display = 'none';
    $('mapComparisonPanel').innerHTML = '';
  }

  function showConfirmExcludePanel() {
    const durationButtons = DURATION_CHOICES.map((choice) =>
      '<button type="button" class="block-duration-btn' + (blockWindowChoice === choice.id ? ' active' : '') +
      '" data-duration="' + choice.id + '">' + escapeHtml(t(choice.key)) + '</button>'
    ).join('');

    showComparisonPanel(
      '<div class="totals-panel">' +
        '<p style="margin:0 0 14px;color:var(--text);font-size:14px;">' + escapeHtml(t('confirmExcludeQuestion')) + '</p>' +
        '<label class="field-label">' + escapeHtml(t('blockReasonLabel')) + '</label>' +
        '<input type="text" id="blockReasonInput" placeholder="' + escapeHtml(t('blockReasonPlaceholder')) + '" style="margin-bottom:14px;" />' +
        '<label class="field-label">' + escapeHtml(t('blockWidthLabel')) + '</label>' +
        '<input type="number" id="blockWidthInput" min="2" max="50" step="1" value="' + pendingBlockBufferMeters + '" style="margin-bottom:2px;" />' +
        '<p class="hint" style="margin-top:0;margin-bottom:14px;">' + escapeHtml(t('blockWidthHint')) + '</p>' +
        '<label class="field-label">' + escapeHtml(t('blockDurationLabel')) + '</label>' +
        '<div class="block-duration-group" id="blockDurationGroup">' + durationButtons + '</div>' +
        '<div class="block-field-pair" id="blockDateFields" style="display:none;">' +
          '<div><label class="field-label">' + escapeHtml(t('blockFromStop')) + '</label>' +
            '<input type="date" id="blockDateFrom" /></div>' +
          '<div id="blockDateToWrap"><label class="field-label">' + escapeHtml(t('blockToStop')) + '</label>' +
            '<input type="date" id="blockDateTo" /></div>' +
        '</div>' +
        '<p class="hint" id="blockWindowError" style="display:none;color:var(--red);"></p>' +
        '<div class="map-comparison-actions">' +
          '<button class="btn-ghost" id="mapCancelExcludeBtn">' + escapeHtml(t('cancelBtn')) + '</button>' +
          '<button class="btn-primary" id="mapConfirmExcludeBtn" style="width:auto;">' + escapeHtml(t('excludeAndRecalcBtn')) + '</button>' +
        '</div>' +
      '</div>'
    );

    updateBlockDateFields();
    $('mapCancelExcludeBtn').addEventListener('click', resetPicking);
    $('blockDurationGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.block-duration-btn');
      if (!btn) return;
      blockWindowChoice = btn.getAttribute('data-duration');
      $('blockDurationGroup').querySelectorAll('.block-duration-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-duration') === blockWindowChoice);
      });
      updateBlockDateFields();
    });
    $('mapConfirmExcludeBtn').addEventListener('click', () => {
      const blockWindow = computeBlockWindow();
      if (blockWindow.error) {
        const errorEl = $('blockWindowError');
        errorEl.style.display = '';
        errorEl.textContent = blockWindow.error;
        return;
      }
      pendingBlockWindow = blockWindow;
      pendingBlockReason = $('blockReasonInput').value.trim();
      const widthVal = parseFloat($('blockWidthInput').value);
      pendingBlockBufferMeters = Number.isFinite(widthVal) ? widthVal : DEFAULT_BLOCK_BUFFER_METERS;
      // A block that hasn't started yet must not re-optimize today's
      // route around a road that's still open — it is only saved, and
      // starts applying by itself once its window opens.
      if (blockWindow.startsAt && new Date(blockWindow.startsAt).getTime() > Date.now()) {
        scheduleBlockForLater();
      } else {
        runPreview();
      }
    });
  }

  function updateBlockDateFields() {
    const fields = $('blockDateFields');
    if (!fields) return;
    const needsDate = blockWindowChoice === 'date' || blockWindowChoice === 'range';
    fields.style.display = needsDate ? '' : 'none';
    $('blockDateToWrap').style.display = blockWindowChoice === 'range' ? '' : 'none';
  }

  // Turns the "today / a date / a range / for ever" choice into the ISO
  // window the server stores. <input type="date"> gives "YYYY-MM-DD",
  // read here as a LOCAL day on purpose: a block "for the 7th" means
  // that whole day where the van is, not a UTC day that would start an
  // hour or two off.
  function computeBlockWindow() {
    const startOfDay = (ymd) => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, m - 1, d, 0, 0, 0, 0);
    };
    const endOfDay = (ymd) => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, m - 1, d, 23, 59, 59, 999);
    };

    if (blockWindowChoice === 'forever') {
      return { type: 'permanent', startsAt: null, expiresAt: null };
    }

    if (blockWindowChoice === 'today') {
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      return { type: 'temporary', startsAt: null, expiresAt: today.toISOString() };
    }

    const from = $('blockDateFrom') ? $('blockDateFrom').value : '';
    if (!from) return { error: t('blockDateMissing') };

    if (blockWindowChoice === 'date') {
      return { type: 'temporary', startsAt: startOfDay(from).toISOString(), expiresAt: endOfDay(from).toISOString() };
    }

    const to = $('blockDateTo') ? $('blockDateTo').value : '';
    if (!to) return { error: t('blockDateMissing') };
    const startsAt = startOfDay(from);
    const expiresAt = endOfDay(to);
    if (expiresAt.getTime() <= startsAt.getTime()) return { error: t('blockDateRangeInvalid') };
    if (expiresAt.getTime() <= Date.now()) return { error: t('blockDatePast') };
    return { type: 'temporary', startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }

  // Saves a block whose window opens later, without previewing or
  // reordering anything: the server only slices and buffers the segment
  // so it can be stored, and today's route is left exactly as it is.
  async function scheduleBlockForLater() {
    showComparisonPanel('<div class="totals-panel"><p style="margin:0;color:var(--text-dim);font-size:13.5px;">' + escapeHtml(t('mapPreviewLoading')) + '</p></div>');
    try {
      const res = await fetch('/api/road-exclusion/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addresses: lastRequestParams.addresses,
          roundTrip: lastRequestParams.roundTrip,
          routeGeometry: lastRoute.geometry,
          pointA: pickedA, pointB: pickedB,
          reason: pendingBlockReason,
          anchorPoint: blockAnchorPoint,
          bufferMeters: pendingBlockBufferMeters,
          scheduleOnly: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) { showErrorPanel(data.error || t('blockScheduledError')); return; }

      const draftRestriction = Object.assign({}, data.draftRestriction, {
        reason: pendingBlockReason,
        type: pendingBlockWindow.type,
        startsAt: pendingBlockWindow.startsAt,
        expiresAt: pendingBlockWindow.expiresAt,
      });
      const saved = await fetch('/api/road-exclusion/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftRestriction }),
      });
      if (!saved.ok) {
        const savedBody = await saved.json().catch(() => ({}));
        showErrorPanel(savedBody.error || t('blockScheduledError'));
        return;
      }

      // Brings the scheduled block into the list (and turns the revert
      // button on) right away, without waiting for the next recalculation.
      await refreshActiveRestrictions();

      const from = new Date(pendingBlockWindow.startsAt).toLocaleDateString();
      showComparisonPanel(
        '<div class="totals-panel">' +
          '<div class="t-label" style="margin-bottom:6px;">🗓️ ' + escapeHtml(t('blockScheduledTitle')) + '</div>' +
          '<p style="margin:0 0 14px;color:var(--text);font-size:13.5px;">' + escapeHtml(t('blockScheduledInfo', { from })) + '</p>' +
          '<div class="map-comparison-actions">' +
            '<button class="btn-ghost" id="mapScheduledCloseBtn">' + escapeHtml(t('closeBtn')) + '</button>' +
          '</div>' +
        '</div>'
      );
      $('mapScheduledCloseBtn').addEventListener('click', resetPicking);
    } catch (err) {
      showErrorPanel(t('serverContactError'));
    }
  }

  function showErrorPanel(message) {
    showComparisonPanel(
      '<div class="totals-panel">' +
        '<p style="margin:0 0 14px;color:var(--red);font-size:13.5px;">' + escapeHtml(message) + '</p>' +
        '<div class="map-comparison-actions">' +
          '<button class="btn-ghost" id="mapDismissErrorBtn">' + escapeHtml(t('cancelBtn')) + '</button>' +
        '</div>' +
      '</div>'
    );
    $('mapDismissErrorBtn').addEventListener('click', resetPicking);
  }

  // ---------- Manual access-point override ----------
  // Lets the driver hand-pick a point for a stop Access Manager's
  // automatic ring couldn't reach on its own (see findAccessibleRoute's
  // doc comment in src/valhalla.js) — offered as a button next to that
  // stop's name in the "unreachable" notice below, in runPreview().

  function startAccessOverridePicking(address) {
    pendingAccessOverrideAddress = address;
    mode = 'access-point';
    updateToolbarUI();
    showComparisonPanel(
      '<div class="totals-panel">' +
        '<p class="hint">' + escapeHtml(t('accessOverridePickHint', { address })) + '</p>' +
        '<div class="map-comparison-actions">' +
          '<button class="btn-ghost" id="mapCancelAccessOverrideBtn">' + escapeHtml(t('cancelBtn')) + '</button>' +
        '</div>' +
      '</div>'
    );
    $('mapCancelAccessOverrideBtn').addEventListener('click', () => {
      pendingAccessOverrideAddress = null;
      mode = 'idle';
      updateToolbarUI();
      runPreview();
    });
  }

  async function confirmAccessOverride(point) {
    const address = pendingAccessOverrideAddress;
    pendingAccessOverrideAddress = null;
    mode = 'idle';
    updateToolbarUI();
    showComparisonPanel('<div class="totals-panel"><p style="margin:0;color:var(--text-dim);font-size:13.5px;">' + escapeHtml(t('mapPreviewLoading')) + '</p></div>');
    try {
      const res = await fetch('/api/access-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, point }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showErrorPanel(body.error || t('mapPreviewError'));
        return;
      }
    } catch (err) {
      showErrorPanel(t('serverContactError'));
      return;
    }
    // The saved point only takes effect on the NEXT preview request —
    // findAccessibleRoute (src/valhalla.js) reads it fresh every call, so
    // simply re-running the same preview is enough to pick it up.
    await runPreview();
  }

  async function runPreview() {
    showComparisonPanel('<div class="totals-panel"><p style="margin:0;color:var(--text-dim);font-size:13.5px;">' + escapeHtml(t('mapPreviewLoading')) + '</p></div>');

    try {
      const res = await fetch('/api/road-exclusion/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addresses: lastRequestParams.addresses,
          roundTrip: lastRequestParams.roundTrip,
          deadlines: lastRequestParams.deadlines,
          startMinutes: lastRequestParams.startMinutes,
          stopMinutes: lastRequestParams.stopMinutes,
          routeGeometry: lastRoute.geometry,
          previousRoute: { distanceMeters: lastRoute.distanceMeters, durationSeconds: lastRoute.durationSeconds },
          pointA: pickedA, pointB: pickedB,
          reason: pendingBlockReason,
          anchorPoint: blockAnchorPoint,
          bufferMeters: pendingBlockBufferMeters,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showErrorPanel(blockErrorMessage(data));
        setSourceData('excluded-segments', EMPTY_FC);
        return;
      }

      pendingPreview = data;
      setSourceData('excluded-segments', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: data.excludedSegment, properties: {} }] });
      const previewLegs = Array.isArray(data.newRoute.legs) && data.newRoute.legs.length > 0
        ? data.newRoute.legs
        : [{ geometry: data.newRoute.geometry, unreachable: false }];
      setSourceData('preview-route-line', {
        type: 'FeatureCollection',
        features: previewLegs.map((leg) => ({ type: 'Feature', geometry: leg.geometry, properties: { unreachable: !!leg.unreachable } })),
      });

      const formatDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
      const notices =
        // A stop the combined blocks seal off entirely — no longer a hard
        // refusal (see server.js's /api/road-exclusion/preview comment on
        // why), just a warning shown alongside the normal comparison so
        // the driver can still choose "Aplicar nova rota" if that's fine.
        (data.unreachable && data.unreachable.length > 0
          ? '<p class="hint" style="color:var(--red);">⚠ ' + escapeHtml(blockErrorMessage(data)) + '</p>' +
            '<div class="map-comparison-actions" id="accessOverrideButtons" style="justify-content:flex-start;margin-bottom:10px;">' +
              data.unreachable.map((s) =>
                '<button type="button" class="btn-ghost access-override-btn" data-address="' + escapeHtml(s.address) + '">' +
                  escapeHtml(t('markAccessPointBtn', { address: s.address })) +
                '</button>'
              ).join('') +
            '</div>'
          : '') +
        (data.trimmed
          ? '<p class="hint" style="color:var(--amber-dim);">⚠ ' + escapeHtml(t('blockTrimmedInfo', {
              blocked: formatDistance(data.blockedMeters), requested: formatDistance(data.requestedMeters),
            })) + '</p>'
          : '') +
        (data.skippedRestrictions && data.skippedRestrictions.length > 0
          ? '<p class="hint" style="color:var(--red);">⚠ ' + escapeHtml(t('blockSkippedInfo', {
              count: data.skippedRestrictions.length,
            })) + '</p>'
          : '');

      const { kmStr: deltaKm, minStr: deltaMin } = formatDelta(
        data.comparison.deltaDistanceMeters || 0, data.comparison.deltaDurationSeconds || 0
      );

      showComparisonPanel(
        '<div class="totals-panel">' +
          '<div class="totals-grid">' +
            '<div class="total-item"><div class="t-label">' + escapeHtml(t('previousRouteLabel')) + '</div>' +
              '<div class="t-value">' + escapeHtml(lastRoute.distanceText) + '</div>' +
              '<div class="t-value" style="font-size:13px;color:var(--text-dim);">' + escapeHtml(lastRoute.durationText) + '</div></div>' +
            '<div class="total-item"><div class="t-label">' + escapeHtml(t('newRouteLabel')) + '</div>' +
              '<div class="t-value accent">' + escapeHtml(data.newRoute.distanceText) + '</div>' +
              '<div class="t-value" style="font-size:13px;color:var(--text-dim);">' + escapeHtml(data.newRoute.durationText) + '</div></div>' +
            '<div class="total-item"><div class="t-label">' + escapeHtml(t('deltaDistanceLabel')) + '</div><div class="t-value">' + deltaKm + '</div></div>' +
            '<div class="total-item"><div class="t-label">' + escapeHtml(t('deltaDurationLabel')) + '</div><div class="t-value">' + deltaMin + '</div></div>' +
          '</div>' +
          notices +
          (data.comparison.orderChanged
            ? '<p class="hint">' + escapeHtml(t('orderChangedInfo', { count: data.comparison.affectedCount })) + '</p>'
            : '') +
          '<p style="margin:14px 0 10px;color:var(--text);font-size:14px;">' + escapeHtml(t('applyNewRouteQuestion')) + '</p>' +
          '<div class="map-comparison-actions">' +
            '<button class="btn-ghost" id="mapKeepPreviousBtn">' + escapeHtml(t('keepPreviousRoute')) + '</button>' +
            '<button class="btn-primary" id="mapApplyNewRouteBtn" style="width:auto;">' + escapeHtml(t('applyNewRoute')) + '</button>' +
          '</div>' +
        '</div>'
      );
      if (data.unreachable && data.unreachable.length > 0) {
        $('accessOverrideButtons').addEventListener('click', (e) => {
          const btn = e.target.closest('.access-override-btn');
          if (btn) startAccessOverridePicking(btn.getAttribute('data-address'));
        });
      }
      $('mapKeepPreviousBtn').addEventListener('click', () => {
        setSourceData('preview-route-line', EMPTY_FC);
        pendingPreview = null;
        refreshActiveRestrictions(); // repõe a lista de trocos ativos (sem o rascunho)
        resetPicking();
      });
      $('mapApplyNewRouteBtn').addEventListener('click', applyPendingPreview);
    } catch (err) {
      showErrorPanel(t('serverContactError'));
    }
  }

  async function applyPendingPreview() {
    if (!pendingPreview) return;
    const draftRestriction = Object.assign({}, pendingPreview.draftRestriction, {
      reason: pendingBlockReason,
      type: pendingBlockWindow ? pendingBlockWindow.type : 'temporary',
      startsAt: pendingBlockWindow ? pendingBlockWindow.startsAt : null,
      expiresAt: pendingBlockWindow ? pendingBlockWindow.expiresAt : null,
    });
    // The route is only reordered once the block is actually stored:
    // reordering against a block the server rejected would leave the
    // deliveries shuffled for a restriction that doesn't exist.
    try {
      const res = await fetch('/api/road-exclusion/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftRestriction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { showErrorPanel(blockErrorMessage(body)); return; }
    } catch (err) {
      showErrorPanel(t('serverContactError'));
      return;
    }

    const order = pendingPreview.order;
    setSourceData('preview-route-line', EMPTY_FC);
    resetPicking();
    if (window.applyReorderedRoute) await window.applyReorderedRoute(order);
  }

  // ---------- Public API ----------

  async function loadRoute(params) {
    // A fresh load fully replaces whatever was on screen — any "Ver rota
    // antes da otimização" preview in progress no longer applies to it,
    // and a plain recalculation (not the result of "Otimizar") means
    // whatever was snapshotted before no longer corresponds to "one click
    // back" from what's about to be shown.
    showingPreOptimizeRoute = false;
    savedOptimizedState = null;
    if (!params.optimized) {
      preOptimizeSnapshot = null;
      preOptimizeRouteCache = null;
    }
    updatePreOptimizeButtonUI();

    lastRequestParams = params;
    stopAnimation();

    if (params.addresses.length < 2) { clear(); return; }

    $('mapEmptyState').style.display = 'none';
    $('mapContainer').style.display = '';
    $('mapToolbar').style.display = '';
    $('mapStyleGroup').style.display = '';
    ensureMap(); // criado (ou apenas redimensionado) DEPOIS de o container ficar visivel
    setTimeout(() => { if (map) map.resize(); }, 0);
    await mapReady; // sources/layers só existem depois do evento 'load' (ou da falha de WebGL)

    if (mapUnavailable) return; // showMapUnavailable() já tratou a UI

    // Desativados durante o recalculo para evitar que "Animar rota" ou
    // "Excluir troço" arranquem com o lastRoute ainda antigo (ex: logo a
    // seguir a aplicar uma exclusão, antes deste fetch terminar).
    $('mapToolExclude').disabled = true;
    $('mapToolAnimate').disabled = true;

    try {
      const res = await fetch('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: params.addresses, mode: 'driving', roundTrip: params.roundTrip, restricted: params.restricted }),
      });

      if (res.status === 501) {
        $('mapContainer').style.display = 'none';
        $('mapToolbar').style.display = 'none';
        $('mapStyleGroup').style.display = 'none';
        $('mapEmptyState').style.display = '';
        $('mapEmptyState').textContent = t('mapNotConfigured');
        $('stopsPanel').style.display = 'none';
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        // Without restoring display here, this message never becomes
        // visible (it was hidden right before the fetch, same as the
        // success path expects) — the map area is left showing whatever
        // was on screen before, with no sign the new route failed. This is
        // exactly what happens when a stop is only reachable via a road
        // that's currently blocked: Valhalla returns 422 and the map
        // silently stops updating.
        $('mapEmptyState').style.display = '';
        $('mapEmptyState').textContent = data.error || t('mapPreviewError');
        $('stopsPanel').style.display = 'none';
        // A failed route is exactly when the "Troços excluídos ativos"
        // list (with its ✕ to remove one) matters most — the block that
        // just broke the route is very likely sitting right there. Without
        // this, the panel only ever populates on a SUCCESSFUL route, so a
        // block that fails every route becomes impossible to remove from
        // the UI at all.
        await refreshActiveRestrictions();
        await refreshWalkOnlyList();
        return;
      }

      lastRoute = withDisplayLabels(data, params.labels);
      routeIsOptimized = !!params.optimized;
      routeCumulative = null; // rebuilt lazily for the new geometry
      routeStopMarkers = null;
      // params.preserveView: a recalculation triggered BEHIND the scenes
      // by something the driver did while already looking at the map
      // (removing/editing a road restriction — see its ✕ handler below) —
      // the addresses are the same, so snapping the view back to fit the
      // whole route on every such tweak would fight whatever they just
      // panned/zoomed to. A genuinely new "Calcular"/"Otimizar" from the
      // form still frames the route as before.
      renderRoute(lastRoute, !params.preserveView);
      renderStops(lastRoute.stops);
      await refreshActiveRestrictions();
      await refreshWalkOnlyList();
    } catch (err) {
      $('mapEmptyState').style.display = '';
      $('mapEmptyState').textContent = t('serverContactError');
      $('stopsPanel').style.display = 'none';
    } finally {
      $('mapToolExclude').disabled = false;
      $('mapToolAnimate').disabled = false;
    }
  }

  function clear() {
    lastRoute = null;
    routeIsOptimized = false;
    pendingPreview = null;
    routeCumulative = null;
    routeStopMarkers = null;
    preOptimizeSnapshot = null;
    preOptimizeRouteCache = null;
    showingPreOptimizeRoute = false;
    savedOptimizedState = null;
    stopAnimation();
    resetPicking();
    updatePreOptimizeButtonUI();
    if (map) {
      setSourceData('route-line', EMPTY_FC);
      setSourceData('stops', EMPTY_FC);
      setSourceData('excluded-segments', EMPTY_FC);
    }
    $('mapContainer').style.display = 'none';
    $('mapToolbar').style.display = 'none';
    $('mapStyleGroup').style.display = 'none';
    $('mapEmptyState').style.display = '';
    $('mapEmptyState').textContent = t('mapEmptyState');
    $('stopsPanel').style.display = 'none';
    $('stopsPanelList').innerHTML = '';
  }

  // ---------- "Ver rota antes da otimização" ----------

  function setPreOptimizeSnapshot(snapshot) {
    preOptimizeSnapshot = snapshot;
    preOptimizeRouteCache = null; // a new "Otimizar" invalidates whatever was fetched for the previous one
    updatePreOptimizeButtonUI();
  }

  function updatePreOptimizeButtonUI() {
    const btn = $('mapToolPreOptimize');
    if (!btn) return;
    btn.disabled = !preOptimizeSnapshot;
    btn.textContent = showingPreOptimizeRoute ? t('mapToolBackToOptimized') : t('mapToolPreOptimize');
    btn.classList.toggle('active', showingPreOptimizeRoute);
  }

  async function togglePreOptimizeRoute() {
    if (showingPreOptimizeRoute) { restorePreOptimizeRoute(); return; }
    if (!preOptimizeSnapshot || !lastRoute) return;
    stopAnimation();
    resetPicking();

    if (!preOptimizeRouteCache) {
      const btn = $('mapToolPreOptimize');
      btn.disabled = true;
      try {
        const res = await fetch('/api/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            addresses: preOptimizeSnapshot.addresses, mode: 'driving', roundTrip: preOptimizeSnapshot.roundTrip,
          }),
        });
        const data = await res.json();
        if (!res.ok) { updatePreOptimizeButtonUI(); return; }
        preOptimizeRouteCache = withDisplayLabels(data, preOptimizeSnapshot.labels);
      } catch (err) {
        updatePreOptimizeButtonUI();
        return;
      }
    }

    savedOptimizedState = { lastRoute, routeIsOptimized, routeCumulative, routeStopMarkers };
    lastRoute = preOptimizeRouteCache;
    routeIsOptimized = false; // "antes de otimizar" always renders in the 'modern' style's pre-optimize look
    routeCumulative = null;
    routeStopMarkers = null;
    renderRoute(lastRoute, false); // comparing in place, same area as before
    renderStops(lastRoute.stops);
    showingPreOptimizeRoute = true;
    // Both tools assume lastRoute matches what's drawn — disabled while a
    // route other than the "real" current one is on screen.
    $('mapToolExclude').disabled = true;
    $('mapToolAnimate').disabled = true;
    updatePreOptimizeButtonUI();
  }

  function restorePreOptimizeRoute() {
    if (!savedOptimizedState) return;
    ({ lastRoute, routeIsOptimized, routeCumulative, routeStopMarkers } = savedOptimizedState);
    savedOptimizedState = null;
    showingPreOptimizeRoute = false;
    renderRoute(lastRoute, false); // comparing in place, same area as before
    renderStops(lastRoute.stops);
    $('mapToolExclude').disabled = false;
    $('mapToolAnimate').disabled = false;
    updatePreOptimizeButtonUI();
  }

  function retranslate() {
    if (map && map.getLayer('excluded-segments-label-layer')) {
      map.setLayoutProperty('excluded-segments-label-layer', 'text-field', '🚧 ' + t('blockedRoadLabel'));
    }
    updatePreOptimizeButtonUI();
    updateToolbarUI();
    updateAnimationUI();
    updateFullscreenUI();
    if (lastRequestParams) refreshActiveRestrictions();
  }

  function init(deps) {
    t = deps.t || t;
    escapeHtml = deps.escapeHtml || escapeHtml;
    onBlockedAddressesChanged = deps.onBlockedAddressesChanged || null;
    onWalkOnlyEnabledChanged = deps.onWalkOnlyEnabledChanged || null;

    const walkOnlyToggle = $('walkOnlyEnabledToggle');
    if (walkOnlyToggle) {
      walkOnlyToggle.checked = walkOnlyEnabled;
      walkOnlyToggle.addEventListener('change', (e) => {
        walkOnlyEnabled = e.target.checked;
        try { localStorage.setItem('walkOnlyEnabled', walkOnlyEnabled ? '1' : '0'); } catch (err) { /* localStorage indisponível */ }
        if (lastRoute) setSourceData('stops', buildStopsFeatureCollection(lastRoute.stops, animationPassedSeqs));
        if (onWalkOnlyEnabledChanged) onWalkOnlyEnabledChanged(walkOnlyEnabled);
      });
    }

    $('mapToolSelect').addEventListener('click', () => { stopAnimation(); resetPicking(); });
    $('mapToolExclude').addEventListener('click', openBlockPanel);
    $('mapToolGroupWalk').addEventListener('click', startGroupDrawing);
    $('mapToolRecenter').addEventListener('click', recenterOnRoute);
    $('mapToolFullscreen').addEventListener('click', toggleFullscreen);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isFullscreen()) toggleFullscreen(); });
    // First click just reveals the speed/pin-style controls + "▶ Play"
    // (see updateAnimationUI()) instead of starting the animation right
    // away; once a session is active this same button doubles as
    // pause/resume, exactly as before.
    $('mapToolAnimate').addEventListener('click', () => {
      if (animationSessionActive) {
        if (animating) pauseAnimation(); else resumeAnimation();
        return;
      }
      animateControlsExpanded = true;
      updateAnimationUI();
    });
    $('mapToolAnimatePlay').addEventListener('click', startAnimation);
    $('mapToolAnimateStop').addEventListener('click', stopAnimation);
    $('animSpeedGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.anim-speed-btn');
      if (!btn) return;
      setAnimationSpeed(parseFloat(btn.getAttribute('data-speed')));
    });
    $('pinStyleGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pin-style]');
      if (!btn) return;
      setPinStyle(btn.getAttribute('data-pin-style'));
    });
    updatePinStyleUI();
    $('mapToolPreOptimize').addEventListener('click', togglePreOptimizeRoute);
    updatePreOptimizeButtonUI();
    $('mapStyleGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.map-style-btn');
      if (!btn) return;
      setMapStyle(btn.getAttribute('data-style'));
    });
    updateMapStyleUI();
  }

  window.RouteMapUI = {
    init, loadRoute, clear, retranslate, setPreOptimizeSnapshot,
    // Pure geometry/permutation helpers, exposed only so they can be
    // unit-tested (see test/map-geometry.test.js). Nothing in the app
    // reads them through here — the map UI itself can't be exercised
    // without a live Valhalla, so these are the parts worth pinning.
    __test: {
      buildCumulative, pointAtDistance, computeStopMarkers,
      sliceCoordsBetween, legEndForDistance, pickClosestFeature,
      pointInPolygon, computeAnimationDuration, computeAnimationZoom,
    },
  };
})();
