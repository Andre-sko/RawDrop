// End-of-round replay: the office's "Animar rota" in its modern style,
// played on the phone at 4x once the last stop is closed — a marker runs
// the whole route, the travelled stretch turns green behind it, and each
// pin flips to what actually happened there (✓ or the red ✗ pin) as it
// arrives. "Saltar" skips straight to the finish screen (finish.js).
//
// Deliberately smaller than the office version: no tooltips, no pulse
// ring, a fixed 4x pace; the camera stays centred on the marker the
// whole way (GPS follow is paused for the duration so it can't fight it).
(function (global) {
  "use strict";

  const SPEED = 4;
  const REFERENCE_SPEED_MPS = 25; // same "demo" pace as the office, before x4
  const MIN_DURATION_MS = 8000 / SPEED;
  const MAX_DURATION_MS = 120000 / SPEED;
  const DWELL_MS = 900 / SPEED;
  const FOLLOW_ZOOM = 11.5; // ~6 km across a phone screen (office follows at 11-16)
  // The camera glides after the marker instead of copying its every
  // wiggle: it closes the gap with this time constant (seconds), so a
  // sharp bend in the road is a slow drift of the view, not a jolt.
  const CAMERA_SMOOTHING_S = 0.8;
  // ...but never further behind than this much of the screen: on a long
  // fast stretch the lag (speed × 0.8s) grew past the viewport and the
  // marker ran off the edge. The camera is dragged along on a leash.
  const CAMERA_MAX_LAG_RATIO = 0.22;

  let els = {};
  let state = null; // { frame, dwell, done } while running

  function haversineM(a, b) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Cumulative distance per vertex, and the vertex nearest each pin so a
  // stop "happens" when the marker reaches that distance along the line.
  function prepare(coords, markers) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineM(coords[i - 1], coords[i]));
    let lastD = 0;
    const events = markers.map((m) => {
      const s = m.__stop;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = haversineM(coords[i], [s.lng, s.lat]);
        if (d < bestD) { bestD = d; best = i; }
      }
      lastD = Math.max(lastD, cum[best]); // pins come in route order; never let one fire before the previous
      return { marker: m, stop: s, at: lastD };
    });
    return { cum, total: cum[cum.length - 1], events };
  }

  function pointAt(coords, cum, dist, from) {
    let i = from;
    while (i < cum.length - 1 && cum[i + 1] < dist) i++;
    if (i >= cum.length - 1) return { point: coords[coords.length - 1], i: cum.length - 1 };
    const segLen = cum[i + 1] - cum[i];
    const f = segLen > 0 ? (dist - cum[i]) / segLen : 0;
    const a = coords[i], b = coords[i + 1];
    return { point: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], i };
  }

  function play(geometry, onDone) {
    const map = RTMap.getMap();
    const coords = geometry && geometry.coordinates;
    const markers = RTMap.getMarkers();
    if (!map || !coords || coords.length < 2 || !markers.length) { onDone(); return; }
    stop(false);

    const { cum, total, events } = prepare(coords, markers);
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, (total / REFERENCE_SPEED_MPS) * 1000 / SPEED));
    const mps = total / (durationMs / 1000);

    // Every pin starts as "not yet visited" and is flipped on arrival.
    markers.forEach((m) => RTMap.repaintPin(m, { ...m.__stop, status: "pending", clientTimestamp: null }));

    if (!map.getSource("replay-progress")) {
      map.addSource("replay-progress", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
      map.addLayer({ id: "replay-progress-layer", type: "line", source: "replay-progress",
        layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": RTMap.DONE_COLOR, "line-width": 5 } });
    }
    const dot = document.createElement("div");
    dot.className = "replay-dot";
    const moving = new maplibregl.Marker({ element: dot }).setLngLat(coords[0]).addTo(map);

    // The driver's own position must not move the camera while this runs
    // — the map's GPS follow re-centres on every fix (see map.js's
    // placeMe), which is exactly what kept dragging the view away from
    // the moving marker.
    RTMap.stopTracking();
    RTMap.setFollowing(false);
    map.jumpTo({ center: coords[0], zoom: FOLLOW_ZOOM });
    els.overlay.hidden = false;

    state = { frame: null, dwell: null, moving, onDone };
    let progress = 0, scan = 0, next = 0, lastT = null;
    let cam = coords[0].slice(); // smoothed camera target, see CAMERA_SMOOTHING_S

    function step(now) {
      if (!state) return;
      if (lastT === null) lastT = now;
      const dt = (now - lastT) / 1000;
      progress = Math.min(progress + mps * dt, total);
      lastT = now;
      const { point, i } = pointAt(coords, cum, progress, scan);
      scan = i;
      map.getSource("replay-progress").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords.slice(0, i + 1).concat([point]) } });
      moving.setLngLat(point);
      const k = 1 - Math.exp(-dt / CAMERA_SMOOTHING_S);
      cam = [cam[0] + (point[0] - cam[0]) * k, cam[1] + (point[1] - cam[1]) * k];
      const c = map.getContainer(), leash = Math.min(c.clientWidth, c.clientHeight) * CAMERA_MAX_LAG_RATIO;
      const pc = map.project(cam), pp = map.project(point);
      const gap = Math.hypot(pp.x - pc.x, pp.y - pc.y);
      if (gap > leash) {
        const f = (gap - leash) / gap;
        const pulled = map.unproject([pc.x + (pp.x - pc.x) * f, pc.y + (pp.y - pc.y) * f]);
        cam = [pulled.lng, pulled.lat];
      }
      map.setCenter(cam);

      if (next < events.length && progress >= events[next].at) {
        const ev = events[next++];
        RTMap.repaintPin(ev.marker, ev.stop); // ✓ or the red ✗ pin — what really happened
        lastT = null;
        state.dwell = setTimeout(() => { state.dwell = null; if (state) state.frame = requestAnimationFrame(step); }, DWELL_MS);
        return;
      }
      if (progress >= total) { finish(); return; }
      state.frame = requestAnimationFrame(step);
    }
    state.frame = requestAnimationFrame(step);
  }

  function finish() {
    const cb = state && state.onDone;
    stop(true);
    if (cb) cb();
  }

  // restore=true puts the real pins back; false is the "about to start a
  // new run" cleanup where play() repaints them itself.
  function stop(restore) {
    if (!state) return;
    if (state.frame) cancelAnimationFrame(state.frame);
    if (state.dwell) clearTimeout(state.dwell);
    state.moving.remove();
    const map = RTMap.getMap();
    if (map && map.getSource("replay-progress")) map.getSource("replay-progress").setData({ type: "Feature", geometry: { type: "LineString", coordinates: [] } });
    state = null;
    els.overlay.hidden = true;
    if (restore) RTMap.restoreStops();
  }

  function init(elements) {
    els = elements;
    els.skipBtn.addEventListener("click", finish);
  }

  global.RTReplay = { init, play, stop: () => stop(true) };
})(window);
