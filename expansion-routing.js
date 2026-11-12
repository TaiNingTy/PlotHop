'use strict';

function walkingGraph(base, audit, links) {
  if (!base || !audit) return base;
  const nodes = base.nodes.concat(audit.nodes, links?.nodes || []);
  const edges = base.edges.concat(audit.edges, links?.edges || []);
  const cuts = new Map();
  const endpoint = ([a, b], fraction) => fraction <= 1e-9 ? a : fraction >= 1 - 1e-9 ? b : undefined;
  for (const junction of links?.junctions || []) {
    const atOriginal = endpoint(edges[junction.original], junction.originalFraction);
    const atSupplement = endpoint(edges[junction.supplemental], junction.supplementalFraction);
    if (atOriginal !== undefined && atSupplement !== undefined && atOriginal !== atSupplement) {
      throw new Error('Junction has two distinct endpoints');
    }
    const node = atOriginal ?? atSupplement ?? nodes.push(junction.point) - 1;
    for (const [id, fraction] of [[junction.original, junction.originalFraction],
      [junction.supplemental, junction.supplementalFraction]]) {
      if (endpoint(edges[id], fraction) !== undefined) continue;
      if (!cuts.has(id)) cuts.set(id, []);
      cuts.get(id).push([fraction, node]);
    }
  }
  const replacementEdges = new Map(), originalPieces = new Set();
  for (const [id, splits] of cuts) {
    const [a, b, cost, crossing] = edges[id];
    const points = [[0, a], ...splits.sort(([p], [q]) => p - q), [1, b]];
    const parts = [];
    for (let i = 1; i < points.length; i++) {
      const [start, from] = points[i - 1], [end, to] = points[i];
      if (end <= start || from === to) continue;
      const part = edges.push([from, to, (end - start) * cost, crossing]) - 1;
      parts.push(part);
      if (id < base.edges.length) originalPieces.add(part);
    }
    replacementEdges.set(id, parts);
  }
  return { ...base, nodes, edges, replacementEdges, originalPieces, baselineEdgeCount: base.edges.length };
}


