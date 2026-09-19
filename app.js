/* IBX Housing Explorer
   3D capacity map for the 19 proposed Interborough Express stations.
   Data: New York Building Congress / New York Building Foundation, 2025 IBX report. */

const CAT = {
  commercial:    { label: 'Commercial',            color: '#C9822A' },
  manufacturing: { label: 'Manufacturing',         color: '#F2B441' },
  lowRes:        { label: 'Low-density residential',  color: '#49CFCF' },
  highRes:       { label: 'High-density residential', color: '#1F7E78' }
};
const CAT_KEYS = ['commercial', 'manufacturing', 'lowRes', 'highRes'];
const TYPO_COLOR = {
  'High Res': '#1F7E78', 'Low Res': '#49CFCF', 'Manufacturing': '#F2B441',
  'Res Blend': '#2FA6A0', 'Varied Blend': '#8E7BE8'
};
const WALKSHED_M = 804.672;          // half a mile
// Buildings are real lots at real heights. Zoomed out they would be sub-pixel slivers, so heights
// are exaggerated at low zoom and ease back to true scale by street level. ["zoom"] has to be the
// outermost expression, so the multiplier is folded into each stop.
const exaggerated = prop => ['interpolate', ['linear'], ['zoom'],
  10, ['*', ['get', prop], 9],
  12, ['*', ['get', prop], 4],
  14, ['*', ['get', prop], 1.6],
  16, ['*', ['get', prop], 1]];

const fmt = n => (Number.isFinite(n) ? n : 0).toLocaleString('en-US');
const fmtC = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : fmt(Math.round(n));

let DATA, LOTS, map, scenario = 's5', selected = null, tourTimer = null;

/* ── geometry helpers ─────────────────────────────────── */
const M_PER_DEG_LAT = 110574;
function circle(lon, lat, radius, steps = 48) {
  const dx = radius / (111320 * Math.cos(lat * Math.PI / 180));
  const dy = radius / M_PER_DEG_LAT, ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dx * Math.cos(a), lat + dy * Math.sin(a)]);
  }
  return [ring];
}
function metresBetween(a, b) {
  const dLat = (b[1] - a[1]) * M_PER_DEG_LAT;
  const dLon = (b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

/* ── boot ─────────────────────────────────────────────── */
(async function init() {
  const [d, l] = await Promise.all([
    fetch('data/ibx.json').then(r => r.json()),
    fetch('data/lots.json').then(r => r.json())
  ]);
  DATA = d; LOTS = decodeLots(l, d.stations);

  buildMap();
  buildScenarioUI();
  buildSearch();
  buildControls();
  document.getElementById('open-method').onclick = () => (document.getElementById('method').hidden = false);
  document.getElementById('method-close').onclick = () => (document.getElementById('method').hidden = true);
  document.getElementById('method').onclick = e => {
    if (e.target.id === 'method') document.getElementById('method').hidden = true;
  };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('method').hidden) document.getElementById('method').hidden = true;
    else if (!document.getElementById('detail').hidden) closeDetail();
  });
})();

/* ── map ──────────────────────────────────────────────── */
function buildMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [-73.945, 40.688], zoom: 10.9, pitch: 55, bearing: -14,
    antialias: true, attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  // MapLibre's own resize observer can miss a size change made while the tab is hidden or
  // still opening, which leaves the canvas stuck at its first size — re-measure on these too
  const fit = () => {
    const c = map.getCanvas(), el = map.getContainer();
    if (c.clientWidth !== el.clientWidth || c.clientHeight !== el.clientHeight) map.resize();
  };
  window.addEventListener('resize', fit);
  document.addEventListener('visibilitychange', fit);
  map.once('idle', fit);

  // 'load' waits on the basemap sprite/glyph fetches, which can hang on a slow CDN.
  // 'style.load' is enough to start adding our own sources and layers.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    try { addLayers(); } catch (e) { console.error('addLayers failed:', e); }
    document.getElementById('boot').classList.add('gone');
  };
  if (map.isStyleLoaded()) start(); else map.once('style.load', start);
  map.on('error', e => console.warn('map error:', e && e.error && e.error.message));
  // safety net for a slow CDN: keep checking rather than firing into a half-built style
  const poll = setInterval(() => {
    if (started) return clearInterval(poll);
    if (map.isStyleLoaded()) { clearInterval(poll); start(); }
  }, 500);
}

