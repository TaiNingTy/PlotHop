'use strict';

const data = window.TOD_DATA;
const region = window.TOD_REGION;
const parcelTiles = window.TOD_REGION_PARCELS || [];
const expansion = window.TOD_EXPANSION_SITES || [];
const accessAudit = window.TOD_ACCESS_AUDIT;
const linkAudit = window.TOD_ACCESS_LINKS;
const regionalGraph = walkingGraph(window.TOD_EXPANSION_WALK, accessAudit, linkAudit);
const routeRegion = regionalRouting(regionalGraph);
const walkCache = new Map();
const $ = selector => document.querySelector(selector);
const map = $('#map');
const searchCircle = $('#search-circle');
const METERS_PER_FOOT = 0.3048;
const FEET_PER_MILE = 5280;
const WALK_RADIUS = FEET_PER_MILE / 2 * METERS_PER_FOOT;
const hiddenCrossingLandings = new Set(window.TOD_HIDDEN_CROSSING_LANDINGS);
const number = (value, digits = 0) => value.toLocaleString('en-US', {
  minimumFractionDigits: digits, maximumFractionDigits: digits
});
const feet = (meters, digits = 1) => number(Number(meters) / METERS_PER_FOOT, digits) + ' ft';
const miles = meters => number(meters / METERS_PER_FOOT / FEET_PER_MILE, 2) + ' mi';
const lotArea = squareMeters => {
  const squareFeet = squareMeters / METERS_PER_FOOT ** 2;
  return squareFeet >= 43560 ? number(squareFeet / 43560, 2) + ' ac' : number(squareFeet) + ' sq ft';
};
const footprintSize = (length, width) => feet(length) + ' × ' + feet(width);
const search = { center: [...data.parcels[0].point], radius: Number($('#radius').value) * METERS_PER_FOOT };
const candidateButtons = [];
const parcelByPath = new WeakMap();
const comparisonFolios = { B: 'G6E6C04D2', C: 'GE9122C87' };
const countMarkers = [];
const recordsByFolio = new Map();
let view, selected, searchEntryParcel, savedView, drag;

function svg(name, attributes, parent, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  parent.append(node);
  return node;
}

const narrowMap = window.matchMedia('(max-width: 700px)');

function mapInsets() {
  return narrowMap.matches
    ? { right: 0, bottom: 0 }
    : { right: $('.map-side').offsetWidth + 28, bottom: 0 };
}

function framedWidth(horizontal, vertical) {
  const { right, bottom } = mapInsets();
  const width = Math.max(1, map.clientWidth - right);
  const height = Math.max(1, map.clientHeight - bottom);
  return Math.max(horizontal / width, vertical / height) * map.clientWidth;
}

function updateMapAnnotations(left, top, unitsPerPixel) {
  map.style.setProperty('--crossing-radius', 3 * unitsPerPixel + 'px');
  map.style.setProperty('--comparison-origin-radius', 3.5 * unitsPerPixel + 'px');
  const limit = unitsPerPixel * 105 / METERS_PER_FOOT;
  const distances = [10, 20, 50, 100, 200, 250, 500, 1000, 1320, 2640, 5280, 10560, 26400];
  const distance = distances.findLast(value => value <= limit) ?? distances[0];
  map.dataset.intersectionZoom = String(distance <= 500);
  const mileLabels = { 1320: '¼ mi', 2640: '½ mi' };
  $('#scale-label').textContent = mileLabels[distance] ??
    (distance >= FEET_PER_MILE ? number(distance / FEET_PER_MILE) + ' mi' : number(distance) + ' ft');
  $('#scale-line').style.width = distance * METERS_PER_FOOT / unitsPerPixel + 'px';

  const label = $('#walk-circle-label');
  if (label) {
    label.setAttribute('font-size', Math.min(13 * unitsPerPixel, WALK_RADIUS / 9));
    label.setAttribute('dy', -5 * unitsPerPixel);
  }
}

function setView(x, y, width) {
  width = Math.min(24000, Math.max(45, width));
  const height = width * map.clientHeight / Math.max(1, map.clientWidth);
  view = { x, y, width };
  const unitsPerPixel = width / Math.max(1, map.clientWidth);
  const { right: insetRight, bottom: insetBottom } = mapInsets();
  const left = x - width / 2 + insetRight * unitsPerPixel / 2;
  const top = y - height / 2 + insetBottom * unitsPerPixel / 2;
  map.setAttribute('viewBox', [left, top, width, height].join(' '));
  updateMapAnnotations(left, top, unitsPerPixel);
  const layer = $('#regional-parcels');
  const mapLeft = left, mapTop = top;
  const visible = !selected && width - insetRight * unitsPerPixel < 4200 ? parcelTiles.filter(({ bounds: [left, top, right, bottom] }) =>
    right >= mapLeft && left <= mapLeft + width &&
    bottom >= mapTop && top <= mapTop + height) : [];
  const key = visible.map(tile => tile.id).join('|');
  if (key !== layer.dataset.tiles) {
    layer.replaceChildren();
    for (const tile of visible) svg('path', { d: tile.path }, layer);
    layer.dataset.tiles = key;
  }
}

