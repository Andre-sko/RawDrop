// Driver preferences, on the phone only (localStorage). One place to
// read/write them so app.js and map.js agree, with the defaults in one
// table — anything not listed here is not a setting.
(function (global) {
  "use strict";
  const KEY = "route-tracker-pwa-settings";
  const DEFAULTS = {
    autoArrive: false, // GPS arrival opens the stop's modal by itself — opt-in
    excludeStartEnd: true, // the depot address (roundTrip's start/end) isn't a real delivery — opt-out
  };
  let cache = null;
  function load() {
    if (cache) return cache;
    cache = Object.assign({}, DEFAULTS);
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
      for (const k of Object.keys(DEFAULTS)) if (k in raw) cache[k] = raw[k];
    } catch (e) { /* defaults */ }
    return cache;
  }
  function get(k) { return load()[k]; }
  function set(k, v) {
    if (!(k in DEFAULTS)) return;
    load()[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* ignora */ }
  }
  // Card/pin number for a stop. With "excludeStartEnd" on, the depot at
  // order 0 is hidden, so the first real delivery must read "1", not "2"
  // — the server's order is untouched, only the label shifts.
  function numberOffset(stops) {
    return get("excludeStartEnd") && stops.some((s) => s.isStartEnd && s.order === 0) ? 1 : 0;
  }
  function stopNumber(stop, stops) { return stop.order + 1 - numberOffset(stops); }
  // "↺ Repor" put a closed stop back in the list: still pending, but it
  // carries the timestamp of the mark that was undone — a fresh stop never
  // has one. Shown as ↺ on the card and the pin so it isn't mistaken for
  // a stop nobody has been to yet.
  function isUndone(stop) { return stop.status === "pending" && !!stop.clientTimestamp; }
  global.RTSettings = { get, set, DEFAULTS, stopNumber, isUndone };
})(window);
