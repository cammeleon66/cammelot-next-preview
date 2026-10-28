import { project, fromScreen } from './iso.js';

// Hit-testing happens in projected (isometric) space, the same space `project()` and
// `fromScreen()` use. A building is the convex hull of its footprint at ground level and
// at roof height, so clicks on walls, roofs and gables all count and the ground behind
// the building does not. Pure functions: no DOM, no mutation, no snapshot access.
export const GABLE_RISE = 10; // houses draw a gable this far above their wall height

function hull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = list => {
    const out = [];
    for (const p of list) {
      while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build(pts.reverse())];
}

// Outline of a building in projected space, as [x, y] vertices.
export function buildingHull(b) {
  const { x, y, w, d, height: h = 0 } = b;
  const corners = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
  const pts = corners.flatMap(([cx, cy]) => [project(cx, cy, 0), project(cx, cy, h)]);
  if (b.kind === 'house') pts.push(project(x, y, h + GABLE_RISE));
  return hull(pts.map(p => [p.x, p.y]));
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    const cross = (point.x - xi) * (yj - yi) - (point.y - yi) * (xj - xi);
    if (cross === 0 && point.x >= Math.min(xi, xj) && point.x <= Math.max(xi, xj) &&
      point.y >= Math.min(yi, yj) && point.y <= Math.max(yi, yj)) return true; // on an edge
    if ((yi > point.y) !== (yj > point.y) && point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Front-most building under a projected-space point, or null. Overlapping silhouettes
// resolve to the building nearer the camera (larger front-corner depth), then list order.
export function hitTestBuildings(buildings, point) {
  let best = null, bestDepth = -Infinity;
  for (const b of buildings) {
    if (!pointInPolygon(point, buildingHull(b))) continue;
    const depth = b.x + b.w + b.y + b.d;
    if (depth >= bestDepth) { best = b; bestDepth = depth; }
  }
  return best;
}

// Canvas-pixel position (as used by camera/toScreen) -> building.
export function hitTestScreen(buildings, screenPoint, camera) {
  return hitTestBuildings(buildings, fromScreen(screenPoint, camera));
}