function regionalRouting(snapshot) {
  if (!snapshot) return () => null;
  const { nodes, edges, crossings, windows, baselineEdgeCount = edges.length,
    replacementEdges = new Map(), originalPieces = new Set() } = snapshot;
  const tile = 200;
  const index = new Map();
  const links = nodes.map(() => []);
  edges.forEach(([a, b, time, crossing], id) => {
    if (replacementEdges.has(id)) return;
    links[a].push([b, time, id]);
    links[b].push([a, time, id]);
    if (crossing) return;
    const [ax, ay] = nodes[a], [bx, by] = nodes[b];
    for (let x = Math.floor(Math.min(ax, bx) / tile); x <= Math.floor(Math.max(ax, bx) / tile); x++) {
      for (let y = Math.floor(Math.min(ay, by) / tile); y <= Math.floor(Math.max(ay, by) / tile); y++) {
        const key = x + ',' + y;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(id);
      }
    }
  });

  // A curb marker needs a crossing endpoint connected to a mapped pedestrian edge.
  const crossingDegree = new Map();
  for (const [a, b, , crossing] of edges.slice(0, baselineEdgeCount)) {
    if (!crossing) continue;
    for (const node of [a, b]) crossingDegree.set(node, (crossingDegree.get(node) ?? 0) + 1);
  }
  const crossingEndpoints = [...crossingDegree]
    .filter(([node, degree]) => degree === 1 &&
      links[node].some(([, , id]) => !edges[id][3] &&
        (id < baselineEdgeCount || originalPieces.has(id))))
    .map(([node]) => nodes[node]);

  return ([x, y], preferredEdge, inspect = false, radius = 804.672) => {
    const budget = 900;
    const local = new Set();
    for (let i = Math.floor((x - 35) / tile); i <= Math.floor((x + 35) / tile); i++) {
      for (let j = Math.floor((y - 35) / tile); j <= Math.floor((y + 35) / tile); j++) {
        for (const id of index.get(i + ',' + j) || []) local.add(id);
      }
    }
    let seed, offset = 35, fraction;
    const choices = preferredEdge === undefined ? local :
      preferredEdge < 0 ? [] : replacementEdges.get(preferredEdge) ?? [preferredEdge];
    for (const id of choices) {
      const [a, b] = edges[id];
      const [ax, ay] = nodes[a], [bx, by] = nodes[b];
      const dx = bx - ax, dy = by - ay;
      const square = dx * dx + dy * dy;
      if (!square) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / square));
      const gap = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (gap <= offset) {
        seed = id;
        offset = gap;
        fraction = t;
      }
    }
    const inCircle = ([a, b]) => Math.hypot(a - x, b - y) <= radius;
    const points = crossings.filter(inCircle);
    const curbPoints = crossingEndpoints.filter(inCircle);
    // An axis-aligned partition can test whether the entire circle intersects a missing tile.
    const nearby = (windows || []).filter(([left, top, right, bottom]) =>
      left < x + radius && right > x - radius && top < y + radius && bottom > y - radius);
    const cuts = (axis, center) => [...new Set([center - radius, center + radius,
      ...nearby.flatMap(bounds => [bounds[axis], bounds[axis + 2]])
        .filter(value => Math.abs(value - center) < radius)])].sort((a, b) => a - b);
    const xs = cuts(0, x), ys = cuts(1, y);
    let covered = true;
    for (let i = 1; i < xs.length && covered; i++) {
      for (let j = 1; j < ys.length && covered; j++) {
        const nx = Math.max(xs[i - 1], Math.min(xs[i], x));
        const ny = Math.max(ys[j - 1], Math.min(ys[j], y));
        if (Math.hypot(nx - x, ny - y) >= radius) continue;
        const cx = (xs[i - 1] + xs[i]) / 2, cy = (ys[j - 1] + ys[j]) / 2;
        covered = nearby.some(([left, top, right, bottom]) =>
          left <= cx && cx <= right && top <= cy && cy <= bottom);
      }
    }
    // Clip modeled paths to the reference circle.
    function insideCircle(ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay;
      const squared = dx * dx + dy * dy;
      if (!squared) return null;
      const middle = ((x - ax) * dx + (y - ay) * dy) / squared;
      const perpendicular = (ax - x) * dy - (ay - y) * dx;
      const span = (radius * radius - perpendicular ** 2 / squared) / squared;
      if (span <= 0) return null;
      const start = Math.max(0, middle - Math.sqrt(span));
      const end = Math.min(1, middle + Math.sqrt(span));
      return end > start ? [start, end] : null;
    }
    const segment = (ax, ay, bx, by, start, end) => {
      const point = t => [ax + (bx - ax) * t, ay + (by - ay) * t].map(v => v.toFixed(1)).join(',');
      return 'M' + point(start) + 'L' + point(end);
    };
    if (seed === undefined) return { points, curbPoints, covered };

    const best = new Map(), queue = [], reached = new Set();
    function enqueue(node, time) {
      if (time > budget || time >= (best.get(node) ?? Infinity)) return;
      best.set(node, time);
      let i = queue.length;
      queue.push(null);
      while (i > 0) {
        const parent = Math.floor((i - 1) / 2);
        if (queue[parent][0] <= time) break;
        queue[i] = queue[parent];
        i = parent;
      }
      queue[i] = [time, node];
    }
    const [a, b, cost] = edges[seed];
    enqueue(a, offset / 1.2 + fraction * cost);
    enqueue(b, offset / 1.2 + (1 - fraction) * cost);
    while (queue.length) {
      const [time, node] = queue[0];
      const tail = queue.pop();
      if (queue.length) {
        let i = 0;
        while (i * 2 + 1 < queue.length) {
          let child = i * 2 + 1;
          if (child + 1 < queue.length && queue[child + 1][0] < queue[child][0]) child++;
          if (queue[child][0] >= tail[0]) break;
          queue[i] = queue[child];
          i = child;
        }
        queue[i] = tail;
      }
      if (time !== best.get(node)) continue;
      for (const [other, edgeCost, id] of links[node]) {
        reached.add(id);
        enqueue(other, time + edgeCost);
      }
    }
    reached.add(seed);
    let length = 0, usesOriginal = false;
    const path = [];
    for (const id of reached) {
      const [from, to, time] = edges[id];
      const [ax, ay] = nodes[from], [bx, by] = nodes[to];
      const interval = insideCircle(ax, ay, bx, by);
      if (!interval) continue;
      const left = Math.max(0, Math.min(1, (budget - (best.get(from) ?? Infinity)) / time));
      const right = Math.min(1, Math.max(0, 1 - (budget - (best.get(to) ?? Infinity)) / time));
      const sections = left >= right ? [[0, 1]] : [[0, left], [right, 1]];
      if (id === seed) {
        const delta = (budget - offset / 1.2) / time;
        sections.push([Math.max(left, fraction - delta), Math.min(right, fraction + delta)]);
      }
      for (const [lo, hi] of sections) {
        const start = Math.max(lo, interval[0]), end = Math.min(hi, interval[1]);
        if (end <= start) continue;
        usesOriginal ||= id < baselineEdgeCount || originalPieces.has(id);
        length += Math.hypot(bx - ax, by - ay) * (end - start);
        path.push(segment(ax, ay, bx, by, start, end));
      }
    }
    const [ax, ay] = nodes[a], [bx, by] = nodes[b];
    return { walk: path.join(''), length, offset, points, curbPoints, covered, usesOriginal,
      start: [ax + fraction * (bx - ax), ay + fraction * (by - ay)],
      ...(inspect ? { traversal: { seed, fraction, best: [...best] } } : {}) };
  };
}