function intersectsCircle(parcel) {
  const [x, y] = search.center;
  if (parcel.bounds) {
    const [left, top, right, bottom] = parcel.bounds;
    if (x + search.radius < left || x - search.radius > right ||
        y + search.radius < top || y - search.radius > bottom) return false;
  }
  let inside = false;
  for (const ring of parcel.rings) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
      if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= search.radius) return true;
      if ((ay > y) !== (by > y) && x < ax + (y - ay) * dx / dy) inside = !inside;
    }
  }
  return inside;
}

const primaryMetrics = new Set([
  'Candidate and comparison parcels', 'Modeled block connectivity', 'Modeled footprint fit'
]);

function metrics(rows, target = $('#metrics')) {
  target.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const title = document.createElement('dt');
    const result = document.createElement('dd');
    title.textContent = label;
    result.textContent = value;
    if (value.endsWith('Needs verification')) result.className = 'pending';
    if (target.id === 'metrics' && primaryMetrics.has(label)) row.classList.add('primary-metric');
    row.append(title, result);
    return row;
  }));
}

function drawSearch() {
  const [x, y] = search.center;
  for (const circle of [searchCircle, $('#clip-circle')]) {
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', search.radius);
  }
  $('#circle-handle').setAttribute('d', 'M' + (x - 14) + ',' + y + 'h28M' + x + ',' + (y - 14) + 'v28');
  const radiusInput = $('#radius');
  const progress = (Number(radiusInput.value) - Number(radiusInput.min)) /
    (Number(radiusInput.max) - Number(radiusInput.min));
  radiusInput.style.setProperty('--radius-progress', (progress * 100) + '%');
  $('#radius-value').textContent = number(search.radius / METERS_PER_FOOT) + ' ft';
  let count = 0;
  for (const candidate of candidateButtons) {
    const { parcel } = candidate;
    const visible = intersectsCircle(parcel);
    if (visible) {
      count++;
      if (!candidate.path) candidate.path = candidatePath(parcel);
      candidate.path.style.display = '';
    } else if (candidate.path) {
      if (parcel.fit) {
        candidate.path.remove();
        candidate.path = null;
      } else {
        candidate.path.style.display = 'none';
      }
    }
  }
  const sites = countMarkers.filter(({ record, marker }) => {
    const inside = Math.hypot(record.point[0] - x, record.point[1] - y) <= search.radius;
    marker.style.display = inside ? '' : 'none';
    return inside;
  });
  const historical = sites.reduce((sum, { record }) => sum + record.count, 0);
  const landResidents = window.TOD_SEARCH_RESIDENTS;
  const counts = estimateCircle(window.TOD_DEMOGRAPHY, search.center, search.radius, landResidents?.local ?? null)
    ?? (region ? estimateCircle(region, search.center, search.radius, landResidents?.regional ?? null) : null);
  const format = value => value == null ? 'Needs verification' : 'Est. ' + number(value);
  const summary = [
    ['Candidate and comparison parcels', number(count)],
    ['Estimated residents', format(counts?.residents)],
    ['Estimated jobs', format(counts?.jobs)],
  ];
  const review = [
    ['Peak transit boardings and alightings', 'Needs verification'],
    ['Recent peak pedestrian crossings', 'Needs verification'],
    ['2016 PM peak crossings', sites.length ? number(historical) + ' crossings / ' + sites.length + (sites.length === 1 ? ' site' : ' sites') : 'Needs verification'],
  ];
  for (const [target, rows] of [[$('#metrics'), summary], [$('#search-review-metrics'), review]]) {
    const displayedRows = [...target.children];
    if (rows.length !== displayedRows.length || rows.some(([label, value], index) =>
      label !== displayedRows[index].firstElementChild.textContent ||
      value !== displayedRows[index].lastElementChild.textContent)) metrics(rows, target);
  }
}

function enterParcel(parcel) {
  if (selected || !intersectsCircle(parcel)) return;
  savedView = { ...view };
  searchEntryParcel = selected = parcel;
  $('#radius-control').hidden = true;
  $('#back').hidden = false;
  $('#parcel-tools').hidden = false;
  $('#search-layer').style.display = 'none';
  $('#search-layer').setAttribute('aria-hidden', 'true');
  const records = recordsByFolio.get(parcel.folio) ?? [];
  const selector = $('#folio-record');
  selector.replaceChildren(...records.map(record => new Option('#' + record.id.slice(1), record.id)));
  selector.value = parcel.id;
  $('#folio-record-tools').hidden = records.length < 2;
  $('#folio-compare').setAttribute('aria-pressed', 'false');
  $('#folio-comparison').hidden = true;
  $('#metrics').hidden = false;
  $('#fit-scenario').value = 'base';
  $('#fit-inset').value = '0.5';
  $('#show-pending-blocks').checked = false;
  showParcelView('walk');
  $('#back').focus({ preventScroll: true });
}

