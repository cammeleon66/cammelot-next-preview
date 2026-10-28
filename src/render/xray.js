import { project, toScreen } from './iso.js';

// World-space routing is presentation metadata. Edge measurements always come
// from Snapshot.infrastructure; this table supplies no default values.
export const INFRASTRUCTURE_ROUTES = Object.freeze([
  Object.freeze({ id: 'gp-hospital-referral', label: 'GP HIS → Hospital EHR',
    from: Object.freeze({ x: 14, y: 6.5 }), to: Object.freeze({ x: 18.5, y: 6 }),
    fromLabel: 'GP HIS', toLabel: 'Hospital EHR', aliases: Object.freeze(['gp_to_hospital']) }),
  Object.freeze({ id: 'hospital-scheduler', label: 'Hospital EHR → Scheduler',
    from: Object.freeze({ x: 18.5, y: 6 }), to: Object.freeze({ x: 21, y: 9 }),
    fromLabel: 'Hospital EHR', toLabel: 'Scheduler' })
]);

const routeById = new Map(INFRASTRUCTURE_ROUTES.flatMap(route =>
  [[route.id, route], ...(route.aliases ?? []).map(id => [id, route])]));
const COMPLETENESS_BLOCKS = 4;
const LATENCY_TICK_MINUTES = 15;
const MAX_LATENCY_TICKS = 6;

function validEdge(edge) {
  return edge && typeof edge.id === 'string' && routeById.has(edge.id) &&
    [edge.completeness, edge.manualHandoffRate, edge.failureRate].every(value =>
      Number.isFinite(value) && value >= 0 && value <= 1) &&
    Number.isFinite(edge.latencyMinutes) && edge.latencyMinutes >= 0;
}

// The sole data source is the snapshot contract. Invalid/unknown records are
// omitted rather than replaced with presentation defaults.
export function mapInfrastructure(snapshot) {
  if (!Array.isArray(snapshot?.infrastructure)) return [];
  return snapshot.infrastructure.filter(validEdge).map(edge => {
    const route = routeById.get(edge.id);
    return Object.freeze({
      id: edge.id, label: route.label, fromLabel: route.fromLabel, toLabel: route.toLabel,
      completeness: edge.completeness, latencyMinutes: edge.latencyMinutes,
      manualHandoffRate: edge.manualHandoffRate, failureRate: edge.failureRate
    });
  });
}

// These are display-only buckets; the edge panel always presents the exact
// Snapshot values. No metric is defaulted or fed back into simulation state.
export function infrastructureVisuals(edge) {
  if (!validEdge(edge)) return null;
  return Object.freeze({
    completenessBlocks: Math.floor(edge.completeness * COMPLETENESS_BLOCKS),
    latencyTicks: Math.min(MAX_LATENCY_TICKS, Math.ceil(edge.latencyMinutes / LATENCY_TICK_MINUTES)),
    handoffMarks: Math.ceil(edge.manualHandoffRate * 4),
    failureMarks: Math.ceil(edge.failureRate * 4)
  });
}

export function shouldToggleXrayKey(event, doc = document) {
  if (event.defaultPrevented || event.repeat || !['x', 'X'].includes(event.key) ||
      event.altKey || event.ctrlKey || event.metaKey || doc.querySelector('dialog[open]')) return false;
  const target = event.target;
  if (!target || target.isContentEditable) return false;
  return !target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
}

const pixel = (context, colour, x, y, w = 1, h = 1) => {
  context.fillStyle = colour;
  context.fillRect(x, y, w, h);
};

function pointAt(point, camera) {
  return toScreen(project(point.x, point.y), camera);
}

function drawLine(context, from, to, colour, scale = 1) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(from.x + (to.x - from.x) * i / steps);
    const y = Math.round(from.y + (to.y - from.y) * i / steps);
    pixel(context, colour, x - scale, y - scale, scale * 2 + 1, scale * 2 + 1);
  }
}

function drawNode(context, point, camera, colours) {
  const { x, y } = pointAt(point, camera), left = x - 16, top = y - 10;
  pixel(context, colours.blue3, left, top, 33, 21);
  pixel(context, colours.gold, left, top, 33, 2);
  pixel(context, colours.gold, left, top + 19, 33, 2);
  pixel(context, colours.gold, left, top, 2, 21);
  pixel(context, colours.gold, left + 31, top, 2, 21);
  // Pixel server glyph: three bays, each with a visible status lamp.
  for (let row = 0; row < 3; row++) {
    pixel(context, colours.cyan, left + 5, top + 5 + row * 4, 17, 2);
    pixel(context, row === 0 ? colours.green : colours.gold, left + 25, top + 5 + row * 4, 2, 2);
  }
}

