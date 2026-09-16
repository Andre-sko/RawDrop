// Runtime configuration for the driver PWA. Kept in its own file (never
// inlined at the call site) specifically so the map style — a free,
// third-party-hosted URL — is a single, obvious place to change or
// override, since free tile providers are known to change their terms
// or shut down without much notice.
(function (global) {
  "use strict";

  // Same map as the office app's default (public/js/map.js's TOPO_STYLE,
  // kept independent here since this PWA is a separate, standalone app
  // with its own asset graph and offline caching): the swisstopo
  // national map, free WMTS, with OSM house numbers drawn on top from
  // OpenFreeMap's vector tiles — swisstopo's raster has none.
  const TOPO_STYLE = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      "base-raster": {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg"],
        attribution: "&copy; <a href=\"https://www.swisstopo.admin.ch\">swisstopo</a>",
      },
      osm: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: "&copy; OpenStreetMap contributors" },
    },
    layers: [
      { id: "base-raster-layer", type: "raster", source: "base-raster" },
      {
        id: "housenumbers", type: "symbol", source: "osm", "source-layer": "housenumber", minzoom: 16,
        layout: { "text-field": ["get", "housenumber"], "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 16, 9, 19, 13], "text-padding": 1 },
        paint: { "text-color": "#B3261E", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      },
    ],
  };

  // Optional override with a hosted style URL, without touching any
  // code: localStorage.setItem('rtMapStyleUrl', 'https://.../style.json').
  function getMapStyle() {
    try {
      return window.localStorage.getItem("rtMapStyleUrl") || TOPO_STYLE;
    } catch (_) {
      return TOPO_STYLE;
    }
  }

  global.RTConfig = { TOPO_STYLE, getMapStyle };
})(window);
