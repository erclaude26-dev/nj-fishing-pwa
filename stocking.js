// stocking.js — NJ 2026 Spring trout stocking helpers
// Pairs with stocking_2026_spring.json
//
// Usage in your Waters tab:
//   const stocking = await NJStocking.load('./stocking_2026_spring.json');
//   const rec = NJStocking.findRecord(stocking, apiNameFromNJDEP);
//   const last = NJStocking.lastStocked(stocking, rec);   // {date, count, label} or null
//   const next = NJStocking.nextStocking(stocking, rec);  // same shape
//   const closureText = NJStocking.cleanClosures(rawClosures);  // null if junk

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Name normalization. NJDEP ArcGIS Waters endpoint NAME -> PDF NAME.
  // Only mismatches are listed; everything else matches exactly.
  // -------------------------------------------------------------------------
  const API_TO_PDF_NAME = {
    'Hockhockson Brook':       'Hockhocksen Brook',
    'Tienekill Creek':         'Tienakill Creek',
    'Andover Junction Brook':  'Andover Jct Brook',
  };

  // Waters present in the NJDEP streams API but NOT in the 2026 Spring
  // allocation PDF. Treat as "not stocked this spring" rather than an error.
  const KNOWN_UNSTOCKED_2026_SPRING = new Set([
    'Neldon Brook',
  ]);

  // -------------------------------------------------------------------------
  // Data load (cached on the object you pass back)
  // -------------------------------------------------------------------------
  async function load(url) {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Failed to load ' + url + ': ' + resp.status);
    const data = await resp.json();
    // Build a name index for fast lookup
    data._index = new Map(data.waters.map(w => [w.name, w]));
    return data;
  }

  function normalizeName(apiName) {
    if (!apiName) return apiName;
    return API_TO_PDF_NAME[apiName] || apiName;
  }

  function findRecord(data, apiName) {
    if (!data || !apiName) return null;
    const name = normalizeName(apiName);
    return data._index.get(name) || null;
  }

  function isKnownUnstocked(apiName) {
    return KNOWN_UNSTOCKED_2026_SPRING.has(apiName);
  }

  // -------------------------------------------------------------------------
  // Date math
  // -------------------------------------------------------------------------
  function parseIsoDate(s) {
    // Treat ISO date as LOCAL date, not UTC, so day-of-week math works
    // regardless of viewer's timezone.
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function eventDate(data, week, day) {
    const wk = data.stocking_calendar.weeks.find(w => w.week === week);
    if (!wk) return null;
    const monday = parseIsoDate(wk.monday);
    const offset = data.stocking_calendar.day_codes[day];
    if (offset === undefined) return null;
    monday.setDate(monday.getDate() + offset);
    return monday;
  }

  // Returns array of {date, count, label, type, is_today} sorted ascending.
  // type is 'pre_season' or 'in_season'.
  function getEvents(data, record, today) {
    if (!record || record.suspended) return [];
    today = today || new Date();
    // Normalize to start-of-day for comparison
    const todayKey = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    const isSameDay = (d) =>
      d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() === todayKey;

    const events = [];

    if (record.pre_season_count > 0) {
      const preEnd = parseIsoDate(data.stocking_calendar.pre_season.end);
      events.push({
        date: preEnd,
        count: record.pre_season_count,
        label: 'Pre-season',
        type: 'pre_season',
        is_today: isSameDay(preEnd),
        range: {
          start: data.stocking_calendar.pre_season.start,
          end: data.stocking_calendar.pre_season.end,
        },
      });
    }

    for (const s of record.schedule) {
      const d = eventDate(data, s.week, s.day);
      if (!d) continue;
      events.push({
        date: d,
        count: s.count,
        label: 'Week ' + s.week,
        type: 'in_season',
        day_code: s.day,
        day_name: data.stocking_calendar.day_names[s.day],
        is_today: isSameDay(d),
      });
    }

    events.sort((a, b) => a.date - b.date);
    return events;
  }

  function lastStocked(data, record, today) {
    today = today || new Date();
    const events = getEvents(data, record, today);
    let last = null;
    for (const e of events) {
      if (e.date <= today) last = e;
      else break;
    }
    return last;
  }

  function nextStocking(data, record, today) {
    today = today || new Date();
    const events = getEvents(data, record, today);
    for (const e of events) {
      if (e.date > today) return e;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------
  // Filter junk closure values. NJDEP ArcGIS service stores "NA" or "None"
  // when there are no closures. Treat those as empty.
  function cleanClosures(raw) {
    if (raw == null) return null;
    const v = String(raw).trim();
    if (!v) return null;
    const lower = v.toLowerCase();
    if (lower === 'na' || lower === 'n/a' || lower === 'none') return null;
    return v;
  }

  function formatStockingDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

  // Compact one-line summary suitable for a card:
  //   "Stocked Thu May 14 (1,790 Rainbow Trout) — next: Thu May 21 (1,120)"
  //   "Pre-season stocking only (5,370 Rainbow Trout, Mar 23 – Apr 10)"
  //   "Suspended for 2026 Spring"
  //   "Not stocked Spring 2026"
  function summarize(data, apiName, today) {
    today = today || new Date();
    const rec = findRecord(data, apiName);
    const norm = normalizeName(apiName);

    if (!rec) {
      if (isKnownUnstocked(apiName)) {
        return { status: 'unstocked', text: 'Not stocked Spring 2026' };
      }
      return { status: 'unknown', text: 'No 2026 Spring allocation found' };
    }

    if (rec.suspended) {
      return { status: 'suspended', text: 'Suspended for 2026 Spring', record: rec };
    }

    const last = lastStocked(data, rec, today);
    const next = nextStocking(data, rec, today);
    return {
      status: 'ok',
      record: rec,
      last,
      next,
      tca: rec.tca,
      normalized_name: norm,
    };
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------
  const api = {
    load,
    findRecord,
    normalizeName,
    isKnownUnstocked,
    getEvents,
    lastStocked,
    nextStocking,
    cleanClosures,
    formatStockingDate,
    summarize,
  };

  if (typeof window !== 'undefined') window.NJStocking = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
