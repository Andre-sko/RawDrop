// Offline-first sync: every status change is written to IndexedDB FIRST
// (see db.js), then queued here to reach the server whenever a
// connection exists. Nothing in this file blocks the UI — a delivery
// stretch with no signal must never stop the driver from marking stops.
(function (global) {
  "use strict";

  const BASE_DELAY_MS = 5000;
  const MAX_DELAY_MS = 5 * 60 * 1000;
  const PERIODIC_FLUSH_MS = 20000;

  let token = null;
  let flushing = false;
  let listeners = [];
  let periodicTimer = null;

  function setToken(t) {
    token = t;
  }

  function onQueueChange(fn) {
    listeners.push(fn);
  }

  async function notifyListeners() {
    const count = await RTDB.countQueue();
    listeners.forEach((fn) => {
      try { fn(count); } catch (_) { /* a broken listener must not break sync */ }
    });
  }

  // Called right after a local status change — writes to IndexedDB have
  // already happened by the time this runs (see app.js's setStopStatus).
  async function enqueueStatusChange({ stopId, status, reason, clientTimestamp }) {
    await RTDB.enqueueSync({ stopId, status, reason: reason || null, clientTimestamp });
    await notifyListeners();
    flush();
  }

  function backoffDelay(attempts) {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempts));
  }

  async function sendOne(item) {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}/stop/${encodeURIComponent(item.stopId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: item.status, reason: item.reason, clientTimestamp: item.clientTimestamp }),
    });
    return res;
  }

  // Processes every due queue item once. Network failures (offline, DNS,
  // timeout — fetch itself rejecting) are retried later with exponential
  // backoff: that's the expected, recoverable case out on a route. A
  // response that DID reach the server but says the link/stop no longer
  // exists (404) can never succeed by retrying, so it's dropped instead
  // of retried forever — the driver's local mark stays exactly as they
  // left it, only the sync attempt for that item stops.
  async function flush() {
    if (flushing || !token) return;
    flushing = true;
    try {
      const queue = await RTDB.getQueue();
      const now = Date.now();
      for (const item of queue) {
        if ((item.nextAttemptAt || 0) > now) continue;
        try {
          const res = await sendOne(item);
          if (res.ok) {
            const body = await res.json().catch(() => null);
            if (body) {
              await RTDB.updateStopLocal(item.stopId, {
                serverTimestamp: body.serverTimestamp,
                updatedAt: body.updatedAt,
                dirty: false,
                lastSyncError: null,
              });
            }
            await RTDB.removeFromQueue(item.id);
          } else if (res.status === 404 || res.status === 400) {
            // Permanent: the link expired, or the payload itself is
            // invalid — no amount of retrying fixes either.
            await RTDB.updateStopLocal(item.stopId, { lastSyncError: `http_${res.status}` });
            await RTDB.removeFromQueue(item.id);
          } else {
            const attempts = (item.attempts || 0) + 1;
            await RTDB.updateQueueItem(item.id, { attempts, nextAttemptAt: Date.now() + backoffDelay(attempts) });
          }
        } catch (err) {
          // Network-level failure: offline, or the request never left
          // the device. Keep it queued, try again later.
          const attempts = (item.attempts || 0) + 1;
          await RTDB.updateQueueItem(item.id, { attempts, nextAttemptAt: Date.now() + backoffDelay(attempts) });
        }
      }
    } finally {
      flushing = false;
      await notifyListeners();
    }
  }

  function start() {
    if (periodicTimer) return;
    periodicTimer = setInterval(flush, PERIODIC_FLUSH_MS);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") flush();
    });
  }

  global.RTSync = { setToken, enqueueStatusChange, flush, start, onQueueChange };
})(window);