function showParcelView(kind) {
  $('#mode').textContent = selected.address;
  const fit = kind === 'fit';
  $('#fit-view').setAttribute('aria-pressed', fit);
  $('#walk-view').setAttribute('aria-pressed', !fit);
  $('#fit-controls').hidden = !fit;
  $('#fit-method').hidden = !fit;
  $('#fit-review').hidden = !fit;
  $('#walk-method').hidden = fit;
  $('#walk-review').hidden = fit;
  $('#walk-pilot-method').hidden = true;
  $('#map-key').hidden = !fit;
  $('#map-key').dataset.mode = kind;
  $('#walk-legend').hidden = fit;
  $('#search-review').hidden = true;
  if (fit) {
    const [left, top, right, bottom] = selected.bounds || [0, 0, 0, 0];
    const center = selected.fit ? [(left + right) / 2, (top + bottom) / 2] :
      window.TOD_PARCEL_FIT.sites[selected.id][$('#fit-inset').value].center;
    setView(...center, framedWidth(Math.max(95, right - left + 30), bottom - top + 30));
    renderFit();
  } else {
    renderWalking();
  }
}

const regionalFitLengths = { base: '23.73', short: '28.50', growth: '34.85' };

function regionalFitSummary(site, key, retain) {
  const footprint = (retain ? site.retained : site.gross)[key];
  const area = retain ? site.remaining : site.area;
  const length = regionalFitLengths[key];
  const fitResult = footprint ? 'Fit found in sampled layouts' :
    area + 0.5 < Number(length) * 15 ? 'Insufficient area' : 'No fit found · Needs verification';
  return [
    ['Test footprint', footprintSize(length, 15)],
    ['Available net area', lotArea(area)],
    ['Modeled footprint fit', fitResult],
  ];
}

const comparisonColors = ['#78eddf', '#ff9cce', '#a9cbff', '#ffb781', '#d5b3ff', '#c9e88c'];

function walkOrigin(parcel) {
  return (!parcel.landClipped && accessAudit?.sites[parcel.id]?.point) || parcel.walkPoint || parcel.point;
}

function renderFolioComparison() {
  const panel = $('#folio-comparison');
  const overlay = $('#folio-map-comparison');
  overlay.replaceChildren();
  const compare = $('#folio-compare').getAttribute('aria-pressed') === 'true';
  panel.hidden = !compare;
  $('#metrics').hidden = compare;
  map.classList.toggle('comparing-folio', compare);
  if (!compare) return;

  const records = recordsByFolio.get(selected.folio);
  const fit = $('#fit-view').getAttribute('aria-pressed') === 'true';
  const columns = records.map(record => fit
    ? regionalFitSummary(record.fit[$('#fit-inset').value], $('#fit-scenario').value, $('#retain-buildings').checked)
    : regionalWalkSummary(regionalWalk(record).estimates));
  const table = document.createElement('table');
  table.setAttribute('aria-label', fit ? 'Station Fit comparison' : 'Walk Coverage comparison');
  const header = table.createTHead().insertRow();
  header.append(document.createElement('td'));
  for (const [index, record] of records.entries()) {
    const color = comparisonColors[index % comparisonColors.length];
    const id = '#' + record.id.slice(1);
    svg('path', { d: record.path, stroke: color,
      class: 'comparison-outline' + (index % 2 ? ' dashed' : ''),
      role: 'img', 'aria-label': id + ' parcel boundary' }, overlay);
    const cell = document.createElement('th');
    cell.scope = 'col';
    const swatch = document.createElement('span');
    swatch.className = 'comparison-swatch' + (index % 2 ? ' dashed' : '');
    swatch.style.color = color;
    swatch.setAttribute('aria-hidden', 'true');
    cell.append(swatch, id);
    header.append(cell);
  }
  if (!fit) {
    for (const [index, record] of records.entries()) {
      const [cx, cy] = walkOrigin(record);
      const color = comparisonColors[index % comparisonColors.length];
      svg('circle', { cx, cy, fill: color, class: 'comparison-origin',
        role: 'img', 'aria-label': '#' + record.id.slice(1) + ' modeled walk origin' }, overlay);
    }
  }
  const body = table.createTBody();
  for (const [index, [label]] of columns[0].entries()) {
    const row = body.insertRow();
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    row.append(heading);
    for (const column of columns) row.insertCell().textContent = column[index][1];
  }
  panel.replaceChildren(table);
}

