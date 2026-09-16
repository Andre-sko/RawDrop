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
  global.RTSettings = { get, set, DEFAULTS };
})(window);