function walkshedFC() {
  return {
    type: 'FeatureCollection',
    features: DATA.stations.map(s => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, color: TYPO_COLOR[s.typology] || '#8E7BE8' },
      geometry: { type: 'Polygon', coordinates: circle(s.lon, s.lat, WALKSHED_M, 72) }
    }))
  };
}

/* lots.json stores each lot outline as delta-encoded integer metres-ish offsets from one origin */
function decodeLots(l, stations) {
  const rings = l.g.map(flat => {
    let x = flat[0], y = flat[1];
    const ring = [[l.o[0] + x / l.q, l.o[1] + y / l.q]];
    for (let i = 2; i < flat.length; i += 2) {
      x += flat[i]; y += flat[i + 1];
      ring.push([l.o[0] + x / l.q, l.o[1] + y / l.q]);
    }
    ring.push(ring[0]);
    return ring;
  });
  // nearest station per lot, so clicking a building opens its station
  const near = rings.map(r => {
    let best = 0, bd = Infinity;
    stations.forEach((s, i) => {
      const d = metresBetween(r[0], [s.lon, s.lat]);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  });
  return { ...l, rings, near };
}

/* grey: every tax lot with homes today, at its real floor count */
function homesFC() {
  const f = [];
  LOTS.rings.forEach((ring, i) => {
    if (LOTS.u[i] <= 0) return;
    f.push({
      type: 'Feature', id: i,
      properties: { i, h: LOTS.h[i] },
      geometry: { type: 'Polygon', coordinates: [ring] }
    });
  });
  return { type: 'FeatureCollection', features: f };
}

/* coloured: the new homes this scenario puts on each lot, stacked on whatever homes are there now */
function newFC() {
  return {
    type: 'FeatureCollection',
    features: LOTS.s[scenario].map(([i, c, n, hm]) => ({
      type: 'Feature', id: i,
      properties: { i, n, cat: CAT_KEYS[c], color: CAT[CAT_KEYS[c]].color, base: LOTS.h[i], top: LOTS.h[i] + hm },
      geometry: { type: 'Polygon', coordinates: [LOTS.rings[i]] }
    }))
  };
}

function stationFC() {
  return {
    type: 'FeatureCollection',
    features: DATA.stations.map(s => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, units: s.scenarios[scenario] },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] }
    }))
  };
}

