// lakes.js — Bergen County lakes tab helpers
// Pairs with bergen_lakes_enriched.json and (optionally) stocking.js
//
// Usage:
//   const lakes = await BergenLakes.load('./bergen_lakes_enriched.json');
//   const wb = BergenLakes.findByName(lakes, 'Lake Tappan');
//   const summary = BergenLakes.summarize(wb);
//   if (wb.usgs_gauge_id) { /* fetch USGS surface elevation using existing v1 pattern */ }

(function () {
  'use strict';

  async function load(url) {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Failed to load ' + url + ': ' + resp.status);
    const data = await resp.json();
    data._byId = new Map(data.waterbodies.map(w => [w.id, w]));
    data._byName = new Map(data.waterbodies.map(w => [w.name.toLowerCase(), w]));
    // Also index by aliases
    for (const w of data.waterbodies) {
      for (const a of (w.aliases || [])) {
        data._byName.set(a.toLowerCase(), w);
      }
    }
    return data;
  }

  function findById(data, id) {
    return data._byId.get(id) || null;
  }

  function findByName(data, name) {
    if (!name) return null;
    return data._byName.get(name.toLowerCase()) || null;
  }

  function nearby(data, lat, lng, maxMiles) {
    const within = [];
    for (const w of data.waterbodies) {
      if (w.lat == null || w.lng == null) continue;
      const d = haversineMiles(lat, lng, w.lat, w.lng);
      if (d <= maxMiles) within.push({ ...w, distance_mi: d });
    }
    within.sort((a, b) => a.distance_mi - b.distance_mi);
    return within;
  }

  function haversineMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Pull out the good-quality species (codes 1 and 2) for a card display.
  // Returns array of display labels like 'Largemouth Bass' (very good).
  // Codes outside 1-2 are excluded so the UI doesn't say 'sunfish (poor)'.
  function topSpecies(wb) {
    if (!wb.species) return [];
    const QUALITY = { 1: 'very good', 2: 'good' };
    const out = [];
    for (const [name, code] of Object.entries(wb.species)) {
      if (typeof code === 'number' && QUALITY[code]) {
        out.push({
          name: name.replace(/_/g, ' '),
          quality: QUALITY[code],
          code,
        });
      } else if (typeof code === 'string') {
        // Strings are uncoded notes like 'present', 'reported'
        out.push({ name: name.replace(/_/g, ' '), quality: code, code: null });
      }
    }
    return out;
  }

  // Returns a compact display object for a waterbody card.
  function summarize(wb) {
    if (!wb) return null;
    const access = {
      open_public: 'Open public access',
      permit_required: 'Permit required',
      hike_in: 'Hike-in / carry-in only',
    }[wb.access_type] || wb.access_type;

    // Acres correction (Dahnert's case)
    let acres = wb.acres;
    let acresNote = null;
    if (wb.acres_correction) {
      acres = wb.acres_correction.corrected_value;
      acresNote = 'corrected from source';
    }

    // Depth display
    let depthLabel = null;
    if (wb.max_depth_ft != null) {
      depthLabel = 'Max ' + wb.max_depth_ft + ' ft';
      if (wb.mean_depth_ft != null) depthLabel += ' / avg ' + wb.mean_depth_ft + ' ft';
    } else {
      depthLabel = 'No published depth survey';
    }

    // Stocking display
    let stockingLabel = 'Not NJDEP trout-stocked (2026 Spring)';
    let stockingWarning = null;
    if (wb.trout_stocked_2026_spring) {
      stockingLabel = 'NJDEP trout-stocked 2026 Spring';
    } else if (wb.name_collision_warning) {
      stockingWarning = wb.name_collision_warning;
    }

    return {
      id: wb.id,
      name: wb.name,
      town: wb.town,
      acres,
      acres_note: acresNote,
      access_label: access,
      access_notes: wb.access_notes,
      permit_url: wb.permit_url || null,
      veolia_permit: wb.veolia_permit || null,
      depth_label: depthLabel,
      depth_map_url: wb.depth_map_url || null,
      stocking_label: stockingLabel,
      stocking_pdf_name: wb.stocking_pdf_name || null,
      stocking_warning: stockingWarning,
      usgs_gauge_id: wb.usgs_gauge_id || null,
      usgs_gauge_url: wb.usgs_gauge_url || null,
      usgs_gauge_measures: wb.usgs_gauge_measures || null,
      species: topSpecies(wb),
      notes: wb.notes || null,
    };
  }

  // Returns a 1-line fee summary for the cheapest adult permit at a Veolia
  // water, suitable for card display. Returns null if not a Veolia water.
  function veoliaFeeQuickLook(wb) {
    if (!wb || !wb.veolia_permit) return null;
    const f = wb.veolia_permit.fees_usd;
    return {
      veolia_customer_adult: f.veolia_customer.adult_18_61,
      non_veolia_customer_adult: f.non_veolia_customer.adult,
      family_plan: f.veolia_customer.family_plan_2_adults_2_juniors,
      season: wb.veolia_permit.season,
      url: wb.veolia_permit.program_url,
    };
  }

  // If you've also loaded NJStocking, this returns the joined stocking
  // detail (last/next stock dates) for waterbodies where stocking applies.
  // Pass the NJStocking module and the loaded stocking data.
  function joinStocking(wb, stockingHelper, stockingData) {
    if (!wb || !wb.trout_stocked_2026_spring || !stockingHelper || !stockingData) {
      return null;
    }
    const pdfName = wb.stocking_pdf_name || wb.name;
    return stockingHelper.summarize(stockingData, pdfName);
  }

  // Returns the lake survey symbols PDF URL (legend for reading any
  // bathymetric map). Useful as a sibling link when displaying depth_map_url.
  function getLegendUrl(data) {
    return (
      (data.$enrichment_notes && data.$enrichment_notes.lake_map_symbols_legend) ||
      null
    );
  }

  const api = {
    load,
    findById,
    findByName,
    nearby,
    summarize,
    topSpecies,
    joinStocking,
    getLegendUrl,
    veoliaFeeQuickLook,
  };

  if (typeof window !== 'undefined') window.BergenLakes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
