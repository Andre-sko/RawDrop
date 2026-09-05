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
  let t = (key) => key;
  let escapeHtml = (s) => String(s);

  let lastRequestParams = null; // { addresses, roundTrip, deadlines, startMinutes, stopMinutes }
  let lastRoute = null; // last successful /api/route response
  let mode = 'idle'; // 'idle' | 'exclude-a' | 'exclude-b'
  let pickedA = null; // [lng, lat]
  let pickedB = null;
  let pendingPreview = null; // last /api/road-exclusion/preview response, while its panel is open

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  // ---------- "Animar rota" (start-to-finish playback) ----------
  const ANIMATION_DURATION_MS = 8000;
  let animating = false;
  let animationFrameId = null;
  let animationCumulative = null; // precomputed once per route: { coords, distances, total }

  function $(id) { return document.getElementById(id); }

  function formatDelta(meters, seconds) {
    const km = meters / 1000;
    const kmStr = (km >= 0 ? '+' : '') + km.toFixed(1) + ' km';
    const minutes = Math.round(seconds / 60);
    const minStr = (minutes >= 0 ? '+' : '') + minutes + ' min';
    return { kmStr, minStr };
  }

  // ---------- Map + layer setup ----------

  function ensureMap() {
    if (map) return map;

    mapReady = new Promise((resolve) => { mapReadyResolve = resolve; });

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
      mapReadyResolve();
    });

    return map;
  }

  function setSourceData(id, data) {
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
        '<div class="to">' + escapeHtml(new Date(r.createdAt).toLocaleString()) + '</div></div>' +
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
      const res = await fetch('/api/road-restrictions');
      const list = res.ok ? await res.json() : [];
      renderExcludedSegments(list);
      renderActiveRestrictionsList(list);
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

  function setAnimateButtonLabel() {
    const btn = $('mapToolAnimate');
    if (!btn) return;
    btn.textContent = animating ? t('mapToolAnimateStop') : t('mapToolAnimate');
    btn.classList.toggle('active', animating);
  }

  function stopAnimation() {
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    animating = false;
    animationCumulative = null;
    if (map) {
      setSourceData('animation-progress-line', EMPTY_FC);
      setSourceData('animation-marker', EMPTY_FC);
    }
    setAnimateButtonLabel();
  }

  function startAnimation() {
    if (!lastRoute || animating) return;
    resetPicking(); // "Animar rota" and "Excluir troço" picking are mutually exclusive
    animating = true;
    setAnimateButtonLabel();
    animationCumulative = buildCumulative(lastRoute.geometry.coordinates);
    let nextIndex = 1;
    const startTime = performance.now();

    const step = (now) => {
      const progress = Math.min((now - startTime) / ANIMATION_DURATION_MS, 1);
      const { point, slicedCoords, nextIndex: advanced } = pointAtDistance(
        animationCumulative, progress * animationCumulative.total, nextIndex
      );
      nextIndex = advanced;
      setSourceData('animation-progress-line', { type: 'Feature', geometry: { type: 'LineString', coordinates: slicedCoords }, properties: {} });
      setSourceData('animation-marker', { type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} });

      if (progress < 1 && animating) {
        animationFrameId = requestAnimationFrame(step);
      } else {
        stopAnimation();
      }
    };
    animationFrameId = requestAnimationFrame(step);
  }

  // ---------- Toolbar / interaction modes ----------

  function updateToolbarUI() {
    $('mapToolSelect').classList.toggle('active', mode === 'idle');
    $('mapToolExclude').classList.toggle('active', mode !== 'idle');
    const hint = $('mapHint');
    if (mode === 'exclude-a') {
      hint.style.display = '';
      hint.textContent = t('mapHintPickA');
    } else if (mode === 'exclude-b') {
      hint.style.display = '';
      hint.textContent = t('mapHintPickB');
    } else {
      hint.style.display = 'none';
    }
  }

  function resetPicking() {
    pickedA = null;
    pickedB = null;
    mode = 'idle';
    setSourceData('pick-points', EMPTY_FC);
    setSourceData('preview-route-line', EMPTY_FC);
    hideComparisonPanel();
    updateToolbarUI();
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
    showComparisonPanel(
      '<div class="totals-panel">' +
        '<p style="margin:0 0 14px;color:var(--text);font-size:14px;">' + escapeHtml(t('confirmExcludeQuestion')) + '</p>' +
        '<div class="map-comparison-actions">' +
          '<button class="btn-ghost" id="mapCancelExcludeBtn">' + escapeHtml(t('cancelBtn')) + '</button>' +
          '<button class="btn-primary" id="mapConfirmExcludeBtn" style="width:auto;">' + escapeHtml(t('excludeAndRecalcBtn')) + '</button>' +
        '</div>' +
      '</div>'
    );
    $('mapCancelExcludeBtn').addEventListener('click', resetPicking);
    $('mapConfirmExcludeBtn').addEventListener('click', runPreview);
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
    try {
      await fetch('/api/road-exclusion/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftRestriction: pendingPreview.draftRestriction }),
      });
    } catch (err) { /* mesmo que a persistencia falhe, seguimos com a nova rota calculada */ }

    const order = pendingPreview.order;
    setSourceData('preview-route-line', EMPTY_FC);
    resetPicking();
    if (window.applyReorderedRoute) await window.applyReorderedRoute(order);
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
    setTimeout(() => map.resize(), 0);
    await mapReady; // sources/layers só existem depois do evento 'load'

    // Desativados durante o recalculo para evitar que "Animar rota" ou
    // "Excluir troço" arranquem com o lastRoute ainda antigo (ex: logo a
    // seguir a aplicar uma exclusão, antes deste fetch terminar).
    $('mapToolExclude').disabled = true;
    $('mapToolAnimate').disabled = true;

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
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        $('mapEmptyState').textContent = data.error || t('mapPreviewError');
        return;
      }

      lastRoute = data;
      renderRoute(data.geometry);
      renderStops(data.stops);
      await refreshActiveRestrictions();
    } catch (err) {
      $('mapEmptyState').style.display = '';
      $('mapEmptyState').textContent = t('serverContactError');
    } finally {
      $('mapToolExclude').disabled = false;
      $('mapToolAnimate').disabled = false;
    }
  }

  function clear() {
    lastRoute = null;
    pendingPreview = null;
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
  }

  function retranslate() {
    if (map && map.getLayer('excluded-segments-label-layer')) {
      map.setLayoutProperty('excluded-segments-label-layer', 'text-field', '🚧 ' + t('blockedRoadLabel'));
    }
    updateToolbarUI();
    setAnimateButtonLabel();
    if (lastRequestParams) refreshActiveRestrictions();
  }

  function init(deps) {
    t = deps.t || t;
    escapeHtml = deps.escapeHtml || escapeHtml;

    $('mapToolSelect').addEventListener('click', () => { stopAnimation(); mode = 'idle'; resetPicking(); });
    $('mapToolExclude').addEventListener('click', () => {
      if (!lastRoute) return;
      stopAnimation();
      pickedA = null; pickedB = null;
      mode = 'exclude-a';
      setSourceData('pick-points', EMPTY_FC);
      updateToolbarUI();
    });
    $('mapToolAnimate').addEventListener('click', () => {
      if (animating) { stopAnimation(); return; }
      startAnimation();
    });
  }

  window.RouteMapUI = { init, loadRoute, clear, retranslate };
})();
