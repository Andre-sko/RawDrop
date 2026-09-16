// Bootstraps the driver PWA: decides which screen to show, imports a
// route (from a scanned QR or a `?token=` link), and owns the one
// mutation every screen shares — marking a stop delivered/failed/pending
// — so list.js and map.js never touch IndexedDB or the network directly.
(function () {
  "use strict";

  const els = {};
  ["scannerScreen", "scannerVideoWrap", "listScreen", "mapScreen", "video", "canvas", "scanStartBtn", "scanError",
   "navList", "navMap", "rescanBtn", "syncBadgeBtn", "finishRoundBtn",
   "counterPending", "counterDone", "countPending", "countDone", "doneHeader", "listPending", "listDone",
   "stopModal", "modalAddress", "modalCopyBtn", "modalMapsLink", "modalMeta", "modalDeliveredBtn", "modalFailedBtn", "modalCancelBtn",
   "reasonModal", "reasonFreeText", "reasonConfirmBtn", "reasonCancelBtn",
   "toast", "mapContainer", "locateBtn", "satelliteBtn", "nextStopBar", "expiredBanner", "loadingOverlay",
   "settingsBtn", "settingsModal", "settingsCloseBtn", "autoArriveToggle", "excludeStartEndToggle", "enableLocationBtn", "enableCameraBtn",
   "presenceModal", "presenceAddress", "presencePresentBtn", "presencePhotoBtn", "presencePhotoLabel", "presenceAbsentBtn", "presenceCancelBtn",
   "nameModal", "nameInput", "nameConfirmBtn", "nameCancelBtn",
   "sigScreen", "sigName", "sigCanvas", "sigClearBtn", "sigCancelBtn", "sigConfirmBtn", "photoInput"]
    .forEach((id) => { els[id] = document.getElementById(id); });

  let currentStops = [];
  let currentRoute = null;
  let mapReady = false;

  function showScreen(name) {
    els.scannerScreen.hidden = name !== "scanner";
    els.listScreen.hidden = name !== "list";
    els.mapScreen.hidden = name !== "map";
    els.navList.classList.toggle("active", name === "list");
    els.navMap.classList.toggle("active", name === "map");
    document.getElementById("bottomNav").hidden = name === "scanner";
    if (name === "map") ensureMap().then(() => RTMap.startTracking());
    else if (mapReady) { RTMap.stopTracking(); RTReplay.stop(); }
  }

  function setLoading(on) {
    els.loadingOverlay.hidden = !on;
  }

  // One shared init promise: a second caller (the finish flow right after
  // showScreen("map")) used to see mapReady=true and carry on before the
  // style had loaded — addSource on an unloaded map throws, and the
  // replay never started.
  let mapInit = null;
  async function ensureMap() {
    if (mapInit) {
      await mapInit;
      RTMap.update(currentStops, currentRoute && currentRoute.geometry, currentRoute && currentRoute.restrictions);
      return;
    }
    mapReady = true;
    mapInit = RTMap.init(els.mapContainer, {
      onTap: (id) => RTDB.getStop(id).then((stop) => stop && listOpenModal(stop)),
      locateBtn: els.locateBtn,
      satelliteBtn: els.satelliteBtn,
      nextStopBar: els.nextStopBar,
      // GPS says we've reached the next pending stop: open its
      // Entregue/Falhou modal without the driver having to find the card.
      // Opt-in (⚙️ > "Chegada automática"), off by default.
      onArrive: (id) => {
        if (!RTSettings.get("autoArrive")) return false; // not handled — keep the stop eligible
        RTDB.getStop(id).then((stop) => stop && stop.status === "pending" && listOpenModal(stop));
        return true;
      },
    });
    await mapInit;
    RTMap.update(currentStops, currentRoute && currentRoute.geometry, currentRoute && currentRoute.restrictions);
  }

  function listOpenModal(stop) {
    // list.js owns the actual modal DOM; app.js only needs a way to
    // trigger it from a map marker tap too, so it reaches through the
    // same click-delegated path list.js already wires.
    const card = document.querySelector(`.stop-card[data-id="${CSS.escape(stop.id)}"]`);
    if (card) {
      const main = card.querySelector('[data-action="open-modal"]');
      if (main) main.click();
    }
  }

  async function refresh() {
    currentStops = await RTDB.getStops();
    RTList.setLegs(currentRoute ? currentRoute.legs : null);
    RTList.render(currentStops);
    // Every stop closed → the driver ends the round themselves (🏁), which
    // is what starts the replay + finish screen. "↺ Repor" hides it again.
    els.finishRoundBtn.hidden = !(currentStops.length && pendingCount(currentStops) === 0);
    if (mapReady) RTMap.update(currentStops, currentRoute && currentRoute.geometry, currentRoute && currentRoute.restrictions);
    const count = await RTDB.countQueue();
    updateSyncBadge(count);
  }

  let lastSyncCount = 0;
  function updateSyncBadge(count) {
    lastSyncCount = count;
    els.syncBadgeBtn.hidden = count === 0;
    els.syncBadgeBtn.textContent = RTI18n.t("syncBadge", { n: count });
  }

  // The one place a stop's status actually changes: writes the local
  // status AND queues it for the server in one atomic IndexedDB
  // transaction (RTDB.updateStopAndEnqueue) — so a process kill (app
  // backgrounded for hours on a shift) can never leave a stop marked
  // delivered locally with nothing queued to tell the server about it.
  // See sync.js for what happens to the queue from here.
  // `proof` ({ type, name, blob }, from proof.js) rides along in the
  // queue item — the blob lives in IndexedDB until sync.js has uploaded
  // it — while the stop itself only keeps the label-worthy part.
  async function setStopStatus(id, status, reason, proof) {
    const clientTimestamp = new Date().toISOString();
    // The round starts at the first mark, not at the scan — the list is
    // often imported long before the van leaves.
    if (currentRoute && !currentRoute.startedAt && status !== "pending") {
      currentRoute.startedAt = clientTimestamp;
      const stored = await RTDB.getRoute();
      if (stored) await RTDB.saveRoute({ ...stored, startedAt: clientTimestamp });
    }

    await RTDB.updateStopAndEnqueue(
      id,
      { status, statusReason: reason || null, clientTimestamp, dirty: true, proof: proof ? { type: proof.type, name: proof.name } : null },
      { stopId: id, status, reason: reason || null, clientTimestamp, proof: proof || null }
    );
    await refresh();
    RTSync.kick();
  }

  // 🏁 Terminar volta: jump to the map, replay the whole round at 4x
  // (skippable), then the finish screen. No line to replay → straight to
  // the finish screen.
  async function endOfRound() {
    const geometry = currentRoute && currentRoute.geometry;
    if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2) { RTFinish.show(currentRoute, currentStops); return; }
    showScreen("map");
    await ensureMap();
    // showScreen("map") starts GPS tracking in its own .then — let that
    // land first, then the replay pauses it (replay.js) for the duration;
    // tracking resumes once the finish screen is closed (RTFinish onClose).
    await new Promise((r) => setTimeout(r, 0));
    RTReplay.play(geometry, () => RTFinish.show(currentRoute, currentStops));
  }

  function pendingCount(stops) {
    const exclude = RTSettings.get("excludeStartEnd");
    return stops.filter((s) => s.status === "pending" && !(exclude && s.isStartEnd)).length;
  }

  // A live update (applyRouteUpdate) can renumber every id while the
  // signature pad is open — the mark must still land on the same
  // address, so the id is re-resolved by its address hash at the moment
  // of marking.
  function liveId(id) {
    const hash = String(id).split("-")[1];
    const match = currentStops.find((s) => s.id.endsWith("-" + hash));
    return match ? match.id : id;
  }

  // ✓ → Presente / Ausente (proof.js); only then is the stop marked.
  function deliverWithProof(id) {
    RTDB.getStop(id).then((stop) => stop && RTProof.start(stop, {
      onDelivered: (stopId, proof) => setStopStatus(liveId(stopId), "delivered", null, proof),
      onAbsentNoDeposit: (stopId) => setStopStatus(liveId(stopId), "failed", RTI18n.t("reason_no_one_home")),
    }));
  }

  // A pushed (SSE) or re-fetched copy of today's route: the office
  // changed the list. Only ever applied to the route already loaded —
  // a different token means a different day, and that goes through the
  // explicit scan/replace flow instead.
  async function applyRouteUpdate(data) {
    if (!currentRoute || !data || data.token !== currentRoute.token) return;
    const before = currentStops.map((s) => s.id).join("|");
    await RTDB.saveRoute({ token: data.token, expiresAt: data.expiresAt, roundTrip: data.route.roundTrip, createdAt: data.route.createdAt, startedAt: currentRoute.startedAt || null, plannedSeconds: data.route.plannedSeconds || null, geometry: data.route.geometry, legs: data.route.legs || [], restrictions: data.route.restrictions || [] });
    await RTDB.replaceStops(data.stops);
    currentRoute = { token: data.token, expiresAt: data.expiresAt, plannedSeconds: data.route.plannedSeconds || null, startedAt: currentRoute && currentRoute.token === data.token ? currentRoute.startedAt : null, geometry: data.route.geometry, legs: data.route.legs || [], restrictions: data.route.restrictions || [] };
    await refresh();
    if (currentStops.map((s) => s.id).join("|") !== before) RTList.showToast(RTI18n.t("routeUpdated"));
  }

  function friendlyImportError(status, networkFailed) {
    if (networkFailed) return RTI18n.t("errNoNetwork");
    if (status === 410) return RTI18n.t("errExpired");
    if (status === 404) return RTI18n.t("errInvalid");
    return RTI18n.t("errGeneric");
  }

  async function importRoute(token) {
    setLoading(true);
    els.scanError.hidden = true;
    let res;
    try {
      res = await fetch(`/api/share/${encodeURIComponent(token)}`);
    } catch (err) {
      setLoading(false);
      els.scanError.textContent = friendlyImportError(null, true);
      els.scanError.hidden = false;
      return false;
    }
    if (!res.ok) {
      setLoading(false);
      els.scanError.textContent = friendlyImportError(res.status, false);
      els.scanError.hidden = false;
      return false;
    }
    const data = await res.json();

    const existing = await RTDB.getRoute();
    if (existing && existing.token !== token) {
      // A different route was already loaded — replacing it wipes its
      // stops and any still-unsynced queue items, so this is only ever
      // reached after the explicit "nova rota" confirmation in wireNav().
      await RTDB.clearAll();
    }

    await RTDB.saveRoute({ token: data.token, expiresAt: data.expiresAt, roundTrip: data.route.roundTrip, createdAt: data.route.createdAt, plannedSeconds: data.route.plannedSeconds || null, geometry: data.route.geometry, legs: data.route.legs || [], restrictions: data.route.restrictions || [] });
    // The server's order is final — never re-sorted or re-numbered here.
    await RTDB.saveStops(data.stops.map((s) => ({ ...s, dirty: false })));

    currentRoute = { token: data.token, expiresAt: data.expiresAt, plannedSeconds: data.route.plannedSeconds || null, startedAt: currentRoute && currentRoute.token === data.token ? currentRoute.startedAt : null, geometry: data.route.geometry, legs: data.route.legs || [], restrictions: data.route.restrictions || [] };
    RTSync.setToken(data.token);
    RTSync.startLive(data.token, applyRouteUpdate);
    mapReady = false; mapInit = null; // force RTMap.init() again if a previous route had already built the map
    setLoading(false);
    history.replaceState(null, "", "/pwa/");
    await refresh();
    showScreen("list");
    RTSync.flush();
    return true;
  }

  function checkExpiredBanner() {
    if (currentRoute && new Date(currentRoute.expiresAt).getTime() <= Date.now()) {
      els.expiredBanner.hidden = false;
    } else {
      els.expiredBanner.hidden = true;
    }
  }

  async function startScanning() {
    els.scanError.hidden = true;
    els.scannerVideoWrap.classList.add("active");
    els.scanStartBtn.hidden = true;
    await RTScanner.start(els.video, els.canvas, {
      onDecode: (token) => {
        els.scannerVideoWrap.classList.remove("active");
        els.scanStartBtn.hidden = false;
        importRoute(token);
      },
      onError: (kind, message) => {
        els.scannerVideoWrap.classList.remove("active");
        els.scanStartBtn.hidden = false;
        els.scanError.textContent = message;
        els.scanError.hidden = false;
      },
    });
  }

  function wireNav() {
    els.navList.addEventListener("click", () => showScreen("list"));
    els.navMap.addEventListener("click", () => showScreen("map"));
    els.scanStartBtn.addEventListener("click", startScanning);
    els.syncBadgeBtn.addEventListener("click", () => RTSync.flush());

    els.rescanBtn.addEventListener("click", async () => {
      const queueCount = await RTDB.countQueue();
      if (queueCount > 0) {
        const proceed = confirm(RTI18n.t("confirmReplaceQueued", { n: queueCount }));
        if (!proceed) return;
      } else if (currentStops.length > 0) {
        const proceed = confirm(RTI18n.t("confirmReplace"));
        if (!proceed) return;
      }
      RTScanner.stop();
      showScreen("scanner");
      startScanning();
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/pwa/sw.js").catch(() => { /* offline shell just won't be cached — the app still works online */ });
    // A new sw.js (bumped SHELL_CACHE_NAME) takes over mid-session via
    // skipWaiting()+claim() — but this page's own JS/CSS came from the OLD
    // cache and stays stale until the next load. Reload once, right
    // then, so a deploy reaches the phone on the first open, not the
    // second. Guarded: the very first install also fires controllerchange
    // (no previous controller), and that one must not reload.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; }
      if (!els.sigScreen.hidden) return; // never yank a signature pad away mid-stroke
      location.reload();
    });
  }

  // Reflects the browser's actual, current permission state on each
  // button — "granted" turns it green with a checkmark instead of the
  // "Ativar" label — via the Permissions API. There is no API to reset a
  // decision from here: 'camera' isn't even a queryable name in every
  // browser (Firefox/Safari), so unsupported queries just leave the
  // button at its default "Ativar" rather than claiming a state we can't
  // actually confirm.
  function setPermissionButtonState(btn, granted) {
    btn.classList.toggle("granted", granted);
    btn.textContent = granted ? RTI18n.t("permissionGranted") : RTI18n.t("settingActivate");
  }

  async function refreshPermissionButtons() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      const geo = await navigator.permissions.query({ name: "geolocation" });
      setPermissionButtonState(els.enableLocationBtn, geo.state === "granted");
      geo.onchange = () => setPermissionButtonState(els.enableLocationBtn, geo.state === "granted");
    } catch (_) { /* query itself unsupported — leave default */ }
    try {
      const cam = await navigator.permissions.query({ name: "camera" });
      setPermissionButtonState(els.enableCameraBtn, cam.state === "granted");
      cam.onchange = () => setPermissionButtonState(els.enableCameraBtn, cam.state === "granted");
    } catch (_) { /* 'camera' isn't a valid query name in Firefox/Safari */ }
  }

  function wireSettings() {
    els.settingsBtn.addEventListener("click", () => {
      els.autoArriveToggle.checked = RTSettings.get("autoArrive");
      els.excludeStartEndToggle.checked = RTSettings.get("excludeStartEnd");
      els.settingsModal.hidden = false;
      refreshPermissionButtons();
    });
    els.settingsCloseBtn.addEventListener("click", () => { els.settingsModal.hidden = true; });
    els.settingsModal.addEventListener("click", (ev) => { if (ev.target === els.settingsModal) els.settingsModal.hidden = true; });
    els.autoArriveToggle.addEventListener("change", (ev) => RTSettings.set("autoArrive", ev.target.checked));
    els.excludeStartEndToggle.addEventListener("change", (ev) => {
      RTSettings.set("excludeStartEnd", ev.target.checked);
      RTList.render(currentStops);
      els.finishRoundBtn.hidden = !(currentStops.length && pendingCount(currentStops) === 0);
      if (mapReady) RTMap.update(currentStops, currentRoute && currentRoute.geometry, currentRoute && currentRoute.restrictions);
    });

    // Both buttons also trigger the browser's own permission prompt (or
    // confirm it's already granted) — there is no API to flip a denied
    // permission back on from JS, only to ask the user to do it in their
    // browser/phone settings, which is what the "denied" toast says.
    els.enableLocationBtn.addEventListener("click", () => {
      if (!navigator.geolocation) { RTList.showToast(RTI18n.t("permissionLocationError")); return; }
      navigator.geolocation.getCurrentPosition(
        () => { setPermissionButtonState(els.enableLocationBtn, true); RTList.showToast(RTI18n.t("permissionLocationOk")); },
        (err) => RTList.showToast(RTI18n.t(err.code === 1 ? "permissionLocationDenied" : "permissionLocationError")),
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
    els.enableCameraBtn.addEventListener("click", async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        stream.getTracks().forEach((track) => track.stop()); // just confirming access, not actually scanning here
        setPermissionButtonState(els.enableCameraBtn, true);
        RTList.showToast(RTI18n.t("permissionCameraOk"));
      } catch (err) {
        RTList.showToast(RTI18n.t("permissionCameraDenied"));
      }
    });
  }

  function wireLanguage() {
    RTI18n.applyStatic();
    const selects = [document.getElementById("langSelect"), document.getElementById("langSelectHeader")].filter(Boolean);
    selects.forEach((sel) => { sel.value = RTI18n.getLang(); sel.addEventListener("change", (e) => RTI18n.setLang(e.target.value)); });
    // Everything rendered from data (cards, counters, badge) is re-rendered
    // in the new language; static markup is handled by applyStatic().
    RTI18n.onLangChange(() => {
      selects.forEach((sel) => { sel.value = RTI18n.getLang(); });
      RTList.render(currentStops);
      updateSyncBadge(lastSyncCount);
      if (!els.settingsModal.hidden) refreshPermissionButtons(); // re-label "Ativo"/"Enabled" in the new language
    });
  }

  async function boot() {
    wireLanguage();
    wireSettings();
    registerServiceWorker();
    RTList.init(
      { counterPending: els.counterPending, counterDone: els.counterDone, countPending: els.countPending, countDone: els.countDone, doneHeader: els.doneHeader, listPending: els.listPending, listDone: els.listDone, toast: els.toast, stopModal: els.stopModal, modalAddress: els.modalAddress, modalCopyBtn: els.modalCopyBtn, modalMapsLink: els.modalMapsLink, modalMeta: els.modalMeta, modalDeliveredBtn: els.modalDeliveredBtn, modalFailedBtn: els.modalFailedBtn, modalCancelBtn: els.modalCancelBtn, reasonModal: els.reasonModal, reasonFreeText: els.reasonFreeText, reasonConfirmBtn: els.reasonConfirmBtn, reasonCancelBtn: els.reasonCancelBtn },
      {
        onMarkStop: setStopStatus,
        onDeliver: deliverWithProof,
        onUndo: (id) => setStopStatus(id, "pending", null),
        getStop: (id) => RTDB.getStop(id),
      }
    );
    RTProof.init({
      presenceModal: els.presenceModal, presenceAddress: els.presenceAddress, presencePresentBtn: els.presencePresentBtn,
      presencePhotoBtn: els.presencePhotoBtn, presencePhotoLabel: els.presencePhotoLabel,
      presenceAbsentBtn: els.presenceAbsentBtn, presenceCancelBtn: els.presenceCancelBtn,
      nameModal: els.nameModal, nameInput: els.nameInput, nameConfirmBtn: els.nameConfirmBtn, nameCancelBtn: els.nameCancelBtn,
      sigScreen: els.sigScreen, sigName: els.sigName, sigCanvas: els.sigCanvas, sigClearBtn: els.sigClearBtn,
      sigCancelBtn: els.sigCancelBtn, sigConfirmBtn: els.sigConfirmBtn, photoInput: els.photoInput,
    });
    wireNav();
    RTReplay.init({ overlay: document.getElementById("replayOverlay"), skipBtn: document.getElementById("replaySkipBtn") });
    RTFinish.init({
      screen: document.getElementById("finishScreen"), title: document.getElementById("finishTitle"),
      elapsed: document.getElementById("finishElapsed"), compare: document.getElementById("finishCompare"),
      counts: document.getElementById("finishCounts"), closeBtn: document.getElementById("finishCloseBtn"),
    }, { onClose: () => { if (!els.mapScreen.hidden) { RTMap.setFollowing(true); RTMap.startTracking(); } } });
    els.finishRoundBtn.addEventListener("click", endOfRound);
    // 🏁 on the map's next-stop bar does the same once the round is done.
    els.nextStopBar.addEventListener("click", () => {
      if (currentStops.length && pendingCount(currentStops) === 0) endOfRound();
    });
    RTSync.onQueueChange(updateSyncBadge);
    RTSync.start();

    const urlToken = new URL(location.href).searchParams.get("token");
    const stored = await RTDB.getRoute();

    if (urlToken && (!stored || stored.token !== urlToken)) {
      showScreen("scanner");
      await importRoute(urlToken);
      return;
    }

    if (stored) {
      currentRoute = stored;
      RTSync.setToken(stored.token);
      RTSync.startLive(stored.token, applyRouteUpdate);
      // Belt-and-suspenders for the same gap updateStopAndEnqueue() closes
      // going forward — re-queues any stop still marked dirty with no
      // matching queue entry (old data from before that fix, or any other
      // odd edge), before the flush below tries to send the queue.
      await RTDB.reconcileDirtyStops();
      checkExpiredBanner();
      await refresh();
      showScreen("list");
      RTSync.flush();
      return;
    }

    showScreen("scanner");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