function drawClipboard(context, x, y, colour, background) {
  pixel(context, colour, x - 2, y - 3, 5, 6);
  pixel(context, colour, x - 1, y - 4, 3, 1);
  pixel(context, background, x - 1, y - 2, 3, 1);
  pixel(context, background, x - 1, y, 3, 1);
}

function drawFailure(context, x, y, colour, background) {
  // A bordered exclamation tile remains distinct from the edge's colour.
  pixel(context, colour, x - 3, y - 4, 7, 1);
  pixel(context, colour, x - 3, y + 3, 7, 1);
  pixel(context, colour, x - 3, y - 3, 1, 6);
  pixel(context, colour, x + 3, y - 3, 1, 6);
  pixel(context, background, x, y - 2, 1, 3);
  pixel(context, background, x, y + 2, 1, 1);
}

function drawCheck(context, x, y, colour, background) {
  pixel(context, colour, x - 2, y, 1, 1);
  pixel(context, colour, x - 1, y + 1, 1, 1);
  pixel(context, colour, x, y + 2, 1, 1);
  pixel(context, colour, x + 1, y + 1, 1, 1);
  pixel(context, colour, x + 2, y, 1, 1);
  pixel(context, background, x - 2, y - 2, 5, 1);
  pixel(context, background, x - 2, y + 3, 5, 1);
  pixel(context, background, x - 3, y - 1, 1, 4);
  pixel(context, background, x + 3, y - 1, 1, 4);
}

function drawCompleteness(context, x, y, blocks, colours) {
  for (let i = 0; i < COMPLETENESS_BLOCKS; i++) {
    const colour = i < blocks ? (blocks === COMPLETENESS_BLOCKS ? colours.green : colours.amber) : colours.blue3;
    pixel(context, colours.gold, x - 7 + i * 4, y - 1, 3, 3);
    if (i < blocks) pixel(context, colour, x - 6 + i * 4, y, 1, 1);
  }
}

// Static pixel-art overlay: no packets or animation, so the state is legible
// in a still capture. The edge panel exposes exact source values.
export function drawInfrastructureXray(context, snapshot, camera, palette) {
  const edges = mapInfrastructure(snapshot);
  if (!edges.length) return;
  const colours = {
    blue3: palette['--m-blue3'], gold: palette['--m-gold'], cyan: palette['--m-cyan'],
    green: palette['--m-green'], red: palette['--m-red'], amber: palette['--m-amber']
  };
  const positions = new Map();

  for (const edge of edges) {
    const route = routeById.get(edge.id), from = pointAt(route.from, camera), to = pointAt(route.to, camera);
    positions.set(route.fromLabel, route.from);
    positions.set(route.toLabel, route.to);
    const visuals = infrastructureVisuals(edge);
    const needsAttention = edge.failureRate >= 0.1 || edge.completeness < 0.8;
    drawLine(context, from, to, colours.cyan, 1);
    const mid = { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
    drawCompleteness(context, mid.x, mid.y, visuals.completenessBlocks, colours);
    if (needsAttention) drawFailure(context, mid.x, mid.y - 8, colours.red, colours.blue3);
    else drawCheck(context, mid.x, mid.y - 8, colours.green, colours.blue3);

    for (let i = 0; i < visuals.latencyTicks; i++) {
      const t = (i + 1) / (visuals.latencyTicks + 1);
      pixel(context, colours.gold, Math.round(from.x + (to.x - from.x) * t),
        Math.round(from.y + (to.y - from.y) * t) - 13, 1, 3);
    }
    for (let i = 0; i < visuals.handoffMarks; i++) {
      const t = (i + 1) / (visuals.handoffMarks + 1);
      drawClipboard(context, Math.round(from.x + (to.x - from.x) * t),
        Math.round(from.y + (to.y - from.y) * t) - 7, colours.gold, colours.blue3);
    }
    for (let i = 0; i < visuals.failureMarks; i++) {
      const t = (i + 1) / (visuals.failureMarks + 1);
      drawFailure(context, Math.round(from.x + (to.x - from.x) * t),
        Math.round(from.y + (to.y - from.y) * t) + 7, colours.red, colours.blue3);
    }
  }
  for (const point of positions.values()) drawNode(context, point, camera, colours);
}
