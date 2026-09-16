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

  // Marks a stop dirty AND queues it for sync in ONE IndexedDB transaction
  // — a single `readwrite` transaction across both stores commits or fails
  // as a unit, so a process kill between "wrote the status" and "queued
  // it" (very real: the app backgrounded for hours on a delivery shift)
  // can no longer leave a stop marked delivered locally with nothing ever
  // queued to tell the server. Replaces the old two-call, two-transaction
  // updateStopLocal()+enqueueSync() pair for this one call site.
  async function updateStopAndEnqueue(stopId, stopPatch, queueItem) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(["stops", "queue"], "readwrite");
      const stopsStore = t.objectStore("stops");
      const queueStore = t.objectStore("queue");
      let updatedStop = null;

      const getReq = stopsStore.get(stopId);
      getReq.onsuccess = () => {
        const current = getReq.result;
        if (!current) return; // no such stop — transaction just completes with nothing written
        updatedStop = { ...current, ...stopPatch };
        stopsStore.put(updatedStop);

        // Drop any earlier, not-yet-sent queue entry for this same stop
        // before adding the new one — without this, deliver→undo→deliver
        // sends three requests instead of one (correctness was only ever
        // saved by the server's own timestamp ordering, not by this
        // client), and the "N por sincronizar" badge overcounts distinct
        // stops as distinct pending syncs. No index on stopId, but the
        // queue is normally a handful of items, so a cursor scan is cheap.
        const cursorReq = queueStore.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            if (cursor.value.stopId === stopId) cursor.delete();
            cursor.continue();
          } else {
            queueStore.add({ attempts: 0, nextAttemptAt: 0, createdAt: new Date().toISOString(), ...queueItem });
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      };
      getReq.onerror = () => reject(getReq.error);

      t.oncomplete = () => resolve(updatedStop);
      t.onerror = () => reject(t.error);
    });
  }

  // The office re-shared the same link (pushed over SSE, or fetched on
  // wake-up): the server's stops replace the local ones wholesale — its
  // order is final — EXCEPT for a mark the phone made and hasn't managed
  // to send yet, which must survive by address (ids embed the position,
  // so they may all have changed). Queue entries are re-pointed at the
  // new ids the same way, in the same transaction.
  async function replaceStops(newStops) {
    const db = await openDb();
    const hashOf = (id) => String(id).split("-")[1];
    return new Promise((resolve, reject) => {
      const t = db.transaction(["stops", "queue"], "readwrite");
      const stopsStore = t.objectStore("stops");
      const queueStore = t.objectStore("queue");
      const getAll = stopsStore.getAll();
      getAll.onsuccess = () => {
        const localByHash = new Map(getAll.result.map((s) => [hashOf(s.id), s]));
        const newIdByHash = new Map(newStops.map((s) => [hashOf(s.id), s.id]));
        stopsStore.clear();
        for (const incoming of newStops) {
          const local = localByHash.get(hashOf(incoming.id));
          const merged = { ...incoming, dirty: false };
          if (local && local.dirty) {
            merged.status = local.status;
            merged.statusReason = local.statusReason;
            merged.clientTimestamp = local.clientTimestamp;
            merged.proof = local.proof;
            merged.dirty = true;
          }
          stopsStore.put(merged);
        }
        const cursorReq = queueStore.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const newId = newIdByHash.get(hashOf(cursor.value.stopId));
          if (!newId) cursor.delete(); // the stop left the list — nothing to report any more
          else if (newId !== cursor.value.stopId) cursor.update({ ...cursor.value, stopId: newId });
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      };
      getAll.onerror = () => reject(getAll.error);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
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

  // Defense-in-depth for the same gap updateStopAndEnqueue() closes going
  // forward: a stop marked `dirty` with no queue entry pointing at it (old
  // data from before this fix, or any other odd edge) would otherwise sit
  // "delivered" on the phone forever with nothing ever telling the server.
  // Called once at boot (see app.js) — re-enqueues each one from the
  // stop's own last-known status, so it rejoins the normal sync/backoff
  // flow instead of needing a manual re-tap from the driver.
  async function reconcileDirtyStops() {
    const [stops, queue] = await Promise.all([getStops(), getQueue()]);
    const queuedStopIds = new Set(queue.map((q) => q.stopId));
    const orphaned = stops.filter((s) => s.dirty && !queuedStopIds.has(s.id));
    for (const s of orphaned) {
      await enqueueSync({ stopId: s.id, status: s.status, reason: s.statusReason || null, clientTimestamp: s.clientTimestamp || new Date().toISOString() });
    }
    return orphaned.length;
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
    saveStops, replaceStops, getStops, getStop, updateStopLocal, updateStopAndEnqueue,
    enqueueSync, getQueue, updateQueueItem, removeFromQueue, countQueue, reconcileDirtyStops,
    clearAll,
  };
})(window);
