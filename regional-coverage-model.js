'use strict';

function regionalCoverage(data, graph, [x, y], model, radius) {
  if (!data || !model?.covered || !model.traversal) return null;
  const [left, top, right, bottom] = data.bounds;
  if (x - radius < left || x + radius > right || y - radius < top || y + radius > bottom) return null;

  const budget = 900;
  const speed = 1.2;
  const { seed, fraction: seedFraction, best } = model.traversal;
  const arrival = new Map(best);
  const radiusSquared = radius * radius;
  const inCircle = (px, py) => (px - x) ** 2 + (py - y) ** 2 <= radiusSquared;
  function classify([id, fraction, gap]) {
    if (id < 0) return 'pending';
    const [a, b, cost] = graph.edges[id];
    let time = Math.min((arrival.get(a) ?? Infinity) + fraction * cost,
      (arrival.get(b) ?? Infinity) + (1 - fraction) * cost);
    if (id === seed) time = Math.min(time, model.offset / speed + Math.abs(fraction - seedFraction) * cost);
    return time + gap / speed <= budget ? 'reachable' : 'outside';
  }

  const connected = [], pendingDetails = [];
  const pendingReasons = { distance: 0, road: 0, water: 0 };
  let total = 0, pendingBlocks = 0;
  for (const [geoid, px, py, path, attachment] of data.blocks) {
    if (!inCircle(px, py)) continue;
    total++;
    const state = classify(attachment);
    if (state === 'reachable') connected.push({ geoid, path });
    if (state === 'pending') {
      pendingBlocks++;
      const [code, distance] = attachment;
      const reasons = code === -1 ? ['distance'] :
        code === -4 ? ['road', 'water'] : [code === -3 ? 'water' : 'road'];
      for (const reason of reasons) pendingReasons[reason]++;
      pendingDetails.push({ geoid, path, reasons, distance });
    }
  }
  let residents = 0, pendingResidents = 0, residentsInCircle = 0;
  for (const group of data.groups) {
    const weight = group.count * circleWeight(group, x, y, radius);
    if (!weight) continue;
    residentsInCircle += weight;
    let samples = 0, reached = 0, pending = 0;
    for (const sample of group.samples) {
      if (!inCircle(sample[0], sample[1])) continue;
      samples++;
      const state = classify(sample.slice(2));
      if (state === 'reachable') reached++;
      if (state === 'pending') pending++;
    }
    if (!samples && inCircle(group.fallback[0], group.fallback[1])) {
      samples = 1;
      const state = classify(group.fallback.slice(2));
      reached = Number(state === 'reachable');
      pending = Number(state === 'pending');
    }
    if (!samples) {
      pendingResidents += weight;
      continue;
    }
    residents += weight * reached / samples;
    pendingResidents += weight * pending / samples;
  }
  return {
    residents: Math.round(residents), pendingResidents: Math.round(pendingResidents), residentsInCircle,
    reached: connected.length, total, pendingBlocks, pendingDetails, pendingReasons, rate: total ? 100 * connected.length / total : null,
    blocks: connected.map(block => block.path).join(''), geoids: connected.map(block => block.geoid)
  };
}
