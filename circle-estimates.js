'use strict';

// Signed area contributed by a ring edge to its intersection with a circle.
// Split the edge at circle crossings, using a triangle inside and a sector outside.
function edgeArea(ax, ay, bx, by, radius) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  if (!length) return 0;
  const along = ax * dx + ay * dy;
  const radiusSquared = radius * radius;
  const cross = ax * dy - ay * dx;
  const discriminant = length * radiusSquared - cross * cross;
  const cuts = [0];
  if (discriminant > 0) {
    const root = Math.sqrt(discriminant);
    for (const t of [(-along - root) / length, (-along + root) / length]) {
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.push(1);
  let area = 0;
  for (let i = 1; i < cuts.length; i++) {
    const t0 = cuts[i - 1];
    const t1 = cuts[i];
    const x0 = ax + t0 * dx, y0 = ay + t0 * dy;
    const x1 = ax + t1 * dx, y1 = ay + t1 * dy;
    const midpoint = (t0 + t1) / 2;
    const edgeCross = x0 * y1 - y0 * x1;
    const inside = (ax + midpoint * dx) ** 2 + (ay + midpoint * dy) ** 2 <= radiusSquared;
    area += inside ? edgeCross / 2 : radiusSquared * Math.atan2(edgeCross, x0 * x1 + y0 * y1) / 2;
  }
  return area;
}

function circleWeight(unit, x, y, radius) {
  const [west, top, east, bottom] = unit.bounds;
  const nearestX = Math.max(west, Math.min(east, x));
  const nearestY = Math.max(top, Math.min(bottom, y));
  if (Math.hypot(nearestX - x, nearestY - y) >= radius) return 0;
  if (Math.hypot(Math.max(x - west, east - x), Math.max(y - top, bottom - y)) <= radius) return 1;
  let area = 0;
  for (const ring of unit.rings) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      area += edgeArea(ax - x, ay - y, bx - x, by - y, radius);
    }
  }
  return Math.min(1, Math.max(0, area / unit.area));
}

function estimateCircle(layers, [x, y], radius, residentUnits = layers.residents) {
  const [west, top, east, bottom] = layers.bounds;
  if (x - radius < west || y - radius < top || x + radius > east || y + radius > bottom) return null;
  const count = units => units.reduce((total, unit) => total + unit.count * circleWeight(unit, x, y, radius), 0);
  return { residents: residentUnits ? count(residentUnits) : null, jobs: count(layers.jobs) };
}
