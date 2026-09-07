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

  let lastRequestParams = null; // { addresses, roundTrip, deadlines, startMinutes, stopMinutes }
  let lastRoute = null; // last successful /api/route response
  let mode = 'idle'; // 'idle' | 'block-line' | 'exclude-a' | 'exclude-b'
  let pickedA = null; // [lng, lat]
  let pickedB = null;
  let pendingPreview = null; // last /api/road-exclusion/preview response, while its panel is open
  let stopPopup = null; // the one open stop-info popup, if any

  // ---------- "Bloquear via" ----------
  // How the user picks the segment: click the drawn route ('line'),
  // choose a pair of stops from the list ('stops'), or click two free
  // points on the map ('points' — the most flexible, can cut mid-leg).
  let blockPanelOpen = false;
  let blockSelectionMode = 'line';
  let blockWindowChoice = 'today'; // 'today' | 'date' | 'range' | 'forever'
  let pendingBlockWindow = null; // { type, startsAt, expiresAt } awaiting confirmation
  let pendingBlockReason = '';
  // Where the user actually clicked on the route, so the server can
  // centre the blocked piece there when the leg is too long to block whole.
  let blockAnchorPoint = null;
  // Blocks applied in this session, newest last:
  // { restrictionId, order, addressesAfter }. "Reverter bloqueio" only
  // un-reorders the stops when it is removing that exact block AND the
  // address list is still the one it reordered — otherwise inverting a
  // stale permutation would silently scramble the user's own edits.
  let appliedBlocks = [];

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

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  // ---------- "Animar rota" (stop-to-stop playback) ----------
  const ANIMATION_BASE_DURATION_MS = 8000; // time to cover the whole route at 1x
  const ANIMATION_DWELL_MS = 900; // pause length at each stop
  let animating = false; // true while frames are actively advancing
  let animationSessionActive = false; // true from "Animar rota" until stop/reset or natural end
  let animationFrameId = null;
  let animationCumulative = null; // precomputed once per route: { coords, distances, total }
  let animationProgress = 0; // meters traveled so far — persists across pause/resume
  let animationSpeed = 1; // multiplier, changed via the speed preset buttons
  let animationLastFrameTime = null;
  let animationStopMarkers = null; // [{ seq, address, distance }], in route order
  let animationNextStopIdx = 0;
  let animationDwellTimeoutId = null;
  let animationTooltipEl = null;

  function $(id) { return document.getElementById(id); }

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
        style: {
          version: 8,
          sources: {
            'osm-raster': {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '&copy; OpenStreetMap contributors',
            },
          },
          layers: [{ id: 'osm-raster-layer', type: 'raster', source: 'osm-raster' }],
        },
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
      }
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      map.addSource('route-line', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'route-line-layer', type: 'line', source: 'route-line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#E8A33D', 'line-width': 4 },
      });

      map.addSource('preview-route-line', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'preview-route-line-layer', type: 'line', source: 'preview-route-line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#4FAE7C', 'line-width': 4, 'line-dasharray': [1, 1.4] },
      });

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

      map.on('click', onMapClick);

      // Clicking a numbered stop shows its address in a popup — only
      // while idle, so it doesn't fight with "Excluir troço" point-picking
      // (that mode's own onMapClick handler runs regardless of layer).
      // Circle layer only: the number label sits inside the circle, so
      // binding both would open two identical popups on one click.
      map.on('click', 'stops-circle-layer', onStopClick);
      map.on('mouseenter', 'stops-circle-layer', () => { if (mode === 'idle') map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'stops-circle-layer', () => { map.getCanvas().style.cursor = ''; });

      // Clicking the drawn route while blocking picks the whole leg
      // (stop → stop) the click landed on.
      map.on('click', 'route-line-layer', onRouteLineClick);
      map.on('mouseenter', 'route-line-layer', () => { if (mode === 'block-line') map.getCanvas().style.cursor = 'crosshair'; });
      map.on('mouseleave', 'route-line-layer', () => { map.getCanvas().style.cursor = ''; });

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

  function renderRoute(geometry) {
    setSourceData('route-line', { type: 'Feature', geometry, properties: {} });
    const coords = geometry.coordinates;
    if (coords.length > 0) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 300 });
    }
  }

  function renderStops(stops) {
    setSourceData('stops', {
      type: 'FeatureCollection',
      features: stops.map((s, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { seq: i + 1, address: s.address },
      })),
    });
    renderStopsPanel(stops);
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
          if (lastRequestParams) await loadRoute(lastRequestParams);
        } catch (err) { /* falha silenciosa — a lista fica como estava */ }
      });
    });
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
      $('mapToolRevert').style.display = list.length > 0 ? '' : 'none';
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
    const playBtn = $('mapToolAnimate');
    const stopBtn = $('mapToolAnimateStop');
    const speedGroup = $('animSpeedGroup');
    if (!playBtn) return;
    if (!animationSessionActive) playBtn.textContent = t('mapToolAnimate');
    else if (animating) playBtn.textContent = t('mapToolAnimatePause');
    else playBtn.textContent = t('mapToolAnimateResume');
    playBtn.classList.toggle('active', animating);
    if (stopBtn) stopBtn.style.display = animationSessionActive ? '' : 'none';
    if (speedGroup) speedGroup.style.display = animationSessionActive ? '' : 'none';
  }

  function positionAnimationTooltip() {
    if (!animationTooltipEl) return;
    const p = map.project(animationTooltipEl._lngLat);
    animationTooltipEl.style.left = p.x + 'px';
    animationTooltipEl.style.top = p.y + 'px';
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

  function beginDwell(stop) {
    if (animationFrameId !== null) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    const { point } = pointAtDistance(animationCumulative, stop.distance, 1);
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

    const baseSpeedMps = animationCumulative.total / (ANIMATION_BASE_DURATION_MS / 1000);
    animationProgress = Math.min(animationProgress + baseSpeedMps * animationSpeed * deltaSeconds, animationCumulative.total);

    const { point, slicedCoords } = pointAtDistance(animationCumulative, animationProgress, 1);
    setSourceData('animation-progress-line', { type: 'Feature', geometry: { type: 'LineString', coordinates: slicedCoords }, properties: {} });
    setSourceData('animation-marker', { type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} });

    if (animationNextStopIdx < animationStopMarkers.length
        && animationProgress >= animationStopMarkers[animationNextStopIdx].distance) {
      const stop = animationStopMarkers[animationNextStopIdx];
      animationNextStopIdx++;
      beginDwell(stop);
      return;
    }

    if (animationProgress >= animationCumulative.total) {
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
    animationLastFrameTime = null;
    hideAnimationTooltip();
    if (map) {
      setSourceData('animation-progress-line', EMPTY_FC);
      setSourceData('animation-marker', EMPTY_FC);
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
    animationLastFrameTime = null;
    animationSessionActive = true;
    animating = true;
    updateAnimationUI();
    animationFrameId = requestAnimationFrame(animationStep);
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
    const hint = $('mapHint');
    const hintKey = mode === 'block-line' ? 'mapHintPickLine'
      : mode === 'exclude-a' ? 'mapHintPickA'
      : mode === 'exclude-b' ? 'mapHintPickB'
      : null;
    hint.style.display = hintKey ? '' : 'none';
    if (hintKey) hint.textContent = t(hintKey);
  }

  function resetPicking() {
    pickedA = null;
    pickedB = null;
    mode = 'idle';
    blockPanelOpen = false;
    pendingBlockWindow = null;
    pendingBlockReason = '';
    pendingPreview = null;
    blockAnchorPoint = null;
    setSourceData('pick-points', EMPTY_FC);
    setSourceData('preview-route-line', EMPTY_FC);
    // Redraw the blocked-segment overlay from what is actually in force:
    // picking a segment draws a draft 🚧 line, and abandoning the flow
    // must not leave that draft behind on a road nobody blocked.
    renderExcludedSegments(inForceRestrictions);
    hideComparisonPanel();
    updateToolbarUI();
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
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
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

  function onStopClick(e) {
    if (mode !== 'idle') return; // "Bloquear via" picking takes priority
    const feature = e.features && e.features[0];
    if (!feature) return;
    // The stop's own coordinates, not the click's — otherwise the popup
    // anchors off-marker and reports whatever point was under the cursor.
    const [lng, lat] = feature.geometry.coordinates;
    showStopPopup(feature.properties.seq, feature.properties.address, { lng, lat });
  }

  function onMapClick(e) {
    if (mode === 'idle') return;
    const point = [e.lngLat.lng, e.lngLat.lat];

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
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showErrorPanel(data.error || t('mapPreviewError'));
        setSourceData('excluded-segments', EMPTY_FC);
        return;
      }

      pendingPreview = data;
      setSourceData('excluded-segments', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: data.excludedSegment, properties: {} }] });
      setSourceData('preview-route-line', { type: 'Feature', geometry: data.newRoute.geometry, properties: {} });

      const formatDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
      const notices =
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
    let saved = null;
    try {
      const res = await fetch('/api/road-exclusion/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftRestriction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { showErrorPanel(body.error || t('mapPreviewError')); return; }
      saved = body;
    } catch (err) {
      showErrorPanel(t('serverContactError'));
      return;
    }

    const order = pendingPreview.order;
    setSourceData('preview-route-line', EMPTY_FC);
    resetPicking();
    if (window.applyReorderedRoute) {
      await window.applyReorderedRoute(order);
      appliedBlocks.push({
        restrictionId: saved.id,
        order,
        addressesAfter: lastRequestParams ? lastRequestParams.addresses.slice() : null,
      });
    }
  }

  // ---------- "Reverter bloqueio" ----------

  // An order says "position i now holds what used to be at order[i]".
  // The inverse says where each original entry went, which is exactly
  // what turns a reordered list back into the one it came from:
  // apply(apply(xs, order), invertOrder(order)) === xs.
  function invertOrder(order) {
    const inverse = new Array(order.length);
    order.forEach((originalIdx, newIdx) => { inverse[originalIdx] = newIdx; });
    return inverse;
  }

  // Same list the toolbar button's visibility is based on, so "revert"
  // can also cancel a block that is only scheduled for a future date.
  async function revertLastBlock() {
    let list = [];
    try {
      const res = await fetch('/api/road-restrictions?includeScheduled=1');
      list = res.ok ? await res.json() : [];
    } catch (err) {
      showErrorPanel(t('serverContactError'));
      return;
    }
    if (list.length === 0) {
      showErrorPanel(t('revertNoBlocks'));
      return;
    }

    const newest = list.reduce((a, b) => (new Date(b.createdAt) > new Date(a.createdAt) ? b : a));
    try {
      const res = await fetch('/api/road-restrictions/' + encodeURIComponent(newest.id), { method: 'DELETE' });
      if (!res.ok) { showErrorPanel(t('mapPreviewError')); return; }
    } catch (err) {
      showErrorPanel(t('serverContactError'));
      return;
    }

    stopAnimation();
    resetPicking();

    // Applying a block can also reorder the stops, so undoing it puts
    // that order back too — otherwise revert would restore the road but
    // leave the deliveries shuffled. Only done when this is the block
    // that did the reordering and the address list is still the one it
    // produced; if the user has edited the list since, its own order
    // wins and the route is simply recalculated.
    const entryIdx = appliedBlocks.findIndex((b) => b.restrictionId === newest.id);
    const entry = entryIdx >= 0 ? appliedBlocks[entryIdx] : null;
    if (entryIdx >= 0) appliedBlocks.splice(entryIdx, 1);

    const currentAddresses = lastRequestParams ? lastRequestParams.addresses : null;
    const listUnchanged = entry && entry.addressesAfter && currentAddresses
      && entry.addressesAfter.length === currentAddresses.length
      && entry.addressesAfter.every((a, i) => a === currentAddresses[i]);

    if (listUnchanged && window.applyReorderedRoute) {
      await window.applyReorderedRoute(invertOrder(entry.order));
      return;
    }
    if (lastRequestParams) await loadRoute(lastRequestParams);
  }

  // ---------- Public API ----------

  async function loadRoute(params) {
    lastRequestParams = params;
    stopAnimation();

    if (params.addresses.length < 2) { clear(); return; }

    $('mapEmptyState').style.display = 'none';
    $('mapContainer').style.display = '';
    $('mapToolbar').style.display = '';
    ensureMap(); // criado (ou apenas redimensionado) DEPOIS de o container ficar visivel
    setTimeout(() => { if (map) map.resize(); }, 0);
    await mapReady; // sources/layers só existem depois do evento 'load' (ou da falha de WebGL)

    if (mapUnavailable) return; // showMapUnavailable() já tratou a UI

    // Desativados durante o recalculo para evitar que "Animar rota" ou
    // "Excluir troço" arranquem com o lastRoute ainda antigo (ex: logo a
    // seguir a aplicar uma exclusão, antes deste fetch terminar).
    $('mapToolExclude').disabled = true;
    $('mapToolAnimate').disabled = true;
    $('mapToolRevert').disabled = true;

    try {
      const res = await fetch('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: params.addresses, mode: 'driving', roundTrip: params.roundTrip }),
      });

      if (res.status === 501) {
        $('mapContainer').style.display = 'none';
        $('mapToolbar').style.display = 'none';
        $('mapEmptyState').style.display = '';
        $('mapEmptyState').textContent = t('mapNotConfigured');
        $('stopsPanel').style.display = 'none';
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        $('mapEmptyState').textContent = data.error || t('mapPreviewError');
        $('stopsPanel').style.display = 'none';
        return;
      }

      lastRoute = data;
      routeCumulative = null; // rebuilt lazily for the new geometry
      routeStopMarkers = null;
      renderRoute(data.geometry);
      renderStops(data.stops);
      await refreshActiveRestrictions();
    } catch (err) {
      $('mapEmptyState').style.display = '';
      $('mapEmptyState').textContent = t('serverContactError');
      $('stopsPanel').style.display = 'none';
    } finally {
      $('mapToolExclude').disabled = false;
      $('mapToolAnimate').disabled = false;
      $('mapToolRevert').disabled = false;
    }
  }

  function clear() {
    lastRoute = null;
    pendingPreview = null;
    routeCumulative = null;
    routeStopMarkers = null;
    appliedBlocks = [];
    stopAnimation();
    resetPicking();
    if (map) {
      setSourceData('route-line', EMPTY_FC);
      setSourceData('stops', EMPTY_FC);
      setSourceData('excluded-segments', EMPTY_FC);
    }
    $('mapContainer').style.display = 'none';
    $('mapToolbar').style.display = 'none';
    $('mapEmptyState').style.display = '';
    $('mapEmptyState').textContent = t('mapEmptyState');
    $('stopsPanel').style.display = 'none';
    $('stopsPanelList').innerHTML = '';
    $('mapToolRevert').style.display = 'none';
  }

  function retranslate() {
    if (map && map.getLayer('excluded-segments-label-layer')) {
      map.setLayoutProperty('excluded-segments-label-layer', 'text-field', '🚧 ' + t('blockedRoadLabel'));
    }
    updateToolbarUI();
    updateAnimationUI();
    if (lastRequestParams) refreshActiveRestrictions();
  }

  function init(deps) {
    t = deps.t || t;
    escapeHtml = deps.escapeHtml || escapeHtml;

    $('mapToolSelect').addEventListener('click', () => { stopAnimation(); resetPicking(); });
    $('mapToolExclude').addEventListener('click', openBlockPanel);
    $('mapToolRevert').addEventListener('click', revertLastBlock);
    $('mapToolAnimate').addEventListener('click', () => {
      if (!animationSessionActive) { startAnimation(); return; }
      if (animating) pauseAnimation(); else resumeAnimation();
    });
    $('mapToolAnimateStop').addEventListener('click', stopAnimation);
    $('animSpeedGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.anim-speed-btn');
      if (!btn) return;
      setAnimationSpeed(parseFloat(btn.getAttribute('data-speed')));
    });
  }

  window.RouteMapUI = {
    init, loadRoute, clear, retranslate,
    // Pure geometry/permutation helpers, exposed only so they can be
    // unit-tested (see test/map-geometry.test.js). Nothing in the app
    // reads them through here — the map UI itself can't be exercised
    // without a live Valhalla, so these are the parts worth pinning.
    __test: {
      buildCumulative, pointAtDistance, computeStopMarkers,
      sliceCoordsBetween, invertOrder, legEndForDistance,
    },
  };
})();