function renderRegionalFit() {
  const key = $('#fit-scenario').value;
  const site = selected.fit[$('#fit-inset').value];
  const retain = $('#retain-buildings').checked;
  const footprint = (retain ? site.retained : site.gross)[key];
  $('#short-reference').hidden = key !== 'short';
  const layer = $('#walk-layer');
  layer.replaceChildren();
  svg('path', { d: selected.path, class: 'fit-parcel' }, layer);
  svg('path', { d: site.boundary, class: 'fit-net' }, layer);
  if (retain) svg('path', { d: selected.building, class: 'fit-building' }, layer);
  if (footprint) svg('path', { d: footprint, class: 'fit-footprint' }, layer);
  $('#map-key').textContent = retain ? 'Gray: existing buildings · Purple: modeled footprint' : 'Purple: modeled footprint, ignoring existing buildings';
  metrics(regionalFitSummary(site, key, retain));
  renderFolioComparison();
  const rows = [['Lot area after test inset', lotArea(site.area)]];
  if (retain) rows.push(['Building area within inset', lotArea(site.occupied)]);
  rows.push(['Passenger entrance', 'Needs verification'], ['Guideway connection', 'Needs verification'], ['Full envelope and clearances', 'Needs verification'],
    ['Validated fit and expansion score', 'Needs verification'], ['Observed peak counts', 'Needs verification']);
  metrics(rows, $('#fit-review-metrics'));
}

function renderFit() {
  if (selected.fit) {
    renderRegionalFit();
    return;
  }
  const model = window.TOD_PARCEL_FIT;
  const site = model.sites[selected.id][$('#fit-inset').value];
  const variant = $('#fit-scenario').value;
  const scenario = site.scenarios[variant];
  $('#short-reference').hidden = variant !== 'short';
  const keepBuildings = $('#retain-buildings').checked;
  const inset = $('#fit-inset').value;
  const building = window.TOD_BUILDING_RETENTION[selected.id][inset];
  const result = building.scenarios[variant];
  const excluded = result.startsWith('excluded_by_');
  const signed = value => (value >= 0 ? '+' : '−') + feet(Math.abs(value));
  const rows = [
    ['Assumed peak load', scenario.events + ' vehicle events/hr'],
    ['Boarding and alighting berths', number(scenario.berths)],
    ['Lot area after test inset', lotArea(site.area)],
  ];
  const layer = $('#walk-layer');
  layer.replaceChildren();
  svg('path', { d: selected.path, class: 'fit-parcel' }, layer);
  let fitResult;
  if (keepBuildings) {
    const bracket = building.lengthBracket;
    rows.push(['Building area within inset', lotArea(building.overlap)]);
    if (bracket) rows.push(['Clear length at 49.2 ft width', bracket.map(value => number(value / METERS_PER_FOOT, 1)).join('–') + ' ft']);
    fitResult = excluded ? 'Does not fit' : result === 'sampled_fit' ? 'Fit found in sampled layouts' : 'Needs verification';
    svg('path', { d: building.free, class: 'fit-free' }, layer);
    svg('path', { d: building.building, class: 'fit-building' }, layer);
    $('#map-key').textContent = 'Gray: retained buildings · Purple: remaining land';
  } else {
    rows.push(['Longest modeled fit', feet(site.maxLength)],
      ['Modeled length margin', signed(scenario.margin)]);
    fitResult = scenario.fits ? 'Fit found' : 'No fit in tested layouts';
    if (selected.id === 'C') rows.push(['Maximum depth for turn at station end', feet(scenario.turnDepth)]);
    svg('path', { d: scenario.path, class: scenario.fits ? 'fit-footprint' : 'fit-footprint over' }, layer);
    $('#map-key').textContent = scenario.fits
      ? 'Purple: test footprint, ignoring existing buildings'
      : 'Orange: footprint extends beyond modeled clear area';
  }
  svg('path', { d: site.boundary, class: 'fit-net' }, layer);
  if (selected.id === 'C') rows.push(['Off-site guideway space', 'Needs verification']);
  rows.push(['Full station envelope', 'Needs verification'], ['Construction clearance', 'Needs verification'], ['Guideway connection', 'Needs verification'],
    ['Validated fit and expansion score', 'Needs verification'], ['Modeled walk access score', window.TOD_WALKING[selected.id].score.toFixed(1) + ' pts']);
  metrics([
    ['Test footprint', footprintSize(scenario.length, model.width)],
    ['Available net area', lotArea(keepBuildings ? building.remaining : site.area)],
    ['Modeled footprint fit', fitResult],
  ]);
  metrics(rows, $('#fit-review-metrics'));
}

const pendingReasonLabels = {
  distance: 'Beyond 114.8 ft', road: 'Crosses a road', water: 'Crosses water'
};

