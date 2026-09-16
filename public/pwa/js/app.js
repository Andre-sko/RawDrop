// Bootstraps the driver PWA: decides which screen to show, imports a
// route (from a scanned QR or a `?token=` link), and owns the one
// mutation every screen shares — marking a stop delivered/failed/pending
// — so list.js and map.js never touch IndexedDB or the network directly.
(function () {
  "use strict";

  const els = {};
  ["scannerScreen", "scannerVideoWrap", "listScreen", "mapScreen", "video", "canvas", "scanStartBtn", "scanError",
   "navList", "navMap", "rescanBtn", "syncBadgeBtn",
   "counterPending", "counterDone", "countPending", "countDone", "doneHeader", "listPending", "listDone",
   "stopModal", "modalAddress", "modalMeta", "modalDeliveredBtn", "modalFailedBtn", "modalCancelBtn",
   "reasonModal", "reasonFreeText", "reasonConfirmBtn", "reasonCancelBtn",
   "toast", "mapContainer", "locateBtn", "satelliteBtn", "nextStopBar", "expiredBanner", "loadingOverlay",
   "settingsBtn", "settingsModal", "settingsCloseBtn", "autoArriveToggle", "excludeStartEndToggle", "enableLocationBtn", "enableCameraBtn"]
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
    else if (mapReady) RTMap.stopTracking();
  }

  function setLoading(on) {
    els.loadingOverlay.hidden = !on;
  }

  async function ensureMap() {
    if (mapReady) {
      RTMap.update(currentStops, currentRoute && currentRoute.geometry, currentRoute && currentRoute.restrictions);
      return;
    }
    mapReady = true;
    await RTMap.init(els.mapContainer, {
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
    RTList.render(currentStops);
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
  async function setStopStatus(id, status, reason) {
    const clientTimestamp = new Date().toISOString();
    await RTDB.updateStopAndEnqueue(
      id,
      { status, statusReason: reason || null, clientTimestamp, dirty: true },
      { stopId: id, status, reason: reason || null, clientTimestamp }
    );
    await refresh();
    RTSync.kick();
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

    await RTDB.saveRoute({ token: data.token, expiresAt: data.expiresAt, roundTrip: data.route.roundTrip, createdAt: data.route.createdAt, geometry: data.route.geometry, restrictions: data.route.restrictions || [] });
    // The server's order is final — never re-sorted or re-numbered here.
    await RTDB.saveStops(data.stops.map((s) => ({ ...s, dirty: false })));

    currentRoute = { token: data.token, expiresAt: data.expiresAt, geometry: data.route.geometry, restrictions: data.route.restrictions || [] };
    RTSync.setToken(data.token);
    mapReady = false; // force RTMap.init() again if a previous route had already built the map
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
      { counterPending: els.counterPending, counterDone: els.counterDone, countPending: els.countPending, countDone: els.countDone, doneHeader: els.doneHeader, listPending: els.listPending, listDone: els.listDone, toast: els.toast, stopModal: els.stopModal, modalAddress: els.modalAddress, modalMeta: els.modalMeta, modalDeliveredBtn: els.modalDeliveredBtn, modalFailedBtn: els.modalFailedBtn, modalCancelBtn: els.modalCancelBtn, reasonModal: els.reasonModal, reasonFreeText: els.reasonFreeText, reasonConfirmBtn: els.reasonConfirmBtn, reasonCancelBtn: els.reasonCancelBtn },
      {
        onMarkStop: setStopStatus,
        onUndo: (id) => setStopStatus(id, "pending", null),
        getStop: (id) => RTDB.getStop(id),
      }
    );
    wireNav();
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
