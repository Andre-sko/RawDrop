// Screen 3: the map. A separate, much smaller MapLibre setup than the
// office app's public/js/map.js on purpose — that one is tightly coupled
// to the dispatcher's editing workflow (road exclusion, animation,
// style switching); this one only ever displays a fixed, already-decided
// route to the driver. OpenStreetMap tiles: attribution is left to
// MapLibre's own AttributionControl, which reads it straight from the
// style's sources (see RTConfig.getMapStyleUrl doc comment) rather than
// a hardcoded string here.
(function (global) {
  "use strict";

  const PENDING_COLOR = "#E8A33D";
  const DONE_COLOR = "#4A5568";
  const FAILED_COLOR = "#E2665B";

  let map = null;
  let markers = [];
  let onMarkerTap = null;
  let meMarker = null;

  function statusColor(stop) {
    if (stop.status === "delivered") return DONE_COLOR;
    if (stop.status === "failed") return FAILED_COLOR;
    return PENDING_COLOR;
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

  function fitToStops(stops) {
    const withCoords = stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
    if (!withCoords.length) return;
    const bounds = withCoords.reduce(
      (b, s) => b.extend([s.lng, s.lat]),
      new maplibregl.LngLatBounds([withCoords[0].lng, withCoords[0].lat], [withCoords[0].lng, withCoords[0].lat])
    );
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
  }

  function renderStops(stops) {
    if (!map) return;
    clearMarkers();
    stops.forEach((stop) => {
      if (typeof stop.lat !== "number" || typeof stop.lng !== "number") return;
      const el = markerEl(stop);
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (onMarkerTap) onMarkerTap(stop.id);
      });
      const marker = new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map);
      markers.push(marker);
    });
  }

  function renderGeometry(geometry) {
    if (!map.getSource("route-line")) {
      map.addSource("route-line", { type: "geojson", data: { type: "Feature", geometry: geometry || { type: "LineString", coordinates: [] }, properties: {} } });
      map.addLayer({
        id: "route-line-layer",
        type: "line",
        source: "route-line",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#E8A33D", "line-width": 4, "line-opacity": 0.85 },
      });
    } else {
      map.getSource("route-line").setData({ type: "Feature", geometry: geometry || { type: "LineString", coordinates: [] }, properties: {} });
    }
  }

  function locateMe() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      if (!meMarker) {
        const el = document.createElement("div");
        el.className = "map-pin map-pin-me";
        meMarker = new maplibregl.Marker({ element: el });
      }
      meMarker.setLngLat([longitude, latitude]).addTo(map);
      map.flyTo({ center: [longitude, latitude], zoom: 15 });
    }, () => { /* location denied/unavailable — silently skip, the map still works without it */ });
  }

  function init(container, { onTap, locateBtn }) {
    onMarkerTap = onTap;
    map = new maplibregl.Map({
      container,
      style: RTConfig.getMapStyleUrl(),
      center: [0, 0],
      zoom: 2,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (locateBtn) locateBtn.addEventListener("click", locateMe);
    return new Promise((resolve) => map.on("load", resolve));
  }

  function update(stops, geometry) {
    renderGeometry(geometry);
    renderStops(stops);
    fitToStops(stops);
  }

  global.RTMap = { init, update };
})(window);