function addLayers() {
  map.addSource('walksheds', { type: 'geojson', data: walkshedFC(), generateId: true });
  map.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: DATA.route } }
  });
  // tolerance 0 so geojson-vt doesn't drop small lots when simplifying at low zoom
  map.addSource('homes', { type: 'geojson', data: homesFC(), tolerance: 0, maxzoom: 15 });
  map.addSource('newhomes', { type: 'geojson', data: newFC(), tolerance: 0, maxzoom: 15 });
  map.addSource('stations', { type: 'geojson', data: stationFC() });
  map.addSource('you', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'walkshed-fill', type: 'fill', source: 'walksheds',
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.22, 0.07]
    }
  });
  map.addLayer({
    id: 'walkshed-line', type: 'line', source: 'walksheds',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 2, 1],
      'line-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.9, 0.3],
      'line-dasharray': [2, 2]
    }
  });

  map.addLayer({
    id: 'route-glow', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#9B8CF5', 'line-width': 13, 'line-opacity': 0.16, 'line-blur': 10 }
  });
  map.addLayer({
    id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#B9AEFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 5], 'line-opacity': 0.95 }
  });

  map.addLayer({
    id: 'homes-ext', type: 'fill-extrusion', source: 'homes',
    paint: {
      'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#8F98B8', '#4A5270'],
      'fill-extrusion-height': exaggerated('h'),
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.92,
      'fill-extrusion-vertical-gradient': true
    }
  });
  map.addLayer({
    id: 'new-ext', type: 'fill-extrusion', source: 'newhomes',
    paint: {
      'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#FFFFFF', ['get', 'color']],
      'fill-extrusion-height': exaggerated('top'),
      'fill-extrusion-base': exaggerated('base'),
      'fill-extrusion-opacity': 0.97,
      'fill-extrusion-vertical-gradient': true
    }
  });

  map.addLayer({
    id: 'station-dot', type: 'circle', source: 'stations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 7],
      'circle-color': '#0a0d16', 'circle-stroke-color': '#B9AEFF', 'circle-stroke-width': 2
    }
  });
  map.addLayer({
    id: 'station-label', type: 'symbol', source: 'stations',
    minzoom: 11.6,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Open Sans Bold'],
      'text-size': 11.5, 'text-offset': [0, 1.3], 'text-anchor': 'top',
      'text-allow-overlap': false, 'text-padding': 4
    },
    paint: { 'text-color': '#dfe4f2', 'text-halo-color': '#07090f', 'text-halo-width': 1.6 }
  });

  map.addLayer({
    id: 'you-halo', type: 'circle', source: 'you',
    paint: { 'circle-radius': 16, 'circle-color': '#fff', 'circle-opacity': 0.16, 'circle-blur': 0.6 }
  });
  map.addLayer({
    id: 'you-dot', type: 'circle', source: 'you',
    paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#6C5DD3', 'circle-stroke-width': 3 }
  });

  // interaction
  ['station-dot', 'walkshed-fill'].forEach(l => {
    map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
    map.on('click', l, e => selectStation(e.features[0].properties.id, true));
  });
  map.on('mousemove', 'station-dot', e => showStationTip(e.point, e.features[0].properties.id));
  map.on('mouseleave', 'station-dot', hideTip);

  // buildings: hover for the lot, click to open its station
  let hovered = null;
  const unhover = () => {
    if (hovered) map.setFeatureState({ source: hovered.src, id: hovered.id }, { hover: false });
    hovered = null;
  };
  map.on('mousemove', e => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['new-ext', 'homes-ext'] })[0];
    unhover();
    if (!f) { if (!map.queryRenderedFeatures(e.point, { layers: ['station-dot'] }).length) hideTip(); map.getCanvas().style.cursor = ''; return; }
    hovered = { src: f.source, id: f.id };
    map.setFeatureState(hovered, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
    showLotTip(e.point, f.properties.i, f.source === 'newhomes' ? f.properties : null);
  });
  map.on('mouseout', () => { unhover(); hideTip(); });
  map.on('movestart', () => { unhover(); hideTip(); });
  map.on('click', e => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['new-ext', 'homes-ext'] })[0];
    if (f) selectStation(DATA.stations[LOTS.near[f.properties.i]].id, false);
  });

  refresh();
  requestAnimationFrame(() => requestAnimationFrame(() => { map.resize(); fitRoute(false); }));
}

/* ── tooltip ──────────────────────────────────────────── */
function placeTip(pt, html) {
  const el = document.getElementById('tip');
  el.innerHTML = html;
  el.style.left = pt.x + 'px'; el.style.top = pt.y + 'px'; el.hidden = false;
}
function showStationTip(pt, id) {
  const s = DATA.stations.find(x => x.id === id); if (!s) return;
  placeTip(pt, `<b>${s.name}</b><em>+${fmt(s.scenarios[scenario])}</em> <span>new homes · ${fmt(s.existingUnits)} today</span>`);
}
function showLotTip(pt, i, added) {
  const today = LOTS.u[i];
  const zone = LOTS.zones[LOTS.z[i]];
  const lines = [`<b>${LOTS.a[i] || 'Tax lot'}</b>`];
  if (added) lines.push(`<em style="color:${added.color}">+${fmt(added.n)} new home${added.n === 1 ? '' : 's'}</em> <span>on ${CAT[added.cat].label.toLowerCase()} land</span><br>`);
  lines.push(`<span>${today ? fmt(today) + ' home' + (today === 1 ? '' : 's') + ' today' : 'No homes today'} · zoned ${zone}</span>`);
  placeTip(pt, lines.join(''));
}
const hideTip = () => (document.getElementById('tip').hidden = true);

