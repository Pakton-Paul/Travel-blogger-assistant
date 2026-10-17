/* Timeline alternative (Travel Blogger Assistant) — prototype
   Reads one GPSLogger GPX file per day, cleans it, finds stops and walks,
   names places via OpenStreetMap Nominatim and builds a text report.
   Spec: "Timeline alt spec.docx" v1.4 */
'use strict';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  homeLat: null, homeLon: null, homeRadius: 200,
  minStopMin: 10, stopRadius: 100,
  minWalkMin: 15, walkRadius: 500, walkSpeedMax: 7,
  mergeGapMin: 5, gapMin: 15,
  maxSpeedKmh: 200, maxHdop: 5,
  timeFormat: '24', timeZone: '',
  placeDetail: 'name', showMapsLinks: false,
  osmEmail: ''
};

const SETTINGS_SCHEMA = [
  { key: 'homeLat', label: 'Home latitude', type: 'number', step: 'any' },
  { key: 'homeLon', label: 'Home longitude', type: 'number', step: 'any' },
  { key: 'homeRadius', label: 'Home radius', unit: 'm', type: 'number', min: 10 },
  { key: 'minStopMin', label: 'Minimum stop time', unit: 'min', type: 'number', min: 1 },
  { key: 'stopRadius', label: 'Stop radius', unit: 'm', type: 'number', min: 10 },
  { key: 'minWalkMin', label: 'Minimum walk-around time', unit: 'min', type: 'number', min: 1 },
  { key: 'walkRadius', label: 'Walk-around radius', unit: 'm', type: 'number', min: 50 },
  { key: 'walkSpeedMax', label: 'Walking speed (maximum)', unit: 'km/h', type: 'number', min: 1, step: '0.5' },
  { key: 'mergeGapMin', label: 'Merge visits to the same place less than', unit: 'min apart', type: 'number', min: 0 },
  { key: 'gapMin', label: 'Gap time', unit: 'min', type: 'number', min: 1 },
  { key: 'maxSpeedKmh', label: 'Maximum plausible speed', unit: 'km/h', type: 'number', min: 20 },
  { key: 'maxHdop', label: 'Maximum HDOP', type: 'number', min: 1, step: '0.5' },
  { key: 'timeFormat', label: 'Time format', type: 'select', options: [['24', '24-hour'], ['12', '12-hour']] },
  { key: 'timeZone', label: 'Time zone', type: 'text', placeholder: "Blank = this device's (e.g. Europe/Rome)" },
  { key: 'placeDetail', label: 'Place-name detail', type: 'select', wide: true, options: [
      ['name', 'Business/landmark name, otherwise street and suburb'],
      ['street', 'Street and suburb'],
      ['suburb', 'Suburb or town only']] },
  { key: 'showMapsLinks', label: 'Report: show Google Maps links', type: 'checkbox' },
  { key: 'osmEmail', label: 'Contact email sent with OpenStreetMap lookups (optional)', type: 'text', wide: true,
    placeholder: 'Helps OpenStreetMap identify this App' }
];

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tla.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { localStorage.setItem('tla.settings', JSON.stringify(s)); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Geometry and time helpers                                           */
/* ------------------------------------------------------------------ */

const R_EARTH = 6371008.8;
const rad = d => d * Math.PI / 180;

function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
function speedKmh(a, b) {
  const dt = Math.max(1, (b.t - a.t) / 1000);
  return distM(a, b) / dt * 3.6;
}
function centroid(pts) {
  let lat = 0, lon = 0;
  for (const p of pts) { lat += p.lat; lon += p.lon; }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

function fmtTime(t, s) {
  return new Intl.DateTimeFormat('en-AU', {
    hour: '2-digit', minute: '2-digit', hour12: s.timeFormat === '12',
    timeZone: s.timeZone || undefined
  }).format(new Date(t)).replace(/\s?([ap])\.?m\.?/i, (m, x) => x.toLowerCase() + 'm');
}
function fmtDate(t, s) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: s.timeZone || undefined
  }).formatToParts(new Date(t));
  const g = type => (parts.find(p => p.type === type) || {}).value || '';
  return `${g('weekday')} ${g('day')} ${g('month')} ${g('year')}`;
}
function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
const mapsLink = p => `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

/* ------------------------------------------------------------------ */
/* GPX parsing                                                         */
/* ------------------------------------------------------------------ */

function parseGpx(text, DOMParserImpl) {
  const Parser = DOMParserImpl || DOMParser;
  const doc = new Parser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The file is not valid GPX/XML.');
  const nodes = doc.getElementsByTagName('trkpt');
  const val = (n, tag) => {
    const e = n.getElementsByTagName(tag)[0];
    return e && e.textContent != null ? e.textContent.trim() : null;
  };
  const pts = [];
  let bad = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
    const t = Date.parse(val(n, 'time'));
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) { bad++; continue; }
    const hdop = parseFloat(val(n, 'hdop'));
    pts.push({ lat, lon, t, hdop: isFinite(hdop) ? hdop : null, src: val(n, 'src') });
  }
  return { points: pts, unreadable: bad };
}

/* ------------------------------------------------------------------ */
/* Cleaning (spec: GPS data checks and fixes)                          */
/* ------------------------------------------------------------------ */

function cleanPoints(raw, s) {
  const q = { unreadable: raw.unreadable, duplicates: 0, lowAccuracy: 0, jumps: 0, reordered: false };
  let pts = raw.points.slice();
  for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t) { q.reordered = true; break; }
  pts.sort((a, b) => a.t - b.t);

  // duplicates: same second
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(p.t - last.t) < 1000) { q.duplicates++; continue; }
    dedup.push(p);
  }
  // poor accuracy (only where HDOP is recorded)
  pts = dedup.filter(p => {
    if (p.hdop != null && p.hdop > s.maxHdop) { q.lowAccuracy++; return false; }
    return true;
  });
  // jumps: a point that needs an impossible speed to reach AND to leave
  let changed = true;
  while (changed && pts.length > 2) {
    changed = false;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = out[out.length - 1], p = pts[i], next = pts[i + 1];
      if (speedKmh(prev, p) > s.maxSpeedKmh && speedKmh(p, next) > s.maxSpeedKmh) {
        q.jumps++; p.removed = 'jump'; changed = true; continue;
      }
      out.push(p);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return { points: pts, quality: q };
}

/* ------------------------------------------------------------------ */
/* Visits: stops and walk-arounds                                      */
/* ------------------------------------------------------------------ */

// Greedy stay-point detection. Returns [{i, j}] index ranges (inclusive).
function stayPoints(pts, from, to, radius, minMs, accept) {
  const out = [];
  let i = from;
  while (i <= to) {
    let j = i, sumLat = pts[i].lat, sumLon = pts[i].lon;
    while (j + 1 <= to) {
      const n = j - i + 1;
      const c = { lat: sumLat / n, lon: sumLon / n };
      const next = pts[j + 1];
      if (distM(c, next) > radius) break;
      if (accept && !accept(pts[j], next)) break;
      j++; sumLat += next.lat; sumLon += next.lon;
    }
    if (pts[j].t - pts[i].t >= minMs) { out.push({ i, j }); i = j + 1; }
    else i++;
  }
  return out;
}

function findVisits(pts, s) {
  if (!pts.length) return [];
  const last = pts.length - 1;
  const stops = stayPoints(pts, 0, last, s.stopRadius, s.minStopMin * 60000)
    .map(r => ({ ...r, type: 'Stop' }));

  // walk-arounds in the moving parts between stops
  const walks = [];
  const walkOk = (a, b) => speedKmh(a, b) <= s.walkSpeedMax * 1.5;
  let cursor = 0;
  const gaps = [];
  for (const st of stops) { if (st.i - 1 >= cursor) gaps.push([cursor, st.i - 1]); cursor = st.j + 1; }
  if (cursor <= last) gaps.push([cursor, last]);
  for (const [a, b] of gaps) {
    if (b - a < 2) continue;
    for (const r of stayPoints(pts, a, b, s.walkRadius, s.minWalkMin * 60000, walkOk)) {
      // must actually move: path longer than the stop radius
      let path = 0;
      for (let k = r.i + 1; k <= r.j; k++) path += distM(pts[k - 1], pts[k]);
      if (path > s.stopRadius) walks.push({ ...r, type: 'Walk' });
    }
  }

  let visits = stops.concat(walks).sort((x, y) => x.i - y.i);
  visits.forEach(v => Object.assign(v, centroid(pts.slice(v.i, v.j + 1)),
    { start: pts[v.i].t, end: pts[v.j].t }));

  // merge visits to the same place close together in time
  const merged = [];
  for (const v of visits) {
    const m = merged[merged.length - 1];
    const radius = v.type === 'Walk' || (m && m.type === 'Walk') ? s.walkRadius : s.stopRadius * 1.5;
    if (m && m.type === v.type && v.start - m.end <= s.mergeGapMin * 60000 && distM(m, v) <= radius) {
      m.j = v.j; m.end = v.end;
      Object.assign(m, centroid(pts.slice(m.i, m.j + 1)));
    } else merged.push({ ...v });
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Day analysis                                                        */
/* ------------------------------------------------------------------ */

function analyseDay(raw, s) {
  const { points: pts, quality } = cleanPoints(raw, s);
  if (!pts.length) throw new Error('No usable GPS points in this file.');
  const visits = findVisits(pts, s);
  const last = pts.length - 1;
  const home = (s.homeLat != null && s.homeLon != null && s.homeLat !== '' && s.homeLon !== '')
    ? { lat: +s.homeLat, lon: +s.homeLon } : null;
  const isHome = p => home && distM(p, home) <= s.homeRadius;
  const notes = [];

  // index -> visit, for distance and gap logic
  const inVisit = new Array(pts.length).fill(null);
  visits.forEach(v => { for (let k = v.i; k <= v.j; k++) inVisit[k] = v; });

  // Start and Finish
  let startVisit = visits.length && visits[0].i === 0 ? visits[0] : null;
  let finishVisit = visits.length && visits[visits.length - 1].j === last ? visits[visits.length - 1] : null;
  const allDay = startVisit && startVisit === finishVisit;
  const start = startVisit
    ? { lat: startVisit.lat, lon: startVisit.lon, t: allDay ? pts[0].t : startVisit.end }
    : { lat: pts[0].lat, lon: pts[0].lon, t: pts[0].t };
  const finish = finishVisit
    ? { lat: finishVisit.lat, lon: finishVisit.lon, t: allDay ? pts[last].t : finishVisit.start }
    : { lat: pts[last].lat, lon: pts[last].lon, t: pts[last].t };
  if (!startVisit) notes.push('day did not start at a stop (phone off overnight?)');
  if (!finishVisit) notes.push('day did not finish at a stop');
  start.kind = isHome(start) ? 'Home' : 'Hotel';
  finish.kind = isHome(finish) ? 'Home' : 'Hotel';
  if (!home) notes.push('Home not set in Settings');

  const middle = visits.filter(v => v !== startVisit && v !== finishVisit);

  // gaps and distance
  const gaps = [];
  let dist = 0, prev = null;
  for (let k = 0; k < pts.length; k++) {
    const v = inVisit[k];
    const p = v && v.type === 'Stop' ? { lat: v.lat, lon: v.lon, t: pts[k].t, v } : { ...pts[k], v };
    if (prev) {
      const sameStop = v && v.type === 'Stop' && prev.v === v;
      if (!sameStop) {
        const d = distM(prev, p);
        dist += d;
        if (pts[k].t - pts[k - 1].t > s.gapMin * 60000 && d > s.stopRadius) {
          gaps.push({ from: pts[k - 1].t, to: pts[k].t, m: d });
        }
      }
    }
    prev = p;
  }

  const items = [];
  items.push({ id: 'start', type: 'Start', kind: start.kind, lat: start.lat, lon: start.lon, t: start.t });
  for (const v of middle) {
    items.push({ id: `${v.type}-${new Date(v.start).toISOString()}`, type: v.type,
      lat: v.lat, lon: v.lon, start: v.start, end: v.end });
  }
  if (allDay) notes.push('no travel recorded');
  items.push({ id: 'finish', type: 'Finish', kind: finish.kind, lat: finish.lat, lon: finish.lon, t: finish.t });

  return {
    points: pts, rawCount: raw.points.length + raw.unreadable,
    firstT: pts[0].t, lastT: pts[last].t,
    quality, gaps, notes, distKm: dist / 1000, items, visits
  };
}

function qualityText(day, s) {
  const q = day.quality, parts = [];
  const removed = q.duplicates + q.lowAccuracy + q.jumps + q.unreadable;
  if (removed) {
    const why = [];
    if (q.unreadable) why.push(`${q.unreadable} unreadable`);
    if (q.duplicates) why.push(`${q.duplicates} duplicate`);
    if (q.lowAccuracy) why.push(`${q.lowAccuracy} low accuracy`);
    if (q.jumps) why.push(`${q.jumps} jump`);
    parts.push(`${removed} bad point${removed === 1 ? '' : 's'} removed (${why.join(', ')})`);
  }
  if (q.reordered) parts.push('points re-sorted by time');
  for (const g of day.gaps) parts.push(`gap ${fmtTime(g.from, s)} to ${fmtTime(g.to, s)} (distance estimated)`);
  parts.push(...day.notes);
  return parts.length ? parts.join('; ') : 'no problems found';
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function itemTime(it, s) {
  if (it.type === 'Start' || it.type === 'Finish') return fmtTime(it.t, s);
  return `${fmtTime(it.start, s)} to ${fmtTime(it.end, s)} (${fmtDur(it.end - it.start)})`;
}
function itemPlace(it) {
  if (it.kind === 'Home') return 'Home';
  if (it.kind === 'Hotel') return `Hotel, ${it.name || '…'}`;
  return it.name || '…';
}

function buildReport(day, s, notes) {
  const L = [];
  L.push(`Travel Blogger Assistant – Travel Report for ${fmtDate(day.firstT, s)}`);
  L.push('');
  L.push(`GPS data: ${fmtTime(day.firstT, s)} to ${fmtTime(day.lastT, s)}, ${day.points.length} points`);
  L.push(`Data quality: ${qualityText(day, s)}`);
  L.push(`Distance travelled (estimate): ${day.distKm.toFixed(1)} km`);
  L.push('');
  for (const it of day.items) {
    let line = `${itemTime(it, s)}: ${it.type}: ${itemPlace(it)}`;
    if (s.showMapsLinks && it.kind !== 'Home') line += ` – ${mapsLink(it)}`;
    L.push(line);
  }
  L.push('');
  L.push('Notes:');
  L.push((notes || '').trim());
  return L.join('\n').replace(/\n+$/, '\n');
}

/* ------------------------------------------------------------------ */
/* Place names (OpenStreetMap Nominatim) and cache                     */
/* ------------------------------------------------------------------ */

const LOCALITY_KEYS = ['suburb', 'town', 'city', 'village', 'hamlet', 'municipality', 'county', 'state'];
const WALK_NAME_CATEGORIES = ['leisure', 'tourism', 'natural', 'historic', 'boundary', 'place'];

function nameFromNominatim(data, type, detail) {
  const a = data.address || {};
  const locality = LOCALITY_KEYS.map(k => a[k]).find(Boolean) || '';
  const road = a.road || a.pedestrian || a.footway || a.path || '';
  const join = (...xs) => xs.filter(Boolean).join(', ');
  if (type === 'Walk') {
    const named = data.name && WALK_NAME_CATEGORIES.includes(data.category) ? data.name : '';
    const area = named || a.neighbourhood || '';
    return `Vicinity ${locality || area || 'unknown'}${area && locality && area !== locality ? ' – ' + area : ''}`;
  }
  if (detail === 'suburb') return locality || road || data.display_name || '';
  if (detail === 'name' && data.name && data.name !== road) return join(data.name, locality);
  return join(road, locality) || data.display_name || '';
}

const cache = {
  key: 'tla.placeCache',
  list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch { return []; } },
  save(arr) { try { localStorage.setItem(this.key, JSON.stringify(arr)); } catch { /* ignore */ } },
  find(p, type, radius) {
    let best = null, bestD = Infinity;
    for (const e of this.list()) {
      if ((e.type === 'Walk') !== (type === 'Walk')) continue;
      const d = distM(p, e);
      if (d <= radius && (d < bestD || (e.edited && !best?.edited))) { best = e; bestD = d; }
    }
    return best;
  },
  put(p, type, name, edited) {
    const arr = this.list().filter(e => !(distM(p, e) < 15 && (e.type === 'Walk') === (type === 'Walk')));
    arr.push({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), type, name, edited: !!edited });
    this.save(arr);
  }
};

let lastLookup = 0;
async function nominatim(p, s) {
  const wait = Math.max(0, lastLookup + 1100 - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastLookup = Date.now();
  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.search = new URLSearchParams({ format: 'jsonv2', lat: p.lat.toFixed(6), lon: p.lon.toFixed(6),
    zoom: '18', addressdetails: '1', 'accept-language': 'en' });
  if (s.osmEmail) u.searchParams.set('email', s.osmEmail);
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenStreetMap lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/* ------------------------------------------------------------------ */
/* Browser-only code below                                             */
/* ------------------------------------------------------------------ */

if (typeof window !== 'undefined' && typeof document !== 'undefined') (function ui() {
  const $ = id => document.getElementById(id);
  let settings = loadSettings();
  let dirHandle = null;
  let files = [];          // [{name, handle?, file?}]
  let current = null;      // {name, dateKey, raw, day, edits}
  let pickingHome = false;
  let lookupRun = 0;

  /* ---------- status ---------- */
  function status(msg, ok) { const el = $('status'); el.textContent = msg || ''; el.className = 'status' + (ok ? ' ok' : ''); }

  /* ---------- map ---------- */
  let map = null, layer = null;
  if (window.L) {
    map = L.map('map', { zoomControl: true }).setView([-27.47, 153.02], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.on('click', e => {
      if (!pickingHome) return;
      pickingHome = false; $('map').classList.remove('picking');
      settings.homeLat = +e.latlng.lat.toFixed(6); settings.homeLon = +e.latlng.lng.toFixed(6);
      saveSettings(settings); status('Home set from the map.', true); reanalyse();
    });
  } else {
    $('map').textContent = 'Map unavailable (no internet connection?)';
  }

  function drawMap(day) {
    if (!map) return;
    layer.clearLayers();
    const line = day.points.map(p => [p.lat, p.lon]);
    if (line.length) L.polyline(line, { color: '#1d5c63', weight: 3, opacity: .8 }).addTo(layer);
    for (const g of day.gaps) {
      const a = day.points.find(p => p.t === g.from), b = day.points.find(p => p.t === g.to);
      if (a && b) L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#c0623b', weight: 3, dashArray: '6 6' }).addTo(layer);
    }
    let n = 0;
    for (const it of day.items) {
      const label = it.type === 'Start' ? 'S' : it.type === 'Finish' ? 'F' : String(++n);
      const icon = L.divIcon({ className: '', html: `<div class="pin ${it.type}">${label}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([it.lat, it.lon], { icon }).bindPopup(`<b>${escapeHtml(itemPlace(it))}</b><br>${escapeHtml(itemTime(it, settings))}`).addTo(layer);
    }
    if (settings.homeLat != null && settings.homeLat !== '') {
      L.circle([+settings.homeLat, +settings.homeLon], { radius: settings.homeRadius, color: '#c0623b', weight: 1, fillOpacity: .06 }).addTo(layer);
    }
    if (line.length) map.fitBounds(L.latLngBounds(line).pad(0.15));
  }

  function escapeHtml(t) { return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------- folder handling (File System Access API) ---------- */
  const idb = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('tla', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const db = await this.open(); return new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }); },
    async set(k, v) { const db = await this.open(); return new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => res(); }); }
  };

  async function chooseFolder() {
    if (!window.showDirectoryPicker) { status('This browser cannot open folders. Use "Open a GPX file" instead.'); return; }
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'tla-gps', mode: 'readwrite' });
      await idb.set('dir', dirHandle).catch(() => {});
      $('btnReconnect').hidden = true;
      await listFolder();
    } catch (e) { if (e.name !== 'AbortError') status('Could not open the folder: ' + e.message); }
  }

  async function restoreFolder() {
    if (!window.showDirectoryPicker) return;
    try {
      const h = await idb.get('dir');
      if (!h) return;
      dirHandle = h;
      const perm = await h.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') await listFolder();
      else { $('btnReconnect').hidden = false; $('btnReconnect').textContent = `Reconnect “${h.name}”`; status('Click "Reconnect" to allow access to your GPS folder again.', true); }
    } catch { /* first run */ }
  }

  async function reconnect() {
    if (!dirHandle) return chooseFolder();
    const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') { $('btnReconnect').hidden = true; status(''); await listFolder(); }
  }

  async function listFolder() {
    files = [];
    for await (const [name, h] of dirHandle.entries()) {
      if (h.kind === 'file' && /\.gpx$/i.test(name)) files.push({ name, handle: h });
    }
    files.sort((a, b) => b.name.localeCompare(a.name));
    fillDaySelect();
    if (!files.length) { status(`No .gpx files found in “${dirHandle.name}”.`); return; }
    status(`${files.length} GPX file${files.length === 1 ? '' : 's'} in “${dirHandle.name}”.`, true);
    await loadFile(files[0]);
  }

  function fillDaySelect() {
    const sel = $('daySelect');
    sel.innerHTML = '';
    for (const f of files) {
      const o = document.createElement('option');
      o.value = f.name; o.textContent = prettyFileName(f.name);
      sel.appendChild(o);
    }
    sel.disabled = !files.length;
  }
  function prettyFileName(name) {
    const m = name.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return name;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return `${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}  (${name})`;
  }

  /* ---------- load + analyse ---------- */
  async function loadFile(f) {
    try {
      const file = f.file || await f.handle.getFile();
      const text = await file.text();
      const dateKey = (f.name.match(/^(\d{8})/) || [])[1] || f.name.replace(/\.gpx$/i, '');
      const raw = parseGpx(text);
      if (!raw.points.length) throw new Error('The file has no GPS points.');
      current = { name: f.name, dateKey, raw, edits: await loadEdits(dateKey) };
      $('notes').value = loadNotes(dateKey);
      reanalyse();
    } catch (e) {
      current = null;
      status(`Could not read ${f.name}: ${e.message}`);
      $('report').textContent = 'No report — the file could not be read.';
      $('itinerary').innerHTML = '';
      setButtons(false);
    }
  }

  function reanalyse() {
    if (!current) return;
    try {
      current.day = analyseDay(current.raw, settings);
    } catch (e) { status(e.message); return; }
    applyKnownNames();
    render();
    lookupNames();
  }

  /* ---------- edits (sidecar file + browser copy) ---------- */
  const sidecarName = k => `${k}.places.json`;
  async function loadEdits(k) {
    let edits = {};
    try { edits = JSON.parse(localStorage.getItem('tla.edits.' + k) || '{}'); } catch { /* ignore */ }
    if (dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle(sidecarName(k));
        const j = JSON.parse(await (await fh.getFile()).text());
        for (const e of j.places || []) edits[e.id] = e;
      } catch { /* no sidecar yet */ }
    }
    return edits;
  }
  async function saveEdits() {
    const k = current.dateKey;
    try { localStorage.setItem('tla.edits.' + k, JSON.stringify(current.edits)); } catch { /* ignore */ }
    if (!dirHandle) return;
    try {
      const fh = await dirHandle.getFileHandle(sidecarName(k), { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify({ date: k, places: Object.values(current.edits) }, null, 2));
      await w.close();
    } catch (e) { status('Could not save edits file: ' + e.message); }
  }
  function findEdit(it) {
    const e = current.edits[it.id];
    if (e) return e;
    // fall back to a nearby edit of the same type (times may shift slightly after settings changes)
    return Object.values(current.edits).find(x => x.type === it.type && distM(x, it) <= (it.type === 'Walk' ? settings.walkRadius : settings.stopRadius));
  }

  function loadNotes(k) { try { return localStorage.getItem('tla.notes.' + k) || ''; } catch { return ''; } }
  function saveNotes(k, v) { try { localStorage.setItem('tla.notes.' + k, v); } catch { /* ignore */ } }

  /* ---------- names ---------- */
  function applyKnownNames() {
    for (const it of current.day.items) {
      if (it.kind === 'Home') { it.name = 'Home'; continue; }
      const e = findEdit(it);
      if (e) { it.name = e.name; it.edited = true; continue; }
      const c = cache.find(it, it.type, it.type === 'Walk' ? settings.walkRadius / 2 : Math.max(50, settings.stopRadius));
      if (c) { it.name = c.name; it.edited = c.edited; }
    }
  }

  async function lookupNames() {
    const run = ++lookupRun;
    const todo = current.day.items.filter(it => !it.name);
    let failed = 0;
    for (const it of todo) {
      if (run !== lookupRun) return;
      status(`Looking up place names… (${todo.indexOf(it) + 1} of ${todo.length})`, true);
      try {
        const data = await nominatim(it, settings);
        it.name = nameFromNominatim(data, it.type, settings.placeDetail) || `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}`;
        cache.put(it, it.type, it.name, false);
      } catch (e) {
        failed++;
        it.name = `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}`; it.failed = true;
        console.warn(e);
      }
      if (run === lookupRun) render();
    }
    if (run !== lookupRun) return;
    if (failed) status(`${failed} place name lookup${failed === 1 ? '' : 's'} failed — co-ordinates shown; you can type a name. ` +
      (location.protocol === 'file:' ? 'If every lookup fails, check the internet connection, or run the App from a local web server instead of opening the file directly.' : 'Check the internet connection.'));
    else if (todo.length) status('Place names done.', true);
  }

  /* ---------- render ---------- */
  function render() {
    const day = current.day, s = settings;
    $('sumDate').textContent = fmtDate(day.firstT, s);
    $('sumTimes').textContent = `${fmtTime(day.firstT, s)} to ${fmtTime(day.lastT, s)}, ${day.points.length} points`;
    $('sumDist').textContent = `${day.distKm.toFixed(1)} km`;
    $('sumQuality').textContent = qualityText(day, s);

    const ol = $('itinerary');
    ol.innerHTML = '';
    for (const it of day.items) {
      const li = document.createElement('li');
      const time = document.createElement('span'); time.className = 'it-time'; time.textContent = itemTime(it, s);
      const type = document.createElement('span'); type.className = 'it-type ' + it.type; type.textContent = it.type;
      const inp = document.createElement('input');
      inp.className = 'it-name' + (it.edited ? ' edited' : '') + (it.failed ? ' failed' : '');
      inp.value = it.kind === 'Hotel' && it.name ? it.name : (it.name || '');
      inp.placeholder = 'Looking up…';
      inp.title = it.kind === 'Hotel' ? 'Hotel name (the report adds "Hotel, ")' : 'Click to edit';
      if (it.kind === 'Home') { inp.value = 'Home'; inp.disabled = true; }
      inp.addEventListener('change', () => editName(it, inp.value.trim()));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      const a = document.createElement('a'); a.className = 'it-map'; a.href = mapsLink(it); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Map ↗';
      li.append(time, type, inp, a);
      ol.appendChild(li);
    }
    if (!day.items.length) ol.innerHTML = '<li class="empty">No places found.</li>';
    drawMap(day);
    updateReport();
    setButtons(true);
  }

  function editName(it, name) {
    if (!name) return;
    it.name = name; it.edited = true; it.failed = false;
    current.edits[it.id] = { id: it.id, type: it.type, lat: +it.lat.toFixed(6), lon: +it.lon.toFixed(6), name };
    cache.put(it, it.type, name, true);
    saveEdits();
    render();
  }

  function updateReport() {
    if (!current || !current.day) return;
    $('report').textContent = buildReport(current.day, settings, $('notes').value);
  }
  function setButtons(on) { $('btnCopy').disabled = !on; $('btnSave').disabled = !on; }

  /* ---------- report actions ---------- */
  async function copyReport() {
    const text = $('report').textContent;
    try { await navigator.clipboard.writeText(text); status('Report copied to the clipboard.', true); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); status('Report copied to the clipboard.', true);
    }
  }
  async function saveReport() {
    const text = $('report').textContent;
    const name = `${current.dateKey}-report.txt`;
    if (dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(text); await w.close();
        status(`Saved ${name} in “${dirHandle.name}”.`, true); return;
      } catch (e) { status('Could not save into the folder, downloading instead: ' + e.message); }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------- settings dialog ---------- */
  function buildSettingsForm() {
    const box = $('settingsFields');
    box.innerHTML = '';
    for (const f of SETTINGS_SCHEMA) {
      const wrap = document.createElement('div'); wrap.className = 'field' + (f.wide ? ' wide' : '');
      const id = 'set_' + f.key;
      const lab = document.createElement('label'); lab.htmlFor = id;
      lab.innerHTML = escapeHtml(f.label) + (f.unit ? ` <span class="unit">(${escapeHtml(f.unit)})</span>` : '');
      let el;
      if (f.type === 'select') {
        el = document.createElement('select');
        for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; el.appendChild(o); }
        el.value = settings[f.key];
      } else {
        el = document.createElement('input'); el.type = f.type;
        if (f.type === 'checkbox') el.checked = !!settings[f.key];
        else el.value = settings[f.key] ?? '';
        if (f.min != null) el.min = f.min;
        if (f.step) el.step = f.step;
        if (f.placeholder) el.placeholder = f.placeholder;
      }
      el.id = id;
      if (f.type === 'checkbox') { wrap.style.flexDirection = 'row'; wrap.style.alignItems = 'center'; wrap.append(el, lab); }
      else wrap.append(lab, el);
      box.appendChild(wrap);
    }
  }
  function readSettingsForm() {
    const s = { ...settings };
    for (const f of SETTINGS_SCHEMA) {
      const el = $('set_' + f.key);
      if (f.type === 'checkbox') s[f.key] = el.checked;
      else if (f.type === 'number') s[f.key] = el.value === '' ? (f.key.startsWith('home') ? null : DEFAULTS[f.key]) : +el.value;
      else s[f.key] = el.value.trim();
    }
    if (s.timeZone) {
      try { new Intl.DateTimeFormat('en-AU', { timeZone: s.timeZone }); }
      catch { alertish(`“${s.timeZone}” is not a known time zone; using this device's.`); s.timeZone = ''; }
    }
    return s;
  }
  function alertish(msg) { status(msg); }

  $('btnSettings').addEventListener('click', () => { buildSettingsForm(); $('settingsDlg').showModal(); });
  $('settingsForm').addEventListener('submit', e => {
    if (e.submitter && e.submitter.value === 'save') {
      settings = readSettingsForm(); saveSettings(settings); reanalyse();
    }
  });
  $('btnDefaults').addEventListener('click', () => {
    const keepHome = { homeLat: settings.homeLat, homeLon: settings.homeLon, osmEmail: settings.osmEmail };
    settings = { ...DEFAULTS, ...keepHome }; buildSettingsForm();
  });
  $('btnHomeHere').addEventListener('click', () => {
    if (!navigator.geolocation) { status('Location is not available in this browser.'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      $('set_homeLat').value = pos.coords.latitude.toFixed(6);
      $('set_homeLon').value = pos.coords.longitude.toFixed(6);
    }, err => status('Could not get your location: ' + err.message), { enableHighAccuracy: true, timeout: 15000 });
  });
  $('btnHomeMap').addEventListener('click', () => {
    settings = readSettingsForm(); saveSettings(settings);
    $('settingsDlg').close();
    pickingHome = true; $('map').classList.add('picking');
    status('Click your home on the map.', true);
  });
  $('btnExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(readSettingsForm(), null, 2)], { type: 'application/json' }));
    a.download = 'timeline-alt-settings.json'; a.click();
  });
  $('importInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { settings = { ...DEFAULTS, ...JSON.parse(await f.text()) }; buildSettingsForm(); status('Settings imported — click Save to keep them.', true); }
    catch { status('That file is not a settings file.'); }
    e.target.value = '';
  });

  /* ---------- wiring ---------- */
  $('btnFolder').addEventListener('click', chooseFolder);
  $('btnReconnect').addEventListener('click', reconnect);
  $('fileInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    files = [{ name: f.name, file: f }]; fillDaySelect();
    await loadFile(files[0]);
    e.target.value = '';
  });
  $('daySelect').addEventListener('change', e => {
    const f = files.find(x => x.name === e.target.value); if (f) loadFile(f);
  });
  $('notes').addEventListener('input', () => { if (current) saveNotes(current.dateKey, $('notes').value); updateReport(); });
  $('btnCopy').addEventListener('click', copyReport);
  $('btnSave').addEventListener('click', saveReport);

  if (settings.homeLat == null || settings.homeLat === '') status('Tip: set your Home location in Settings first.', true);
  restoreFolder();
})();

/* Exports for testing under Node */
if (typeof module !== 'undefined') {
  module.exports = { DEFAULTS, parseGpx, cleanPoints, findVisits, analyseDay, buildReport, qualityText,
    nameFromNominatim, distM, fmtTime, fmtDate, fmtDur };
}
