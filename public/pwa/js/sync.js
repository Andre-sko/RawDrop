// Offline-first sync: every status change is written to IndexedDB FIRST
// (see db.js), then queued here to reach the server whenever a
// connection exists. Nothing in this file blocks the UI — a delivery
// stretch with no signal must never stop the driver from marking stops.
(function (global) {
  "use strict";

  const BASE_DELAY_MS = 5000;
  const MAX_DELAY_MS = 5 * 60 * 1000;
  const PERIODIC_FLUSH_MS = 20000;
  // Only for the "reached the server but it failed anyway" branch below
  // (a persistent 5xx) — actual network failures (the catch block) retry
  // forever on purpose, since a long dead zone with no signal is the
  // normal, expected case for this app, not something to give up on.
  // ~16 minutes of backoff (5s,10s,...,300s capped) before flagging it.
  const MAX_SERVER_ERROR_ATTEMPTS = 8;

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

  // Called right after a local status change — the write to IndexedDB
  // (status + queue entry, atomically) has already happened by the time
  // this runs (see app.js's setStopStatus / RTDB.updateStopAndEnqueue).
  // This just wakes the sync loop instead of waiting for its own
  // periodic timer, and refreshes the "N por sincronizar" badge.
  function kick() {
    notifyListeners();
    flush();
  }

  function backoffDelay(attempts) {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempts));
  }

  // Two steps for a stop with a proof: the status first (tiny, and what
  // the office is waiting for), then the image. `statusSent` on the queue
  // item remembers that step 1 landed, so a failed upload retries only
  // the upload — never a second status write with a stale timestamp.
  async function sendOne(item) {
    if (!item.statusSent) {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/stop/${encodeURIComponent(item.stopId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: item.status, reason: item.reason, clientTimestamp: item.clientTimestamp }),
      });
      if (!res.ok || !item.proof) return res;
      await RTDB.updateQueueItem(item.id, { statusSent: true });
    }
    const form = new FormData();
    form.append("type", item.proof.type);
    if (item.proof.name) form.append("name", item.proof.name);
    if (Number.isFinite(item.proof.lat)) form.append("lat", item.proof.lat);
    if (Number.isFinite(item.proof.lng)) form.append("lng", item.proof.lng);
    if (Number.isFinite(item.proof.accuracy)) form.append("accuracy", item.proof.accuracy);
    form.append("image", item.proof.blob, item.proof.type === "signature" ? "signature.png" : "photo.jpg");
    return fetch(`/api/share/${encodeURIComponent(token)}/stop/${encodeURIComponent(item.stopId)}/proof`, { method: "POST", body: form });
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
                ...(body.proof ? { proof: { type: body.proof.type, name: body.proof.name, at: body.proof.at, lat: body.proof.lat, lng: body.proof.lng } } : {}),
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
            if (attempts >= MAX_SERVER_ERROR_ATTEMPTS) {
              // Reached the server repeatedly and it keeps failing (not a
              // 404/400, handled above) — a persistent server-side bug for
              // this item isn't going to fix itself by retrying forever.
              // Flag it visibly (list.js shows lastSyncError) instead of
              // spinning silently; re-marking the stop in the UI queues a
              // fresh attempt with attempts back at 0.
              await RTDB.updateStopLocal(item.stopId, { lastSyncError: `http_${res.status}_retries_exhausted` });
              await RTDB.removeFromQueue(item.id);
            } else {
              await RTDB.updateQueueItem(item.id, { attempts, nextAttemptAt: Date.now() + backoffDelay(attempts) });
            }
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
      if (document.visibilityState === "visible") { flush(); refetchRoute(); }
    });
  }

  // --- live route updates (SSE) --------------------------------------------
  // The office re-sharing today's link pushes the new list here within a
  // second (see src/shareEvents.js). EventSource reconnects by itself
  // after a dead zone; a phone that slept through a push catches up with
  // one plain GET when the screen comes back (refetchRoute, above).
  let source = null;
  let onRoute = null;

  function startLive(routeToken, handler) {
    onRoute = handler;
    if (source) source.close();
    if (!routeToken || typeof EventSource === "undefined") return;
    source = new EventSource(`/api/share/${encodeURIComponent(routeToken)}/events`);
    source.addEventListener("route", (ev) => {
      try { onRoute(JSON.parse(ev.data)); } catch (_) { /* a bad frame is just skipped */ }
    });
  }

  async function refetchRoute() {
    if (!token || !onRoute) return;
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
      if (res.ok) onRoute(await res.json());
    } catch (_) { /* offline — the stream will bring the next one */ }
  }

  global.RTSync = { setToken, kick, flush, start, onQueueChange, startLive };
})(window);