function renderPendingBlocks(blocks, coverage) {
  $('#walk-legend-pending').hidden = !blocks?.length;
  if (!blocks?.length) return;
  const review = window.TOD_BLOCK_DETOUR_AUDIT?.[selected.id];
  const group = svg('g', { id: 'pending-walk-blocks' }, coverage);
  group.style.display = $('#show-pending-blocks').checked ? '' : 'none';
  for (const block of blocks) {
    const reason = block.reasons.map(key => pendingReasonLabels[key]).join(', ');
    const outline = svg('path', { d: block.path, class: 'pending-walk-block', tabindex: 0,
      role: 'button', 'aria-label': 'Census block ' + block.geoid + ' · ' + reason }, group);
    const open = () => {
      $('#pending-block-id').textContent = 'Census GEOID ' + block.geoid;
      $('#pending-block-reason').textContent = reason + ' · Needs verification';
      $('#pending-block-distance').textContent = Number.isFinite(block.distance)
        ? 'Distance to nearest mapped path: ' + feet(block.distance, 2) : '';
      const note = $('#pending-block-review');
      const distanceReview = window.TOD_BLOCK_DISTANCE_AUDIT?.[selected.id];
      note.textContent = review?.[block.geoid] ?? distanceReview?.[block.geoid] ?? '';
      note.hidden = !note.textContent;
      $('#pending-block-detail').showModal();
    };
    outline.addEventListener('click', open);
    outline.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }
}

function regionalWalk(parcel) {
  if (!walkCache.has(parcel.id)) {
    const audit = accessAudit?.sites[parcel.id];
    const point = walkOrigin(parcel);
    // A shoreline cut can invalidate a parcel's previously reviewed access.
    const seed = parcel.landClipped ? -1 : audit ? audit.seed ?? -1 : undefined;
    const route = routeRegion(point, seed, true, WALK_RADIUS);
    const estimates = regionalCoverage(window.TOD_REGIONAL_COVERAGE, regionalGraph, point, route, WALK_RADIUS);
    if (route) delete route.traversal;
    walkCache.set(parcel.id, { route, estimates });
  }
  return walkCache.get(parcel.id);
}

function regionalWalkSummary(coverageResult) {
  return [
    ['Modeled reachable residents', coverageResult?.residentsInCircle > 0
      ? 'Est. ' + coverageResult.residents.toLocaleString('en-US') : 'Needs verification'],
    ['Modeled block connectivity', coverageResult?.total
      ? coverageResult.reached + ' / ' + coverageResult.total + ' · ' + coverageResult.rate.toFixed(1) + '%' : 'Needs verification'],
    ['Blocks with unverified access', coverageResult ? number(coverageResult.pendingBlocks) : 'Needs verification'],
  ];
}

