// Address -> coordinates geocoding, hybrid between Google and swisstopo
// (see GEOCODING_SOURCE in ./config), plus the Places fallbacks used to
// recover from spelling mistakes Google's plain Geocoding API can't
// resolve on its own.

const { API_KEY, GEOCODING_SOURCE, GEOCODE_CACHE_FILE } = require("./config");
const {
  geocodeCache, geocodeCacheKey, getFromCache, saveCache,
  GEOCODE_CACHE_TTL_MS,
} = require("./cache");
const { logApiRequest } = require("./api-log");

// -----------------------------------------------------------------------
// Geocodes a text address with Google. Returns null if nothing is
// found (used both by the /api/geocode endpoint and by the video/photo
// address extractor, to validate candidates).
// -----------------------------------------------------------------------
async function geocodeAddress(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", API_KEY);

  const response = await fetch(url.toString());
  logApiRequest("geocoding");
  const data = await response.json();

  if (data.status !== "OK" || !data.results || !data.results.length) {
    return null;
  }

  const result = data.results[0];
  const components = result.address_components || [];
  const hasStreetNumber = components.some((c) => c.types.includes("street_number"));
  const hasRoute = components.some((c) => c.types.includes("route"));

  return {
    placeId: result.place_id,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    // "partial_match" -> Google wasn't fully certain; still useful
    // to show the user, but flagged as less confident.
    partialMatch: !!result.partial_match,
    // If Google didn't return a street number NOR a street name, the
    // result is just a locality/general area — not an exact address.
    // This happens when the original address wasn't found and Google
    // "gives up" and falls back to the closest area it recognizes.
    hasStreetPrecision: hasStreetNumber || hasRoute,
    hasStreetNumber,
  };
}

// -----------------------------------------------------------------------
// Swiss Federal Office of Topography (swisstopo) address search — free,
// official Swiss government open data, no API key or registration
// needed. Used as a FIRST attempt before ever touching Google: for an
// address genuinely in Switzerland, this often finds it with street
// precision for free, and Google is never even called for it. If it
// comes back empty (most likely: the address isn't Swiss at all, but
// also covers swisstopo being briefly unreachable), the normal Google
// chain below runs exactly as it always did — this only ever SAVES
// calls to Google, never blocks or delays them.
//
// Only covers Switzerland — there's no equivalent free, unrestricted
// service for other countries that was found for this app (checked
// Portugal specifically: nothing public does forward address ->
// coordinates geocoding for free there), so non-Swiss addresses always
// fall through to Google exactly as before.
//
// API docs: https://docs.geo.admin.ch/access-data/search.html
// Terms of use: https://www.geo.admin.ch/en/general-terms-of-use-fsdi
// -----------------------------------------------------------------------
async function geocodeAddressSwisstopo(address) {
  const url = new URL("https://api3.geo.admin.ch/rest/services/ech/SearchServer");
  url.searchParams.set("searchText", address);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "address");
  url.searchParams.set("sr", "4326"); // WGS84 lat/lng, instead of Swiss LV95
  url.searchParams.set("limit", "1");

  let data;
  try {
    const response = await fetch(url.toString());
    logApiRequest("swisstopo");
    if (!response.ok) return null;
    data = await response.json();
  } catch (err) {
    return null; // swisstopo unreachable/timed out — just fall through to Google
  }

  const result = data && data.results && data.results[0];
  const attrs = result && result.attrs;
  if (!attrs || attrs.origin !== "address") return null; // not a real street-address match

  const lat = Number(attrs.y); // with sr=4326: y = latitude, x = longitude
  const lng = Number(attrs.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Sanity check against Switzerland's rough bounding box — guards
  // against ever silently sending someone to the wrong country if the
  // API's response shape ever changes underneath us.
  if (lat < 45.5 || lat > 48 || lng < 5.5 || lng > 11) return null;

  // "num" (street number) is only present when a full address was
  // actually matched — without it, this is only a street/locality-level
  // hit, not a precise door-level address.
  const hasStreetNumber = attrs.num !== undefined && attrs.num !== null && attrs.num !== "";

  // "label" is an HTML string like "<b>Bahnhofstrasse</b> 1 3011 Bern" — strip the tags.
  const formattedAddress = String(attrs.label || attrs.detail || address)
    .replace(/<[^>]+>/g, "")
    .trim();

  return {
    placeId: null, // swisstopo has no equivalent to a Google place_id
    lat,
    lng,
    formattedAddress,
    // swisstopo's own convention: weight > 1000 means a fuzzy match, not exact.
    partialMatch: typeof result.weight === "number" && result.weight > 1000,
    hasStreetPrecision: hasStreetNumber,
    hasStreetNumber,
  };
}