/* ── scenario UI ──────────────────────────────────────── */
function buildScenarioUI() {
  const wrap = document.getElementById('scenarios');
  wrap.innerHTML = DATA.scenarios.map(s => `
    <button class="scen${s.id === scenario ? ' on' : ''}${s.n === 5 ? ' rec' : ''}" data-id="${s.id}">
      <span class="scen-n">${s.n}</span>
      <span>
        <span class="scen-name">${s.name.replace(' — recommended', '')}</span>
        <span class="scen-sub">${s.short}</span>
      </span>
      <span class="scen-u">+${fmtC(s.units)}</span>
    </button>`).join('');
  wrap.querySelectorAll('.scen').forEach(b => (b.onclick = () => setScenario(b.dataset.id)));
}

function setScenario(id) {
  if (id === scenario) return;
  scenario = id;
  document.querySelectorAll('.scen').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  map.getSource('newhomes').setData(newFC());
  map.getSource('stations').setData(stationFC());
  refresh();
  if (selected) renderDetail(selected);
  if (lastPlace) renderYou(lastPlace);
}

function refresh() {
  const sc = DATA.scenarios.find(s => s.id === scenario);
  document.getElementById('scen-detail').innerHTML = `${sc.desc}<em>${sc.note}</em>`;

  const c = DATA.corridor;
  const after = c.existingUnits + sc.units;
  document.getElementById('totals').innerHTML = `
    <div class="tot"><b>${fmt(c.existingUnits)}</b><span>HOMES TODAY</span></div>
    <div class="tot"><b style="color:#9B8CF5">+${fmt(sc.units)}</b><span>NEW HOMES</span></div>
    <div class="tot"><b>${fmt(after)}</b><span>HOMES AFTER</span></div>
    <div class="tot"><b>${fmt(sc.zoned)}</b><span>ZONED CAPACITY</span></div>`;

  const max = Math.max(c.targetNewHomes, ...DATA.scenarios.map(s => s.units));
  document.getElementById('tb-fill').style.width = (sc.units / max * 100) + '%';
  document.getElementById('tb-goal').style.left = (c.targetNewHomes / max * 100) + '%';
}

/* ── station detail ───────────────────────────────────── */
function selectStation(id, fly) {
  const s = DATA.stations.find(x => x.id === id); if (!s) return;
  if (selected) map.setFeatureState({ source: 'walksheds', id: featIndex(selected) }, { active: false });
  selected = id;
  map.setFeatureState({ source: 'walksheds', id: featIndex(id) }, { active: true });
  renderDetail(id);
  document.getElementById('detail').hidden = false;
  if (fly) {
    stopTour();
    map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 14.4), pitch: 60, duration: 1100, offset: [-40, 40] });
  }
}
const featIndex = id => DATA.stations.findIndex(s => s.id === id);

function closeDetail() {
  if (selected) map.setFeatureState({ source: 'walksheds', id: featIndex(selected) }, { active: false });
  selected = null;
  document.getElementById('detail').hidden = true;
}
document.getElementById('detail-close').onclick = closeDetail;

