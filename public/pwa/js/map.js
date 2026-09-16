// Screen 3: the map. A separate, much smaller MapLibre setup than the
// office app's public/js/map.js on purpose — that one is tightly coupled
// to the dispatcher's editing workflow (road exclusion, animation,
// style switching); this one displays a fixed, already-decided route to
// the driver and follows them along it. OpenStreetMap tiles: attribution
// is left to MapLibre's own AttributionControl, which reads it straight
// from the style's sources (see RTConfig.getMapStyleUrl doc comment).
//
// What it draws, all from the share (nothing computed here, nothing
// fetched): the route line (already routed around the dispatcher's road
// exclusions and on foot where the van can't go), the excluded road
// segments themselves (red dashes — "this street is closed, that's why
// the line bends"), numbered pins, and, once tracking is on, the
// driver's own position.
//
// Tracking is navigator.geolocation.watchPosition — continuous, on the
// phone, no server. It drives three things: the blue dot (with heading
// when the phone reports one), the next-stop bar (distance as the crow
// flies + an ETA from the speed actually observed over the last minutes),
// and auto-arrival: standing within ARRIVE_RADIUS_M of the next pending
// stop for ARRIVE_DWELL_MS opens that stop's modal by itself, once.
(function (global) {
  "use strict";

  const PENDING_COLOR = "#E8A33D";
  const WALK_COLOR = "#5B8FD6";
  const DONE_COLOR = "#4CAF6E";
  const FAILED_COLOR = "#E2665B";
  const RESTRICTION_COLOR = "#E2665B";

  const ARRIVE_RADIUS_M = 40;
  const ARRIVE_DWELL_MS = 5000;
  const SPEED_WINDOW_MS = 3 * 60 * 1000; // ETA uses the average speed over this window
  const FALLBACK_SPEED_MPS = 30 / 3.6; // until enough movement has been observed
  const MIN_MOVE_FOR_SPEED_M = 15; // GPS jitter below this is not "movement"

  const t = (k, v) => (global.RTI18n ? RTI18n.t(k, v) : k);

  // Base map styles — 'dark' is RTConfig's usual vector style, 'satellite'
  // reuses the same key-free Esri raster tiles as the office app's map
  // (public/js/map.js) for a consistent look between the two apps.
  const MAP_STYLE_STORAGE_KEY = "route-tracker-pwa-map-style";
  const SATELLITE_TILES = {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  };

  function buildStyle(id) {
    if (id === "satellite") {
      return {
        version: 8,
        sources: { "base-raster": { type: "raster", tiles: SATELLITE_TILES.tiles, tileSize: 256, attribution: SATELLITE_TILES.attribution } },
        layers: [{ id: "base-raster-layer", type: "raster", source: "base-raster" }],
      };
    }
    return RTConfig.getMapStyleUrl();
  }

  function loadStoredStyle() {
    try {
      return localStorage.getItem(MAP_STYLE_STORAGE_KEY) === "dark" ? "dark" : "satellite";
    } catch (_) { return "satellite"; }
  }

  let map = null;
  let markers = [];
  let onMarkerTap = null;
  let onArrive = null;
  let nextStopBar = null;
  let locateBtn = null;
  let satelliteBtn = null;
  let mapStyle = loadStoredStyle();
  let lastGeometry = null;
  let lastRestrictions = null;

  let stops = [];
  let meMarker = null;
  let meEl = null;
  let watchId = null;
  let following = true;
  let lastFix = null; // { lng, lat, heading, at }
  const fixes = []; // recent { lng, lat, at } for the speed estimate
  let arriveCandidate = null; // { id, since }
  let arrivedIds = new Set(); // stops already auto-opened this session
  let programmaticMove = false;

  function statusColor(stop) {
    if (stop.status === "delivered") return DONE_COLOR;
    if (stop.status === "failed") return FAILED_COLOR;
    return stop.walkOnly ? WALK_COLOR : PENDING_COLOR;
  }

  function haversineM(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function markerEl(stop) {
    const el = document.createElement("div");
    el.className = "map-pin";
    el.style.background = statusColor(stop);
    el.textContent = stop.status === "pending" ? String(stop.order + 1) : "✓";
    return el;
  }

  function clearMarkers() {
    markers.forEach((m) => m.remove());
    markers = [];
  }

  function fitToStops(list) {
    const withCoords = list.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
    if (!withCoords.length) return;
    const bounds = withCoords.reduce(
      (b, s) => b.extend([s.lng, s.lat]),
      new maplibregl.LngLatBounds([withCoords[0].lng, withCoords[0].lat], [withCoords[0].lng, withCoords[0].lat])
    );
    programmaticMove = true;
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
    programmaticMove = false;
  }

  function renderStops(list) {
    if (!map) return;
    clearMarkers();
    const excludeStartEnd = RTSettings.get("excludeStartEnd");
    list.forEach((stop) => {
      if (typeof stop.lat !== "number" || typeof stop.lng !== "number") return;
      if (excludeStartEnd && stop.isStartEnd) return;
      const el = markerEl(stop);
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (onMarkerTap) onMarkerTap(stop.id);
      });
      const marker = new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map);
      markers.push(marker);
    });
  }

  function ensureLineSource(id, paint, layout) {
    if (map.getSource(id)) return;
    map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: id + "-layer", type: "line", source: id, layout: Object.assign({ "line-join": "round", "line-cap": "round" }, layout || {}), paint });
  }

  function renderGeometry(geometry) {
    lastGeometry = geometry;
    ensureLineSource("route-line", { "line-color": PENDING_COLOR, "line-width": 4, "line-opacity": 0.85 });
    map.getSource("route-line").setData({ type: "Feature", geometry: geometry || { type: "LineString", coordinates: [] }, properties: {} });
  }

  function renderRestrictions(restrictions) {
    lastRestrictions = restrictions;
    ensureLineSource("restrictions", { "line-color": RESTRICTION_COLOR, "line-width": 6, "line-dasharray": [0.2, 1.6] });
    if (!map.getLayer("restrictions-label-layer")) {
      map.addLayer({
        id: "restrictions-label-layer", type: "symbol", source: "restrictions",
        layout: { "symbol-placement": "line-center", "text-field": "🚧", "text-size": 16, "text-allow-overlap": true },
      });
    }
    map.getSource("restrictions").setData({
      type: "FeatureCollection",
      features: (restrictions || []).filter((r) => r && r.geometry).map((r) => ({ type: "Feature", geometry: r.geometry, properties: { id: r.id } })),
    });
  }

  // setStyle() wipes every source/layer that isn't part of the new style
  // (route-line, restrictions) — markers survive since they're plain DOM
  // overlays, not style layers, so only those two need re-adding once the
  // new style has finished loading.
  function setMapStyle(id) {
    if (!map || (id !== "dark" && id !== "satellite")) return;
    mapStyle = id;
    try { localStorage.setItem(MAP_STYLE_STORAGE_KEY, id); } catch (_) { /* private browsing etc */ }
    if (satelliteBtn) satelliteBtn.classList.toggle("active", id === "satellite");
    // Listener registered BEFORE setStyle() on purpose — a raster style
    // like this one has no remote JSON to fetch, so it can finish loading
    // synchronously inside setStyle() itself; attaching .once() after the
    // call would miss an event that already fired.
    map.once("style.load", () => {
      renderGeometry(lastGeometry);
      renderRestrictions(lastRestrictions);
    });
    map.setStyle(buildStyle(id));
  }

  // ---- tracking ----------------------------------------------------------

  function nextPendingStop() {
    return stops
      .filter((s) => s.status === "pending" && typeof s.lat === "number" && typeof s.lng === "number")
      .filter((s) => !(RTSettings.get("excludeStartEnd") && s.isStartEnd))
      .sort((a, b) => a.order - b.order)[0] || null;
  }

  function observedSpeedMps() {
    const now = Date.now();
    while (fixes.length && now - fixes[0].at > SPEED_WINDOW_MS) fixes.shift();
    if (fixes.length < 2) return null;
    let dist = 0;
    for (let i = 1; i < fixes.length; i++) dist += haversineM(fixes[i - 1], fixes[i]);
    const secs = (fixes[fixes.length - 1].at - fixes[0].at) / 1000;
    if (secs < 20 || dist < MIN_MOVE_FOR_SPEED_M) return null;
    return dist / secs;
  }

  function formatDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
  }

  function formatEta(seconds) {
    const d = new Date(Date.now() + seconds * 1000);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function updateNextStopBar() {
    if (!nextStopBar) return;
    const next = nextPendingStop();
    if (!next) {
      nextStopBar.hidden = !stops.length;
      nextStopBar.innerHTML = stops.length ? `<div class="next-stop-done">🏁 ${t("allDone")}</div>` : "";
      return;
    }
    nextStopBar.hidden = false;
    let detail = "";
    if (lastFix) {
      const dist = haversineM(lastFix, next);
      const speed = observedSpeedMps() || FALLBACK_SPEED_MPS;
      const eta = formatEta(dist / speed);
      detail = `<span class="next-stop-dist">${formatDistance(dist)}</span> · <span class="next-stop-eta">${t("eta", { time: eta })}</span>`;
    } else {
      detail = `<span class="next-stop-dist">${t("waitingGps")}</span>`;
    }
    nextStopBar.innerHTML =
      `<div class="next-stop-label">${t("nextStop")}</div>` +
      `<div class="next-stop-main"><span class="next-stop-num">${next.order + 1}</span>` +
      `<span class="next-stop-addr">${next.walkOnly ? "🚶 " : ""}${escapeHtml(next.address)}</span></div>` +
      `<div class="next-stop-detail">${detail}${next.deadline ? ` · 🎯 ${escapeHtml(next.deadline)}` : ""}</div>`;
    nextStopBar.onclick = () => { if (onMarkerTap) onMarkerTap(next.id); };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function checkArrival() {
    if (!lastFix || !onArrive) return;
    const next = nextPendingStop();
    if (!next || arrivedIds.has(next.id)) { arriveCandidate = null; return; }
    if (haversineM(lastFix, next) > ARRIVE_RADIUS_M) { arriveCandidate = null; return; }
    if (!arriveCandidate || arriveCandidate.id !== next.id) { arriveCandidate = { id: next.id, since: Date.now() }; return; }
    if (Date.now() - arriveCandidate.since >= ARRIVE_DWELL_MS) {
      arriveCandidate = null;
      // Only counts as handled if the app actually acted on it — with
      // auto-arrival switched off the stop stays eligible, so turning
      // the setting on while parked at the door still opens it.
      if (onArrive(next.id) !== false) arrivedIds.add(next.id);
    }
  }

  function placeMe() {
    if (!map || !lastFix) return;
    if (!meMarker) {
      meEl = document.createElement("div");
      meEl.className = "map-me";
      meEl.innerHTML = '<div class="map-me-dot"></div><div class="map-me-heading"></div>';
      meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: "map" });
    }
    meMarker.setLngLat([lastFix.lng, lastFix.lat]);
    if (!meMarker._map) meMarker.addTo(map);
    const hasHeading = typeof lastFix.heading === "number" && !Number.isNaN(lastFix.heading);
    meEl.classList.toggle("has-heading", hasHeading);
    if (hasHeading) meMarker.setRotation(lastFix.heading);
    if (following) {
      programmaticMove = true;
      map.easeTo({ center: [lastFix.lng, lastFix.lat], zoom: Math.max(map.getZoom(), 15), duration: 500 });
      setTimeout(() => { programmaticMove = false; }, 550);
    }
  }

  function onPosition(pos) {
    const { latitude, longitude, heading, accuracy } = pos.coords;
    // A wildly inaccurate fix (indoors, cold start) would jump the dot
    // and poison the speed estimate; skip those rather than draw them.
    if (typeof accuracy === "number" && accuracy > 150) return;
    lastFix = { lng: longitude, lat: latitude, heading: typeof heading === "number" ? heading : null, at: Date.now() };
    const last = fixes[fixes.length - 1];
    if (!last || haversineM(last, lastFix) >= MIN_MOVE_FOR_SPEED_M) fixes.push({ lng: longitude, lat: latitude, at: lastFix.at });
    placeMe();
    updateNextStopBar();
    checkArrival();
  }

  function setFollowing(on) {
    following = on;
    if (locateBtn) locateBtn.classList.toggle("active", following);
    if (following) placeMe();
  }

  function startTracking() {
    if (!navigator.geolocation) { console.error("RTMap: navigator.geolocation indisponivel (contexto inseguro? precisa de https)"); return; }
    if (watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
      // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT — the
      // map still works without the dot, but this is otherwise invisible:
      // "a espera de GPS" looks identical whether it's permission, a bad
      // fix, or the page not being served over https.
      console.error(`RTMap: geolocation falhou (code=${err.code} ${err.message})`);
    }, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 15000,
    });
    updateNextStopBar();
  }

  function stopTracking() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function init(container, { onTap, locateBtn: locate, satelliteBtn: satellite, nextStopBar: bar, onArrive: arrive }) {
    onMarkerTap = onTap;
    onArrive = arrive || null;
    nextStopBar = bar || null;
    locateBtn = locate || null;
    satelliteBtn = satellite || null;
    map = new maplibregl.Map({ container, style: buildStyle(mapStyle), center: [0, 0], zoom: 2, attributionControl: false });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // The driver panning/zooming by hand means "let me look" — stop
    // re-centring on them until they tap 🎯 again. MapLibre only sets
    // originalEvent on real gestures, never on our own easeTo/fitBounds.
    map.on("movestart", (e) => { if (e.originalEvent && !programmaticMove) setFollowing(false); });
    if (locateBtn) locateBtn.addEventListener("click", () => { setFollowing(!following); if (following && !lastFix) startTracking(); });
    if (satelliteBtn) {
      satelliteBtn.classList.toggle("active", mapStyle === "satellite");
      satelliteBtn.addEventListener("click", () => setMapStyle(mapStyle === "satellite" ? "dark" : "satellite"));
    }
    setFollowing(true);
    return new Promise((resolve) => map.on("load", resolve));
  }

  function update(list, geometry, restrictions) {
    stops = list || [];
    renderGeometry(geometry);
    renderRestrictions(restrictions);
    renderStops(stops);
    // With a live fix the camera follows the driver, not the whole route.
    if (!lastFix || !following) fitToStops(stops);
    updateNextStopBar();
    checkArrival();
  }

  global.RTMap = { init, update, startTracking, stopTracking };
})(window);