function renderWalking() {
  const regional = Boolean(selected.fit);
  const audit = selected.landClipped ? null : accessAudit?.sites[selected.id];
  const point = walkOrigin(selected);
  let coverageResult;
  let model = window.TOD_WALKING[selected.id];
  if (regional) {
    const cached = regionalWalk(selected);
    model = cached.route;
    coverageResult = cached.estimates;
    $('#walk-pilot-method').hidden = !coverageResult;
    const labels = {
      water: 'Direct link crosses water · Needs verification',
      road: 'Direct link crosses a road · Needs verification',
      mapped: 'Potential unmapped connection · Needs verification',
      entrance: 'Entrance and pedestrian path · Needs verification'
    };
    const rows = [['Reference radius', '½ mi']];
    if (selected.landClipped) rows.push(['Shoreline-adjusted pedestrian access', 'Needs verification']);
    if (audit) rows.push(['Pedestrian access review', audit.status === 'recovered'
      ? 'Supplemental link mapped · ' + feet(audit.distance) : labels[audit.status]]);
    if (audit?.status === 'recovered' && model?.walk) rows.push(['Supplemental link connectivity', model.usesOriginal ? 'Connected to original network' : 'Supplemental links only']);
    const link = selected.landClipped ? null : linkAudit?.sites[selected.id];
    const linkLabels = { linked: 'Connection reviewed', sidewalk: 'Sidewalk connection · Needs verification',
      crossing: 'Crossing connection · Needs verification', bridge: 'Bridge access · Needs verification' };
    if (link) rows.push(['Network gap review', linkLabels[link]]);
    const detourReview = selected.landClipped ? null : window.TOD_BLOCK_DETOUR_AUDIT?.[selected.id];
    if (detourReview) rows.push(['Road-crossing detour review', '0 / ' + Object.keys(detourReview).length + ' connected']);
    const distanceReview = selected.landClipped ? null : window.TOD_BLOCK_DISTANCE_AUDIT?.[selected.id];
    if (distanceReview) rows.push(['Connection distance review', '0 / ' + Object.keys(distanceReview).length + ' connected']);
    const crossingEvidence = selected.landClipped ? null : window.TOD_CROSSING_AUDIT?.[selected.id];
    if (crossingEvidence === 'imagery') rows.push(['Crossing evidence', 'Imagery reviewed · Connection unverified']);
    if (crossingEvidence === 'historic') rows.push(['Crossing evidence', '2017 record · Needs verification']);
    metrics(regionalWalkSummary(coverageResult));
    renderFolioComparison();
    metrics([...rows,
      ['Modeled reachable paths', model?.walk ? miles(model.length) : 'Needs verification'],
      ['Mapped crossing points in circle', model?.points?.length || model?.covered ? number(model.points.length) : 'Needs verification'],
      ['OSM data coverage', model?.covered ? 'Covers reference circle' : 'Needs verification'],
      ...Object.entries(coverageResult?.pendingReasons ?? {}).map(([reason, count]) =>
        [pendingReasonLabels[reason] + ' · Needs verification', number(count)]),
      ['Passenger entrance', 'Needs verification'], ['Validated walk access score', 'Needs verification'], ['Observed peak counts', 'Needs verification'],
    ], $('#walk-review-metrics'));
  } else {
    metrics([
      ['Modeled reachable residents', 'Est. ' + model.residents.toLocaleString('en-US')],
      ['Modeled block connectivity', model.reached + ' / ' + model.total + ' · ' + model.rate.toFixed(1) + '%'],
      ['Blocks with unverified access', 'Needs verification'],
    ]);
    metrics([
      ['Reference radius', '½ mi'],
      ['Modeled walk access score', model.score.toFixed(1) + ' pts'],
      ['Validated walk access score', 'Needs verification'], ['Validated block connectivity', 'Needs verification'],
    ], $('#walk-review-metrics'));
  }
  const layer = $('#walk-layer');
  layer.replaceChildren();
  const [x, y] = point;
  const radius = WALK_RADIUS;
  const shade = `M-100000,-100000H100000V100000H-100000Z M${x-radius},${y}a${radius},${radius} 0 1 0 ${2*radius},0a${radius},${radius} 0 1 0 ${-2*radius},0Z`;
  svg('path', { d: shade, class: 'walk-shade', 'aria-hidden': 'true' }, layer);
  const crossingPoints = (model?.curbPoints ?? (regional ? [] : routeRegion(point, -1, false, radius)?.curbPoints ?? []))
    .filter(([x, y]) => !hiddenCrossingLandings.has(x.toFixed(3) + ',' + y.toFixed(3)));
  $('#walk-legend-crossing').hidden = !crossingPoints.length;
  const blocks = coverageResult?.blocks ?? model?.blocks;
  $('#walk-legend-blocks').hidden = !blocks;
  const clip = svg('clipPath', { id: 'walk-clip' }, layer);
  svg('circle', { cx: x, cy: y, r: radius }, clip);
  const coverage = svg('g', { 'clip-path': 'url(#walk-clip)' }, layer);
  if (blocks) svg('path', { d: blocks, class: 'walk-blocks' }, coverage);
  renderPendingBlocks(coverageResult?.pendingDetails, coverage);
  if (model?.walk) svg('path', { d: model.walk, class: 'walk-network' }, coverage);
  if (audit?.status === 'recovered' && model?.start && model.offset > 0.1) {
    svg('path', { d: 'M' + point.join(',') + 'L' + model.start.join(','), class: 'walk-proxy' }, coverage);
  }
  const crossingLayer = svg('g', { id: 'walk-crossings', 'aria-hidden': 'true' }, coverage);
  crossingLayer.style.display = $('#show-walk-crossings').checked ? '' : 'none';
  for (const [cx, cy] of crossingPoints) {
    svg('circle', { cx, cy, class: 'mapped-crossing' }, crossingLayer);
  }
  svg('circle', { cx: x, cy: y, r: radius, class: 'walk-reference',
    role: 'img', 'aria-label': 'Fixed 15-minute walk reference, half-mile radius' }, layer);
  const labelArc = `M${x - radius},${y} A${radius},${radius} 0 0 1 ${x + radius},${y}`;
  svg('path', { id: 'walk-label-arc', d: labelArc, fill: 'none', 'aria-hidden': 'true' }, layer);
  const label = svg('text', { id: 'walk-circle-label', 'aria-hidden': 'true' }, layer);
  svg('textPath', { href: '#walk-label-arc', startOffset: '50%', 'text-anchor': 'middle' },
    label, '15-minute walk reference · ½ mi');
  svg('path', { d: selected.path, class: 'candidate' }, layer);
  svg('path', { d: `M${x},${y - 15}l15,15l-15,15l-15,-15Z`, class: 'walk-origin',
    role: 'img', 'aria-label': 'Modeled walk origin. Entrance needs verification.' }, layer);
  setView(x, y, framedWidth(radius * 2.18, radius * 2.25));
}

