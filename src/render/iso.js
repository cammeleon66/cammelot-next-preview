// Logical pixels: 2:1, 32×16 tiles. Camera output is always snapped to pixels.
export function project(x, y, z = 0) {
  return { x: (x - y) * 16, y: (x + y) * 8 - z };
}
export function unproject(x, y, z = 0) {
  return { x: x / 32 + (y + z) / 16, y: (y + z) / 16 - x / 32 };
}
export function integerScale(value) {
  if (!Number.isFinite(value)) throw new RangeError('Scale must be finite');
  return Math.max(1, Math.min(3, Math.floor(value)));
}
export function createCamera(width, height, x = 0, y = 192, scale = 1) {
  return { width, height, x, y, scale: integerScale(scale) };
}
export function toScreen(point, camera) {
  return { x: Math.round((point.x - camera.x) * camera.scale + camera.width / 2),
    y: Math.round((point.y - camera.y) * camera.scale + camera.height / 2) };
}
export function fromScreen(point, camera) {
  return { x: (point.x - camera.width / 2) / camera.scale + camera.x,
    y: (point.y - camera.height / 2) / camera.scale + camera.y };
}
// Stable, non-mutating painter order. Height breaks ties, never overrides ground depth.
export function depthSort(items) {
  return items.map((item, index) => ({ item, index })).sort((a, b) =>
    (a.item.x + a.item.y) - (b.item.x + b.item.y) ||
    (a.item.z ?? 0) - (b.item.z ?? 0) || a.index - b.index).map(entry => entry.item);
}