// The Geocoding API is stricter than the Google Maps search box
// (which uses Places API data, alternate locality names, etc). For
// example "3902 Glis" may fail on the Geocoding API because the
// municipality's official name is "Brig-Glis", but Maps finds it
// anyway. This function asks the Places API (Text Search) for the most
// likely address, then geocodes THAT text to get components/precision.
async function placesTextSearchAddress(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", address);
  url.searchParams.set("key", API_KEY);

  const response = await fetch(url.toString());
  logApiRequest("placesTextSearch");
  const data = await response.json();

  if (data.status !== "OK" || !data.results || !data.results.length) {
    return null;
  }

  return data.results[0].formatted_address || null;
}

// The Places Autocomplete API is the same technology behind the
// "did you mean...?" suggestions that show up while typing in Google
// Maps — especially good at handling small spelling mistakes in a
// street name (e.g. "Bielweg" instead of "Bielaweg", one letter
// short). Used as a last resort, after Text Search.
async function placesAutocompleteAddress(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", address);
  url.searchParams.set("key", API_KEY);

  const response = await fetch(url.toString());
  logApiRequest("placesAutocomplete");
  const data = await response.json();

  if (data.status !== "OK" || !data.predictions || !data.predictions.length) {
    return null;
  }

  return data.predictions[0].description || null;
}

// Tries the Geocoding API first; if the result doesn't have street
// precision, tries two fallbacks in order (Text Search, then
// Autocomplete) before giving up. This function (not the plain
// geocodeAddress) is what should be used in every endpoint that
// validates addresses.
//
// Important: even with these two fallbacks, some spelling mistakes
// won't be caught — no API guesses a missing letter in an uncommon
// street name with 100% certainty. That's exactly why the "not precise
// enough" category exists: flag it for human review instead of risking
// applying a wrong correction.
async function geocodeAddressBestUncached(address) {
  const direct = await geocodeAddress(address);
  if (direct && direct.hasStreetPrecision) {
    return direct;
  }

  try {
    const placesFormatted = await placesTextSearchAddress(address);
    if (placesFormatted) {
      const viaPlaces = await geocodeAddress(placesFormatted);
      if (viaPlaces && viaPlaces.hasStreetPrecision) {
        return viaPlaces;
      }
    }
  } catch (err) {
    // Text Search fallback failed — try the next one anyway.
  }

  try {
    const autocompleteText = await placesAutocompleteAddress(address);
    if (autocompleteText) {
      const viaAutocomplete = await geocodeAddress(autocompleteText);
      if (viaAutocomplete && viaAutocomplete.hasStreetPrecision) {
        return viaAutocomplete;
      }
    }
  } catch (err) {
    // Autocomplete fallback also failed (the API may not be enabled)
    // — fall back to the direct result, which may be null or imprecise.
  }

  return direct; // may be null, or the original imprecise result
}

// Cached wrapper around the functions above. This is what actually
// saves money: an address that has already been geocoded (successfully
// OR unsuccessfully) stays cached for a while, and every subsequent
// call (aliases, "Fix Addresses", video/photo extraction, share links)
// uses the cache instead of paying Google again. On a cache miss, which
// source(s) get tried depends on GEOCODING_SOURCE above.
async function geocodeAddressBest(address) {
  const key = geocodeCacheKey(address, GEOCODING_SOURCE);
  const cached = getFromCache(geocodeCache, key, GEOCODE_CACHE_TTL_MS);
  if (cached !== undefined) return cached;

  let result = null;

  if (GEOCODING_SOURCE === "auto" || GEOCODING_SOURCE === "swisstopo") {
    try {
      const viaSwisstopo = await geocodeAddressSwisstopo(address);
      if (viaSwisstopo && viaSwisstopo.hasStreetPrecision) {
        result = viaSwisstopo;
      }
    } catch (err) {
      // swisstopo failed for any reason — fall through to Google below
      // (in "auto"), or just return no result (in "swisstopo").
    }
  }

  if (!result && GEOCODING_SOURCE !== "swisstopo") {
    result = await geocodeAddressBestUncached(address);
  }

  geocodeCache[key] = { value: result, cachedAt: Date.now() };
  saveCache(GEOCODE_CACHE_FILE, geocodeCache);
  return result;
}

module.exports = {
  geocodeAddress,
  geocodeAddressSwisstopo,
  placesTextSearchAddress,
  placesAutocompleteAddress,
  geocodeAddressBestUncached,
  geocodeAddressBest,
};
