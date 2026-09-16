// Live updates for the driver's phone: one Server-Sent Events stream per
// open route (GET /api/share/:token/events in server.js). When the office
// re-shares the same link after changing the list, every phone showing
// that token gets the new route pushed within a second instead of
// waiting for a poll — and the phone side is just the browser's built-in
// EventSource, which reconnects on its own after a dead zone.
//
// Nothing here is persisted: a connection is only ever as alive as the
// socket behind it, and a phone that missed a push while asleep does a
// plain GET when it wakes (see pwa/js/sync.js).

const clients = new Map(); // token -> Set<res>

// Comment lines keep proxies and the phone's radio from timing the
// idle connection out; well under the usual 30-60s idle cutoffs.
const HEARTBEAT_MS = 25000;

function subscribe(token, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't buffer the stream
  });
  res.write(": connected\n\n");

  if (!clients.has(token)) clients.set(token, new Set());
  clients.get(token).add(res);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    const set = clients.get(token);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(token);
    }
  });
}

function broadcast(token, event, data) {
  const set = clients.get(token);
  if (!set) return 0;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch (_) { /* a dead socket cleans itself up on "close" */ }
  }
  return set.size;
}

function listenerCount(token) {
  const set = clients.get(token);
  return set ? set.size : 0;
}

module.exports = { subscribe, broadcast, listenerCount };
