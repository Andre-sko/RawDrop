// Runtime configuration for the driver PWA. Kept in its own file (never
// inlined at the call site) specifically so the map style — a free,
// third-party-hosted URL — is a single, obvious place to change or
// override, since free tile providers are known to change their terms
// or shut down without much notice.
(function (global) {
  "use strict";

  // Same provider/style family the office app's map already uses
  // (public/js/map.js's "dark" MAP_STYLES entry) — kept independent here
  // rather than imported, since this PWA is a separate, standalone app
  // with its own asset graph and offline caching story.
  const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

  // Optional override for a self-hosted or alternative style, without
  // touching any code: localStorage.setItem('rtMapStyleUrl', '...').
  function getMapStyleUrl() {
    try {
      return window.localStorage.getItem("rtMapStyleUrl") || DEFAULT_MAP_STYLE_URL;
    } catch (_) {
      return DEFAULT_MAP_STYLE_URL;
    }
  }

  global.RTConfig = {
    DEFAULT_MAP_STYLE_URL,
    getMapStyleUrl,
  };
})(window);