function returnToSearch() {
  const path = candidateButtons.find(candidate => candidate.parcel === searchEntryParcel)?.path;
  selected = searchEntryParcel = null;
  $('#walk-layer').replaceChildren();
  $('#folio-map-comparison').replaceChildren();
  map.classList.remove('comparing-folio');
  $('#back').hidden = true;
  $('#radius-control').hidden = false;
  $('#search-layer').style.display = '';
  $('#search-layer').removeAttribute('aria-hidden');
  $('#parcel-tools').hidden = true;
  $('#folio-comparison').hidden = true;
  $('#metrics').hidden = false;
  $('#fit-method').hidden = true;
  $('#fit-review').hidden = true;
  $('#search-review').hidden = false;
  $('#mode').textContent = 'Search area';
  $('#map-key').textContent = 'Candidate parcels';
  $('#map-key').dataset.mode = 'search';
  $('#map-key').hidden = false;
  $('#walk-legend').hidden = true;
  $('#walk-method').hidden = true;
  $('#walk-review').hidden = true;
  $('#walk-pilot-method').hidden = true;
  setView(savedView.x, savedView.y, savedView.width);
  drawSearch();
  path?.focus({ preventScroll: true });
}

for (const [id, path] of Object.entries({
  water: region?.water ?? data.water, 'local-roads': region?.roads.local ?? data.roads.local,
  'major-roads': region?.roads.major ?? data.roads.major, 'parcel-context': data.parcelContext
})) $('#' + id).setAttribute('d', path);

const beach = region?.beachCenter;
const downtown = expansion.find(parcel => parcel.city === '01' &&
  Math.hypot(parcel.point[0] - 3400, parcel.point[1] - 2800) < 250)?.point || data.parcels[0].point;
if (!beach) $('#jump-beach').hidden = true;
function chooseParcel(parcels) {
  const dialog = $('#parcel-picker');
  const choices = parcels.map(parcel => {
    const button = document.createElement('button');
    button.type = 'button';
    const folio = parcel.folio ?? comparisonFolios[parcel.id];
    const object = parcel.fit ? '#' + parcel.id.slice(1) : 'Unavailable · ' + parcel.id + ' ' + parcel.address;
    button.textContent = 'Group ' + folio + ' · Record ' + object;
    button.onclick = () => {
      dialog.close();
      enterParcel(parcel);
    };
    return button;
  });
  $('#parcel-choices').replaceChildren(...choices);
  dialog.showModal();
}

function candidatePath(parcel) {
  const label = parcel.fit ? parcel.address : parcel.id + ' · ' + parcel.address;
  const path = svg('path', { d: parcel.path, class: 'candidate', tabindex: 0, role: 'button',
    'aria-label': label }, $('#candidate-layer'));
  svg('title', {}, path, label);
  parcelByPath.set(path, parcel);
  path.addEventListener('click', event => {
    if (!event.detail) {
      enterParcel(parcel);
      return;
    }
    const hits = document.elementsFromPoint(event.clientX, event.clientY)
      .map(element => parcelByPath.get(element)).filter(Boolean);
    if (hits.length > 1) chooseParcel(hits);
    else enterParcel(parcel);
  });
  path.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      enterParcel(parcel);
    }
  });
  return path;
}
for (const parcel of [...data.parcels, ...expansion]) {
  candidateButtons.push({ parcel, path: null });
  if (!parcel.folio) continue;
  if (!recordsByFolio.has(parcel.folio)) recordsByFolio.set(parcel.folio, []);
  recordsByFolio.get(parcel.folio).push(parcel);
}

for (const record of window.TOD_PEAK) {
  const marker = svg('circle', {
    cx: record.point[0], cy: record.point[1], r: 20, class: 'count-point',
    tabindex: 0, role: 'button', 'aria-label': 'Historical count site: ' + record.name
  }, $('#count-points'));
  svg('title', {}, marker, record.name + ' · ' + record.count + ' pedestrian crossings');
  const open = () => {
    $('#count-name').textContent = record.name;
    $('#count-value').textContent = record.count + ' pedestrian crossings · ' + record.date + ' · ' + record.period;
    $('#count-coverage').textContent = record.coverage + ' · Miami local time';
    $('#count-source').hash = 'page=' + record.page;
    $('#count-detail').showModal();
  };
  marker.addEventListener('click', open);
  marker.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  countMarkers.push({ record, marker });
}

