// Bootstraps the driver PWA: decides which screen to show, imports a
// route (from a scanned QR or a `?token=` link), and owns the one
// mutation every screen shares — marking a stop delivered/failed/pending
// — so list.js and map.js never touch IndexedDB or the network directly.
(function () {
  "use strict";

  const els = {};
  ["scannerScreen", "scannerVideoWrap", "listScreen", "mapScreen", "video", "canvas", "scanStartBtn", "scanError",
   "navList", "navMap", "rescanBtn", "syncBadgeBtn", "syncCount",
   "countPending", "countDone", "countDone2", "doneHeader", "listPending", "listDone",
   "stopModal", "modalAddress", "modalMeta", "modalDeliveredBtn", "modalFailedBtn", "modalCancelBtn",
   "reasonModal", "reasonFreeText", "reasonConfirmBtn", "reasonCancelBtn",
   "toast", "mapContainer", "locateBtn", "expiredBanner", "loadingOverlay"]
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
    if (name === "map") ensureMap();
  }

  function setLoading(on) {
    els.loadingOverlay.hidden = !on;
  }

  async function ensureMap() {
    if (mapReady) {
      RTMap.update(currentStops, currentRoute && currentRoute.geometry);
      return;
    }
    mapReady = true;
    await RTMap.init(els.mapContainer, {
      onTap: (id) => RTDB.getStop(id).then((stop) => stop && listOpenModal(stop)),
      locateBtn: els.locateBtn,
    });
    RTMap.update(currentStops, currentRoute && currentRoute.geometry);
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
    if (mapReady) RTMap.update(currentStops, currentRoute && currentRoute.geometry);
    const count = await RTDB.countQueue();
    updateSyncBadge(count);
  }

  function updateSyncBadge(count) {
    els.syncBadgeBtn.hidden = count === 0;
    els.syncCount.textContent = count;
  }

  // The one place a stop's status actually changes: write local first
  // (so the UI and IndexedDB agree immediately, even with zero
  // connectivity), THEN queue it for the server. See sync.js for what
  // happens to the queue from here.
  async function setStopStatus(id, status, reason) {
    const clientTimestamp = new Date().toISOString();
    await RTDB.updateStopLocal(id, { status, statusReason: reason || null, clientTimestamp, dirty: true });
    await refresh();
    await RTSync.enqueueStatusChange({ stopId: id, status, reason, clientTimestamp });
  }

  function friendlyImportError(status, networkFailed) {
    if (networkFailed) return "Sem rede. Liga-te à internet para carregar esta rota pela primeira vez.";
    if (status === 410) return "Esta rota expirou. Pede um novo código QR.";
    if (status === 404) return "Código inválido — este link não existe.";
    return "Não foi possível carregar a rota. Tenta outra vez.";
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

    await RTDB.saveRoute({ token: data.token, expiresAt: data.expiresAt, roundTrip: data.route.roundTrip, createdAt: data.route.createdAt, geometry: data.route.geometry });
    // The server's order is final — never re-sorted or re-numbered here.
    await RTDB.saveStops(data.stops.map((s) => ({ ...s, dirty: false })));

    currentRoute = { token: data.token, expiresAt: data.expiresAt, geometry: data.route.geometry };
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
        const proceed = confirm(`Tens ${queueCount} marcação(ões) ainda por sincronizar. Carregar uma nova rota vai apagá-las. Continuar?`);
        if (!proceed) return;
      } else if (currentStops.length > 0) {
        const proceed = confirm("Carregar uma nova rota substitui a rota atual. Continuar?");
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

  async function boot() {
    registerServiceWorker();
    RTList.init(
      { countPending: els.countPending, countDone: els.countDone, countDone2: els.countDone2, doneHeader: els.doneHeader, listPending: els.listPending, listDone: els.listDone, toast: els.toast, stopModal: els.stopModal, modalAddress: els.modalAddress, modalMeta: els.modalMeta, modalDeliveredBtn: els.modalDeliveredBtn, modalFailedBtn: els.modalFailedBtn, modalCancelBtn: els.modalCancelBtn, reasonModal: els.reasonModal, reasonFreeText: els.reasonFreeText, reasonConfirmBtn: els.reasonConfirmBtn, reasonCancelBtn: els.reasonCancelBtn },
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