function renderDetail(id) {
  const s = DATA.stations.find(x => x.id === id);
  const sc = DATA.scenarios.find(x => x.id === scenario);
  const units = s.scenarios[scenario];
  const growth = units / s.existingUnits * 100;

  document.getElementById('d-typ').textContent = s.typology;
  document.getElementById('d-typ').style.color = TYPO_COLOR[s.typology];
  document.getElementById('d-name').textContent = s.name;
  document.getElementById('d-boro').textContent =
    `${s.borough} · ${fmt(s.acres)} acres in the ½-mile walkshed`;
  document.getElementById('d-units').textContent = '+' + fmt(units);
  document.getElementById('d-hero-sub').innerHTML =
    `on <strong>${fmt((s.newLots || {})[scenario] || 0)} lots</strong> under <strong>Scenario ${sc.n} · ${sc.name.replace(' — recommended', '')}</strong> — a <strong>${growth.toFixed(0)}%</strong> increase on the ${fmt(s.existingUnits)} homes on ${fmt(s.residentialLots)} lots here today.`;

  const bd = s.breakdown[scenario];
  const bmax = Math.max(...Object.values(bd), 1);
  document.getElementById('d-break').innerHTML = CAT_KEYS.map(k => `
    <div class="bd${bd[k] ? '' : ' zero'}">
      <i style="background:${CAT[k].color}"></i>
      <span class="bd-name">${CAT[k].label}</span>
      <span class="bd-track"><i style="width:${bd[k] / bmax * 100}%;background:${CAT[k].color}"></i></span>
      <span class="bd-val">${bd[k] ? '+' + fmt(bd[k]) : '—'}</span>
    </div>`).join('');

  document.getElementById('d-landbar').innerHTML = CAT_KEYS
    .map(k => `<i style="width:${s.landUse[k]}%;background:${CAT[k].color}"></i>`).join('');
  document.getElementById('d-landkey').innerHTML = CAT_KEYS.map(k =>
    `<span><i style="background:${CAT[k].color}"></i>${CAT[k].label.replace(' residential', '')}<b>${s.landUse[k]}%</b></span>`).join('');
  document.getElementById('d-acres').textContent =
    `${fmtC(s.lotSqFt)} sq ft of lot area inside the walkshed.`;

  document.getElementById('d-q').textContent = s.quickWin.toFixed(2);
  document.getElementById('d-qbar').style.width = (s.quickWin / 5 * 100) + '%';
  document.getElementById('d-qrank').textContent = `Rank ${s.quickRank} of 19 — ${rankWord(s.quickRank)}`;
  document.getElementById('d-e').textContent = s.equity.toFixed(2);
  document.getElementById('d-ebar').style.width = (s.equity / 5 * 100) + '%';
  document.getElementById('d-erank').textContent = `Rank ${s.equityRank} of 19 — ${rankWord(s.equityRank)}`;

  const smax = Math.max(...Object.values(s.scenarios));
  document.getElementById('d-scen').innerHTML = DATA.scenarios.map(x => `
    <div class="sc${x.id === scenario ? ' on' : ''}" data-id="${x.id}">
      <span class="sc-n">${x.n}</span>
      <span class="sc-track"><i style="width:${s.scenarios[x.id] / smax * 100}%"></i></span>
      <span class="sc-v">+${fmt(s.scenarios[x.id])}</span>
    </div>`).join('');
  document.querySelectorAll('#d-scen .sc').forEach(el => (el.onclick = () => setScenario(el.dataset.id)));
}
const rankWord = r => r <= 5 ? 'top five' : r <= 10 ? 'upper half' : r <= 15 ? 'lower half' : 'bottom of the list';

/* ── address search ───────────────────────────────────── */
let searchTimer = null, lastPlace = null;

function buildSearch() {
  const input = document.getElementById('addr');
  const list = document.getElementById('suggest');
  const clear = document.getElementById('addr-clear');

  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; return; }
    searchTimer = setTimeout(() => lookup(q), 220);
  });
  input.addEventListener('keydown', e => {
    const items = [...list.querySelectorAll('li')];
    if (!items.length) return;
    const cur = items.findIndex(i => i.getAttribute('aria-selected') === 'true');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? Math.min(cur + 1, items.length - 1) : Math.max(cur - 1, 0);
      items.forEach((i, n) => i.setAttribute('aria-selected', n === next));
    } else if (e.key === 'Enter') {
      e.preventDefault(); items[Math.max(cur, 0)].click();
    } else if (e.key === 'Escape') { list.hidden = true; }
  });
  clear.onclick = () => { input.value = ''; clear.hidden = true; list.hidden = true; clearYou(); input.focus(); };
  document.getElementById('you-close').onclick = clearYou;
  document.addEventListener('click', e => {
    if (!e.target.closest('#sec-search')) list.hidden = true;
  });
}

async function lookup(q) {
  const hint = document.getElementById('search-hint');
  try {
    const r = await fetch('https://geosearch.planninglabs.nyc/v2/autocomplete?size=6&text=' + encodeURIComponent(q));
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    hint.classList.remove('warn');
    hint.textContent = "Any address in the five boroughs. We'll tell you which station walksheds you sit inside.";
    renderSuggest(j.features || []);
  } catch (err) {
    document.getElementById('suggest').hidden = true;
    hint.classList.add('warn');
    hint.textContent = 'Address lookup is unreachable right now — click any station on the map instead.';
  }
}