$('#radius').addEventListener('input', event => {
  search.radius = Number(event.target.value) * METERS_PER_FOOT;
  drawSearch();
});
$('#back').onclick = returnToSearch;
$('#folio-record').onchange = event => {
  const record = recordsByFolio.get(selected?.folio)?.find(parcel => parcel.id === event.target.value);
  if (!record || record === selected) return;
  const kind = $('#map-key').dataset.mode;
  selected = record;
  showParcelView(kind);
};
$('#folio-compare').onclick = event => {
  const button = event.currentTarget;
  button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') !== 'true');
  renderFolioComparison();
};
$('#fit-view').onclick = () => showParcelView('fit');
$('#walk-view').onclick = () => showParcelView('walk');
$('#show-pending-blocks').onchange = event => {
  const layer = $('#pending-walk-blocks');
  if (layer) layer.style.display = event.target.checked ? '' : 'none';
};
$('#show-walk-crossings').onchange = event => {
  const layer = $('#walk-crossings');
  if (layer) layer.style.display = event.target.checked ? '' : 'none';
};
$('#fit-scenario').onchange = renderFit;
$('#fit-inset').onchange = renderFit;
$('#retain-buildings').onchange = renderFit;
$('#help-button').onclick = () => $('#map-help').showModal();
$('#source-button').onclick = () => $('#sources').showModal();
$('#zoom-in').onclick = () => setView(view.x, view.y, view.width / 1.3);
$('#zoom-out').onclick = () => setView(view.x, view.y, view.width * 1.3);
map.addEventListener('wheel', event => {
  event.preventDefault();
  setView(view.x, view.y, view.width * (event.deltaY > 0 ? 1.12 : 1 / 1.12));
}, { passive: false });

map.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('[role="button"]')) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...view },
    center: [...search.center], movesCircle: event.target === searchCircle };
  map.setPointerCapture(event.pointerId);
  map.classList.add('dragging');
});
map.addEventListener('pointermove', event => {
  if (drag?.id !== event.pointerId) return;
  const scale = drag.view.width / map.clientWidth;
  const dx = (event.clientX - drag.x) * scale;
  const dy = (event.clientY - drag.y) * scale;
  if (drag.movesCircle) {
    clearCityHighlight();
    search.center = [drag.center[0] + dx, drag.center[1] + dy];
    drawSearch();
  } else {
    setView(drag.view.x - dx, drag.view.y - dy, drag.view.width);
  }
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  map.addEventListener(name, () => {
    drag = null;
    map.classList.remove('dragging');
  });
}
searchCircle.addEventListener('keydown', event => {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!direction) return;
  event.preventDefault();
  clearCityHighlight();
  search.center = search.center.map((value, i) => value + 80 * METERS_PER_FOOT * direction[i]);
  drawSearch();
});
window.addEventListener('resize', () => setView(view.x, view.y, view.width));

const middle = data.parcels[0].point.map((value, i) => (value + data.parcels[1].point[i]) / 2);
setView(...middle, framedWidth(3200, 2860));
drawSearch();

const locationControl = $('#location');
const locationToggle = $('#location-toggle');
const locationOptions = $('#location-options');

function setLocationOpen(open) {
  locationToggle.setAttribute('aria-expanded', String(open));
  locationOptions.inert = !open;
}

locationToggle.onclick = () => setLocationOpen(locationOptions.inert);
document.addEventListener('click', event => {
  if (!locationControl.contains(event.target)) setLocationOpen(false);
});
locationControl.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || locationOptions.inert) return;
  event.preventDefault();
  locationToggle.focus();
  setLocationOpen(false);
});

const mapLegends = $('#map-legends');
const detailLegendToggle = $('#detail-legend-toggle');
const summarySwitch = $('#summary-switch');
const legendSwitch = $('#legend-switch');

function setLegendOpen(open) {
  mapLegends.hidden = !open;
  $('#map-summary').hidden = narrowMap.matches && open;
  detailLegendToggle.setAttribute('aria-expanded', String(open));
  summarySwitch.setAttribute('aria-pressed', String(!open));
  legendSwitch.setAttribute('aria-pressed', String(open));
}

function syncLegendLayout() {
  const mobile = narrowMap.matches;
  detailLegendToggle.hidden = mobile;
  $('#mobile-map-switch').hidden = !mobile;
  setLegendOpen(!mapLegends.hidden);
}

detailLegendToggle.onclick = () => setLegendOpen(mapLegends.hidden);
summarySwitch.onclick = () => setLegendOpen(false);
legendSwitch.onclick = () => setLegendOpen(true);
$('.map-stage').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || mapLegends.hidden) return;
  const toggle = narrowMap.matches ? legendSwitch : detailLegendToggle;
  if (event.target !== toggle && !mapLegends.contains(event.target)) return;
  event.preventDefault();
  setLegendOpen(false);
  (narrowMap.matches ? summarySwitch : toggle).focus();
});
narrowMap.addEventListener('change', syncLegendLayout);
syncLegendLayout();

function clearCityHighlight() {
  locationOptions.querySelector('.city-jump.is-current')?.classList.remove('is-current');
}

for (const [id, center] of [['jump-miami', downtown], ['jump-beach', beach]]) {
  if (!center) continue;
  $('#' + id).onclick = event => {
    clearCityHighlight();
    event.currentTarget.classList.add('is-current');
    search.center = [...center];
    setView(...center, framedWidth(3200, 2860));
    drawSearch();
  };
}
