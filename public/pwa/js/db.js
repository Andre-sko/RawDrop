// IndexedDB wrapper for the driver PWA — the ONLY place route/stop state
// lives on this device. Everything here is deliberately synchronous-looking
// (Promise-wrapped) but every write actually lands on disk via IndexedDB
// before it resolves, which is what lets the app survive a closed tab, a
// dead battery, or a full phone restart (localStorage would too, but not
// the amount of structured data + queue a full day's route needs).
(function (global) {
  "use strict";

  const DB_NAME = "rt-driver-db";
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("route")) db.createObjectStore("route", { keyPath: "key" });
        if (!db.objectStoreNames.contains("stops")) db.createObjectStore("stops", { keyPath: "id" });
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // --- route (single record, fixed key "current") -------------------------

  async function saveRoute(routeMeta) {
    const store = await tx("route", "readwrite");
    await reqToPromise(store.put({ key: "current", ...routeMeta, savedAt: new Date().toISOString() }));
  }

  async function getRoute() {
    const store = await tx("route", "readonly");
    const result = await reqToPromise(store.get("current"));
    return result || null;
  }

  // --- stops ----------------------------------------------------------------

  async function saveStops(stops) {
    const store = await tx("stops", "readwrite");
    await Promise.all(stops.map((s) => reqToPromise(store.put(s))));
  }

  async function getStops() {
    const store = await tx("stops", "readonly");
    const all = await reqToPromise(store.getAll());
    return all.sort((a, b) => a.order - b.order);
  }

  async function getStop(id) {
    const store = await tx("stops", "readonly");
    return reqToPromise(store.get(id));
  }

  async function updateStopLocal(id, patch) {
    const store = await tx("stops", "readwrite");
    const current = await reqToPromise(store.get(id));
    if (!current) return null;
    const updated = { ...current, ...patch };
    await reqToPromise(store.put(updated));
    return updated;
  }

  // --- sync queue -------------------------------------------------------

  async function enqueueSync(item) {
    const store = await tx("queue", "readwrite");
    const id = await reqToPromise(store.add({ attempts: 0, nextAttemptAt: 0, createdAt: new Date().toISOString(), ...item }));
    return { id, ...item };
  }

  async function getQueue() {
    const store = await tx("queue", "readonly");
    return reqToPromise(store.getAll());
  }

  async function updateQueueItem(id, patch) {
    const store = await tx("queue", "readwrite");
    const current = await reqToPromise(store.get(id));
    if (!current) return;
    await reqToPromise(store.put({ ...current, ...patch }));
  }

  async function removeFromQueue(id) {
    const store = await tx("queue", "readwrite");
    await reqToPromise(store.delete(id));
  }

  async function countQueue() {
    const store = await tx("queue", "readonly");
    return reqToPromise(store.count());
  }

  // Wipes everything — used only when the driver explicitly scans a
  // different route, replacing whatever day/route was loaded before.
  async function clearAll() {
    const db = await openDb();
    await Promise.all(
      ["route", "stops", "queue"].map(
        (name) => new Promise((resolve, reject) => {
          const req = db.transaction(name, "readwrite").objectStore(name).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
      )
    );
  }

  global.RTDB = {
    saveRoute, getRoute,
    saveStops, getStops, getStop, updateStopLocal,
    enqueueSync, getQueue, updateQueueItem, removeFromQueue, countQueue,
    clearAll,
  };
})(window);
