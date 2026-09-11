// Duplicate marking for OCR stop readings.
//
// Deliberately shared by BOTH sides: the server requires it from
// src/ocr.js, the browser loads it as window.StopDedupe. That matters
// because the extraction marks duplicates once on the server, and the
// page has to re-mark them locally after an address comes back corrected
// — if the two used different code they would drift apart and the same
// list would be coloured differently before and after a correction.
//
// Nothing here removes anything. Every reading stays in the list, in the
// order it was read; the functions only ANNOTATE (duplicateOf /
// similarity) and CLASSIFY. Filtering is a view concern and lives in the
// page.
(function (global) {
  'use strict';

  // Two readings counted as the same stop above this Jaccard score. 0.6
  // is the value the old dedupe pass already used, kept so the marking
  // groups exactly the readings the old code would have collapsed.
  var DUPLICATE_SIMILARITY = 0.6;

  // How far apart two frames can be and still be read as "the same stop
  // scrolled past twice" rather than "the same address genuinely
  // delivered to twice". Tuned for the local engine, where one frame is
  // one OCR pass; the AI engine reads in batches and overrides it.
  var NEAR_FRAME_DISTANCE = 3;

  function tokenize(str) {
    return new Set(
      String(str == null ? '' : str)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  function jaccardSimilarity(a, b) {
    var ta = tokenize(a);
    var tb = tokenize(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    var inter = 0;
    ta.forEach(function (t) { if (tb.has(t)) inter++; });
    var union = new Set([].concat(Array.from(ta), Array.from(tb))).size;
    return inter / union;
  }

  // The house number, pulled out of the address so it can be compared on
  // its own. It has to be, because the similarity score barely notices
  // it: "Rue du Simplon 12, 1920 Martigny" and "...14, 1920 Martigny"
  // share every word but one and score 0.71, well over the threshold, so
  // on text alone two doors on the same street read as one stop and half
  // a street quietly disappears from the list.
  //
  // Taken as the short number sitting just before a comma or at the end
  // of the street part — which is where it is in "Rua 25 de Abril 100,
  // 1000-001 Lisboa" as much as in the Swiss form — and never the 4-digit
  // postal code. Null when the address has no number at all (a named
  // square, a place), and then the text decides as before.
  function houseNumber(address) {
    var str = String(address == null ? '' : address);
    var beforeComma = str.match(/(\d{1,3})([A-Za-z]?)\s*(?:,|$)/);
    if (beforeComma) return (beforeComma[1] + beforeComma[2]).toLowerCase();
    var first = str.match(/\b(\d{1,3})([A-Za-z]?)\b/);
    return first ? (first[1] + first[2]).toLowerCase() : null;
  }

  // False only when BOTH addresses carry a house number and the two
  // differ; anything else leaves the decision to the text.
  function sameHouse(a, b) {
    var ha = houseNumber(a);
    var hb = houseNumber(b);
    if (ha === null || hb === null) return true;
    return ha === hb;
  }

  // Annotates each entry with where its first equivalent occurrence is.
  //
  // Comparisons run only against entries that are themselves first
  // occurrences, so duplicateOf always points at the head of the group
  // rather than at another duplicate — that is what makes "index of the
  // first equivalent occurrence" true and not just "the previous one".
  //
  // entries: [{ address, stopNumber?, frame?, confidence? }] in read order
  // returns: copies with { duplicateOf, similarity, matchedBy,
  //          sameAddressAs } added
  function markDuplicates(entries, options) {
    var opts = options || {};
    var threshold = opts.threshold == null ? DUPLICATE_SIMILARITY : opts.threshold;
    var marked = [];

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var duplicateOf = null;
      var similarity = null;
      var matchedBy = null;
      // Where the SAME address was already read as a DIFFERENT stop.
      // Not a repeat — a second parcel to the same building is a
      // delivery of its own and keeps its own row — but the driver still
      // wants to see that the door is one he is already going to.
      var sameAddressAs = null;

      for (var j = 0; j < marked.length; j++) {
        var prev = marked[j];
        if (prev.duplicateOf !== null && prev.duplicateOf !== undefined) continue;

        var score = jaccardSimilarity(entry.address, prev.address);

        // The stop number printed next to the address decides on its
        // own, in BOTH directions, whenever both readings carry one.
        //
        //  - same number  -> the same stop, whatever the OCR did to the
        //    street name.
        //  - different    -> two different stops, however identical the
        //    text. This is the second parcel to the same building, and
        //    letting the text similarity mark it as a repeat would hide a
        //    delivery the driver still has to make.
        if (entry.stopNumber != null && prev.stopNumber != null) {
          if (entry.stopNumber === prev.stopNumber) {
            duplicateOf = j;
            similarity = score;
            matchedBy = 'stopNumber';
            break;
          }
          if (sameAddressAs === null && score >= threshold && sameHouse(entry.address, prev.address)) {
            sameAddressAs = j;
          }
          continue;
        }

        // The house number decides before the text does, and in both
        // directions — the same way the stop number does above. Two
        // different numbers are two different doors however alike the
        // rest of the line reads.
        if (!sameHouse(entry.address, prev.address)) continue;

        if (score >= threshold && (similarity === null || score > similarity)) {
          duplicateOf = j;
          similarity = score;
          matchedBy = 'similarity';
        }
      }

      marked.push(Object.assign({}, entry, {
        duplicateOf: duplicateOf,
        similarity: similarity,
        matchedBy: matchedBy,
        // Only worth saying on a row that is NOT already marked as a
        // repeat; on one that is, it would just be the same fact twice.
        sameAddressAs: duplicateOf == null ? sameAddressAs : null,
      }));
    }

    return marked;
  }

  // The four states the list is coloured by. Duplicate state wins over
  // low confidence: once a reading is known to repeat another one, how
  // cleanly it was read matters less than the fact that it is a repeat.
  //
  //   'unique'           -> no highlight
  //   'scroll-duplicate' -> same address, frames close together (amber)
  //   'real-duplicate'   -> same address, frames far apart (blue)
  //   'low-confidence'   -> read poorly, not a duplicate (red)
  function classifyStop(entry, entries, options) {
    if (!entry) return 'unique';
    var opts = options || {};
    var near = opts.nearFrameDistance == null ? NEAR_FRAME_DISTANCE : opts.nearFrameDistance;

    if (entry.duplicateOf != null) {
      // The gap is measured against the address's PREVIOUS appearance,
      // not its first one. During a scroll a stop sits on screen for a
      // run of consecutive frames, so measuring back to the first
      // sighting grows the gap the longer it lingers and would paint the
      // tail of every slow scroll as a second delivery. What actually
      // distinguishes a real repeat is that the address left the screen
      // and came back — a break in the run, which is what this measures.
      var gap = null;
      if (entries && typeof entry.frame === 'number') {
        var group = entry.duplicateOf;
        var previousFrame = null;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i] === entry) break;
          var isSameGroup = (i === group) || entries[i].duplicateOf === group;
          if (!isSameGroup || typeof entries[i].frame !== 'number') continue;
          if (previousFrame === null || entries[i].frame > previousFrame) previousFrame = entries[i].frame;
        }
        if (previousFrame !== null) gap = Math.abs(entry.frame - previousFrame);
      }
      // Frames unknown -> assume the harmless reading (scroll). Calling
      // it a real second delivery on no evidence would be the worse
      // mistake: it is the state that tells the driver to go twice.
      return (gap === null || gap <= near) ? 'scroll-duplicate' : 'real-duplicate';
    }

    if (entry.confidence === 'baixa') return 'low-confidence';
    return 'unique';
  }

  // A second pass over the list, run once Google has answered.
  //
  // The text matching is doing what it can with four words: a Swiss
  // address reads "Gliserallee 139 3902 Glis", and two OCR slips in it
  // are enough to drop two readings of the same door below the threshold
  // and leave them as two rows. Google resolved both to one placeId,
  // which is a far better answer than any score over the text, so this
  // pass pairs up what the first one could not.
  //
  // It only ever ADDS a marking — a row already marked keeps the marking
  // and the reason it was given — and it obeys the same rule as
  // everywhere else: two different stop numbers at one place are two
  // parcels, never a repeat.
  function markGeocodedDuplicates(entries) {
    var list = entries || [];
    var firstByPlace = {}; // placeId -> index of the first row that holds it
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var placeId = entry.valid && entry.placeId ? String(entry.placeId) : null;
      var duplicateOf = entry.duplicateOf;
      var matchedBy = entry.matchedBy;
      var sameAddressAs = entry.sameAddressAs;

      if (placeId !== null) {
        var first = firstByPlace[placeId];
        if (first === undefined) {
          firstByPlace[placeId] = i;
        } else if (duplicateOf == null) {
          var prev = list[first];
          var twoParcels = entry.stopNumber != null && prev.stopNumber != null
            && entry.stopNumber !== prev.stopNumber;
          if (twoParcels) {
            if (sameAddressAs == null) sameAddressAs = first;
          } else {
            duplicateOf = first;
            matchedBy = 'placeId';
            sameAddressAs = null;
          }
        }
      }

      out.push(Object.assign({}, entry, {
        duplicateOf: duplicateOf,
        matchedBy: matchedBy,
        sameAddressAs: sameAddressAs,
      }));
    }

    return out;
  }

  function countDuplicates(entries) {
    var n = 0;
    for (var i = 0; i < entries.length; i++) if (entries[i].duplicateOf != null) n++;
    return n;
  }

  // View filter, nothing else — returns the indices to show. The caller
  // keeps the full list; hiding never mutates it.
  function visibleIndices(entries, options) {
    var hide = !!(options && options.hideDuplicates);
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      if (hide && entries[i].duplicateOf != null) continue;
      out.push(i);
    }
    return out;
  }

  // Builds what gets sent to the address-correction tool: only the
  // selected rows, in the original reading order, each carrying the index
  // it came from so the answer can be put back in the right place.
  function buildCorrectionPayload(entries, selectedIndices, addressOf) {
    var pick = addressOf || function (e) { return e.address; };
    var wanted = Array.from(selectedIndices || []).map(Number)
      .filter(function (i) { return Number.isInteger(i) && i >= 0 && i < entries.length; })
      .sort(function (a, b) { return a - b; });

    var seen = new Set();
    var out = [];
    for (var k = 0; k < wanted.length; k++) {
      if (seen.has(wanted[k])) continue;
      seen.add(wanted[k]);
      out.push({ index: wanted[k], address: pick(entries[wanted[k]]) });
    }
    return out;
  }

  // Writes corrected addresses back at their index of origin and re-runs
  // the marking over the whole list, because a correction can turn a
  // reading that looked unique into an obvious repeat (and the other way
  // round). corrections: [{ index, address, valid?, confidence? }]
  function applyCorrections(entries, corrections, options) {
    var next = entries.slice();
    (corrections || []).forEach(function (c) {
      if (!c || !Number.isInteger(c.index) || c.index < 0 || c.index >= next.length) return;
      if (!c.address || !String(c.address).trim()) return;
      next[c.index] = Object.assign({}, next[c.index], {
        address: String(c.address).trim(),
        corrected: true,
        valid: c.valid === undefined ? next[c.index].valid : !!c.valid,
        // A Google-confirmed address is no longer a doubtful reading, so
        // it stops being flagged red; anything else keeps the OCR verdict.
        confidence: c.valid ? 'alta' : next[c.index].confidence,
        formattedAddress: c.valid ? String(c.address).trim() : undefined,
      });
    });
    return markDuplicates(next, options);
  }

  var api = {
    DUPLICATE_SIMILARITY: DUPLICATE_SIMILARITY,
    NEAR_FRAME_DISTANCE: NEAR_FRAME_DISTANCE,
    tokenize: tokenize,
    jaccardSimilarity: jaccardSimilarity,
    houseNumber: houseNumber,
    sameHouse: sameHouse,
    markDuplicates: markDuplicates,
    markGeocodedDuplicates: markGeocodedDuplicates,
    classifyStop: classifyStop,
    countDuplicates: countDuplicates,
    visibleIndices: visibleIndices,
    buildCorrectionPayload: buildCorrectionPayload,
    applyCorrections: applyCorrections,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StopDedupe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