function renderSuggest(features) {
  const list = document.getElementById('suggest');
  if (!features.length) {
    list.hidden = true;
    const hint = document.getElementById('search-hint');
    hint.classList.add('warn');
    hint.textContent = 'No match. Try a house number and street name, e.g. "1600 Utica Ave".';
    return;
  }
  list.innerHTML = features.map((f, i) => {
    const p = f.properties;
    return `<li role="option" aria-selected="${i === 0}" data-i="${i}">${p.name || p.label}
      <small>${[p.borough || p.locality, p.region].filter(Boolean).join(', ')}</small></li>`;
  }).join('');
  list.hidden = false;
  list.querySelectorAll('li').forEach(li => (li.onclick = () => {
    const f = features[+li.dataset.i];
    list.hidden = true;
    document.getElementById('addr').value = f.properties.label;
    document.getElementById('addr-clear').hidden = false;
    dropPin(f.geometry.coordinates, f.properties.label);
  }));
}

let youSheds = [];
function setYouSheds(ids) {
  youSheds.forEach(i => map.setFeatureState({ source: 'walksheds', id: i }, { active: false }));
  youSheds = ids;
  ids.forEach(i => map.setFeatureState({ source: 'walksheds', id: i }, { active: true }));
}

function dropPin(coords, label) {
  stopTour();
  const place = { coords, label };
  lastPlace = place;
  map.getSource('you').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords } }]
  });
  renderYou(place);
  const near = walksheds(coords);
  setYouSheds(near.map(x => featIndex(x.s.id)));
  map.easeTo({
    center: coords, zoom: near.length ? 15.2 : 13.2, pitch: 60, duration: 1400, offset: [-40, 40]
  });
}

function walksheds(coords) {
  return DATA.stations
    .map(s => ({ s, d: metresBetween(coords, [s.lon, s.lat]) }))
    .filter(x => x.d <= WALKSHED_M)
    .sort((a, b) => a.d - b.d);
}

function lotAt(pt) {
  const inside = ring => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // lot outlines are inset, so fall back to the nearest lot within ~25 m
  let best = -1, bd = 25;
  for (let i = 0; i < LOTS.rings.length; i++) {
    const r = LOTS.rings[i];
    if (Math.abs(r[0][1] - pt[1]) > 0.002 || Math.abs(r[0][0] - pt[0]) > 0.003) continue;
    if (inside(r)) return i;
    const d = metresBetween(pt, r[0]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function lotLine(i) {
  if (i < 0) return '';
  const add = LOTS.s[scenario].find(r => r[0] === i);
  const today = LOTS.u[i], zone = LOTS.zones[LOTS.z[i]];
  const now = today ? `${fmt(today)} home${today === 1 ? '' : 's'} today` : 'no homes today';
  const what = add
    ? `this scenario builds <strong style="color:${CAT[CAT_KEYS[add[1]]].color}">+${fmt(add[2])}</strong> new homes here`
    : 'this scenario doesn’t build on it';
  return `<p class="you-lot"><b>Your lot</b> · zoned ${zone} · ${now}; ${what}.</p>`;
}

function renderYou(place) {
  const box = document.getElementById('you');
  const near = walksheds(place.coords);
  const sc = DATA.scenarios.find(x => x.id === scenario);
  box.hidden = false;
  document.getElementById('you-addr').textContent = place.label;

  if (!near.length) {
    const nearest = DATA.stations
      .map(s => ({ s, d: metresBetween(place.coords, [s.lon, s.lat]) }))
      .sort((a, b) => a.d - b.d)[0];
    document.getElementById('you-sub').textContent = 'Outside every IBX walkshed';
    document.getElementById('you-body').innerHTML =
      `<p class="you-none">No proposed station sits within a half-mile walk. The closest is
       <strong>${nearest.s.name}</strong>, about ${(nearest.d / 1609).toFixed(1)} miles away
       — <span class="link" data-id="${nearest.s.id}" style="color:#9B8CF5;cursor:pointer">open it</span>.</p>`;
    document.querySelector('#you-body .link').onclick = e => selectStation(e.target.dataset.id, true);
    return;
  }

  const total = near.reduce((n, x) => n + x.s.scenarios[scenario], 0);
  document.getElementById('you-sub').textContent =
    near.length === 1 ? 'Inside 1 station walkshed' : `Inside ${near.length} overlapping walksheds`;
  document.getElementById('you-body').innerHTML =
    near.map(({ s, d }) => {
      const u = s.scenarios[scenario];
      const mins = Math.round(d / 80);
      return `<div class="walk-item" data-id="${s.id}">
        <span class="wi-rank" style="background:${TYPO_COLOR[s.typology]}">${mins}m</span>
        <span>
          <span class="wi-name">${s.name}</span>
          <span class="wi-meta">${(d / 1609).toFixed(2)} mi walk · ${s.typology}</span>
        </span>
        <span class="wi-num"><b>+${fmt(u)}</b><span>new homes</span></span>
      </div>`;
    }).join('') +
    `<p class="you-none">Under <strong>Scenario ${sc.n}</strong>, the station areas you sit in are
     allocated <strong>${fmt(total)}</strong> of the corridor's ${fmt(sc.units)} new homes.</p>` +
    lotLine(lotAt(place.coords));

  document.querySelectorAll('#you-body .walk-item').forEach(el =>
    (el.onclick = () => selectStation(el.dataset.id, true)));
}

function clearYou() {
  lastPlace = null;
  setYouSheds([]);
  document.getElementById('you').hidden = true;
  document.getElementById('addr').value = '';
  document.getElementById('addr-clear').hidden = true;
  map.getSource('you').setData({ type: 'FeatureCollection', features: [] });
}

/* ── map controls ─────────────────────────────────────── */
function fitRoute(animate = true) {
  const lons = DATA.route.map(p => p[0]), lats = DATA.route.map(p => p[1]);
  const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
  const wide = w > 900;
  // on phones the rail is a bottom sheet, so keep the route in the strip above it
  const sheet = wide ? 0 : document.getElementById('rail').offsetHeight;
  const pad = wide ? {
    top: Math.min(70, h * 0.12), bottom: Math.min(70, h * 0.12),
    left: Math.min(400, w * 0.3),
    right: Math.min(document.getElementById('detail').hidden ? 90 : 370, w * 0.28)
  } : { top: 120, bottom: sheet + 50, left: 24, right: 24 };
  // fit flat first — fitBounds on a pitched camera zooms far out to cover the frustum
  const cam = map.cameraForBounds(bounds, { padding: pad, bearing: -14 });
  if (!cam) return;
  map.easeTo({
    center: cam.center, zoom: cam.zoom - 0.12, bearing: -14, pitch: 52,
    duration: animate ? 1400 : 0
  });
}

function buildControls() {
  const tilt = document.getElementById('btn-tilt');
  tilt.classList.add('on');
  tilt.onclick = () => {
    const pitched = map.getPitch() > 10;
    map.easeTo({ pitch: pitched ? 0 : 58, duration: 700 });
    tilt.textContent = pitched ? '2D' : '3D';
    tilt.classList.toggle('on', !pitched);
  };
  document.getElementById('btn-fit').onclick = () => { stopTour(); fitRoute(); };
  document.getElementById('btn-tour').onclick = toggleTour;
}

function toggleTour() {
  const btn = document.getElementById('btn-tour');
  if (tourTimer) { stopTour(); return; }
  btn.classList.add('on'); btn.textContent = 'Stop';
  let i = 0;
  const step = () => {
    const s = DATA.stations[i % DATA.stations.length];
    selectStation(s.id, false);
    map.easeTo({
      center: [s.lon, s.lat], zoom: 14.6, pitch: 62,
      bearing: -14 + (i % 2 ? 22 : -8), duration: 2600, offset: [-30, 70]
    });
    i++;
    tourTimer = setTimeout(step, 3600);
  };
  step();
}
function stopTour() {
  if (!tourTimer) return;
  clearTimeout(tourTimer); tourTimer = null;
  const btn = document.getElementById('btn-tour');
  btn.classList.remove('on'); btn.textContent = 'Fly the line';
}
