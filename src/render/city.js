import { project, depthSort, createCamera, toScreen, integerScale } from './iso.js';
import { PALETTE_TOKENS } from './sprites.js';
import { buildingHull } from './hit.js';
import { drawInfrastructureXray } from './xray.js';

// Rendering fixture only: contract-shaped snapshot with extra visual travel keyframes.
// The metrics and building numbers are synthetic display values, not measurements.
// A caller supplies time in the same units as the keyframes; inputs are never changed.
const mockBuilding = (id, state, hours, ...numbers) => Object.freeze({ id, state, hours,
  numbers: Object.freeze(numbers.map(([label, value, unit]) => Object.freeze({ label, value, unit }))) });
export const MOCK_SNAPSHOT = Object.freeze({
  schemaVersion: 1, scenario: Object.freeze({ id: 'fixture', version: '0', schemaVersion: 1, sha256: 'fixture' }),
  engineVersion: 'fixture', seed: 0, time: 0,
  entities: Object.freeze({ patients: Object.freeze([]), staff: Object.freeze([]) }),
  cohorts: Object.freeze([]), outcomes: Object.freeze({ treatmentStarts: 0, abandonedPatients: 0 }),
  resources: Object.freeze([]),
  metrics: Object.freeze({
    gpSessionsPerDay: 12, gpAppointmentBacklog: 8, gpReferralRate: 0.25, gpReferralCompleteness: 0.7
  }),
  buildings: Object.freeze([
    mockBuilding('gp', 'open', '08:00–17:00', ['Waiting', 3, 'people'], ['Staff on duty', 2], ['Rooms free', 1]),
    mockBuilding('hospital', 'open', 'Open day and night', ['Waiting', 5, 'people'], ['Staff on duty', 6])]),
  residents: Object.freeze(
    ['Hendrik', 'Fatima', 'Noor', 'Willem', 'Saskia', 'Daan', 'Roos', 'Bram', 'Yara'].map((name, i) =>
      Object.freeze({ id: name, name, status: i % 2 ? 'referred' : 'walking',
        travel: Object.freeze([
          Object.freeze({ time: 0, x: 2 + i * 2, y: 8.5 }),
          Object.freeze({ time: 20, x: 21 - i * 2, y: 8.5 }),
          Object.freeze({ time: 40, x: 2 + i * 2, y: 8.5 })
        ]) }))),
  // Fully synthetic demonstration fixture; not observations or healthcare evidence.
  infrastructure: Object.freeze([
    Object.freeze({ id: 'gp-hospital-referral', completeness: 0.72, latencyMinutes: 45,
      manualHandoffRate: 0.4, failureRate: 0.12 }),
    Object.freeze({ id: 'hospital-scheduler', completeness: 0.86, latencyMinutes: 20,
      manualHandoffRate: 0.25, failureRate: 0.06 })
  ])
});

export function walkersAt(snapshot, time = snapshot.time) {
  return snapshot.residents.map(resident => {
    const keys = resident.travel;
    let a = keys[0], b = a;
    for (const key of keys) {
      if (key.time <= time) a = key;
      if (key.time >= time) { b = key; break; }
      b = key;
    }
    const t = a.time === b.time ? 0 : Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
    return { ...resident, kind: 'walker', x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}

// Scan-converted polygons deliberately avoid Canvas antialiasing: every pixel is a token.
function polygon(g, points, colour) {
  g.fillStyle = colour;
  for (let y = Math.floor(Math.min(...points.map(p => p[1]))); y < Math.max(...points.map(p => p[1])); y++) {
    const hits = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], sy = y + .5;
      if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy))
        hits.push(a[0] + (sy - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2)
      g.fillRect(Math.ceil(hits[i] - .5), y, Math.ceil(hits[i + 1] - .5) - Math.ceil(hits[i] - .5), 1);
  }
}
const rect = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

export function buildingParts(buildings) {
  // Split each footprint into tile columns, then back roof / front walls. Sorting
  // one large hospital sprite by its furthest corner would hide side-road walkers.
  return buildings.flatMap(b => Array.from({ length: b.w * b.d }, (_, i) => {
    const x = b.x + i % b.w, y = b.y + Math.floor(i / b.w);
    return [{ ...b, x, y, kind: 'roof', z: -1 }, { ...b, x: x + .5, y: y + .5, tileX: x, tileY: y,
      left: y === b.y + b.d - 1, right: x === b.x + b.w - 1, kind: 'front', z: -1 }];
  }).flat());
}

export function createCity(canvas, world) {
  const styles = getComputedStyle(document.documentElement);
  const c = Object.fromEntries(PALETTE_TOKENS.map(token => [token.slice(2), styles.getPropertyValue(token).trim()]));
  const layer = () => Object.assign(document.createElement('canvas'), { width: 800, height: 448 });
  const ground = layer(), scene = layer(), gg = ground.getContext('2d'), g = scene.getContext('2d');
  const offset = p => [Math.round(p.x + 400), Math.round(p.y + 32)];
  // Opaque pattern fills keep every pixel a palette token (no alpha blending).
  const pattern = (colour, cells) => {
    const tile = Object.assign(document.createElement('canvas'), { width: 4, height: 4 }), tg = tile.getContext('2d');
    tg.fillStyle = colour; cells.forEach(([x, y]) => tg.fillRect(x, y, 1, 1));
    return tile;
  };
  const patterns = { closed: pattern(c['m-blue3'], [[0, 0], [2, 0], [1, 1], [3, 1], [0, 2], [2, 2], [1, 3], [3, 3]]),
    construction: pattern(c['m-amber'], [[0, 0], [1, 1], [2, 2], [3, 3]]) };
  for (let y = 0; y < world.height; y++) for (let x = 0; x < world.width; x++) {
    const [sx, sy] = offset(project(x, y)), tile = world.legend[world.tiles[y][x]];
    const colour = { grass: c.bg, canal: c['m-blue'], road: c['m-paperink'], bridge: c.frame, square: c.parchment }[tile];
    polygon(gg, [[sx, sy], [sx + 16, sy + 8], [sx, sy + 16], [sx - 16, sy + 8]], colour);
    if (tile === 'canal') rect(gg, c['m-cyan'], sx - 5, sy + 7, 9, 1);
    if (tile === 'bridge') rect(gg, c['m-gold'], sx - 8, sy + 7, 16, 2);
    if (tile === 'grass' && (x + y) % 4 === 0) rect(gg, c['m-green'], sx, sy + 8, 2, 1);
    if (tile === 'road' && x % 3 === 0) rect(gg, c['m-paper'], sx, sy + 8, 3, 1);
  }
  const fixed = [...buildingParts(world.buildings), ...world.props];
  const context = canvas.getContext('2d');
  let camera = createCamera(canvas.width, canvas.height);
  function drawItem(item, g = scene.getContext('2d')) {
    const [x, y] = offset(project(item.tileX ?? item.x, item.tileY ?? item.y));
    const h = item.height;
    if (item.kind === 'roof') {
      polygon(g, [[x, y - h], [x + 16, y + 8 - h], [x, y + 16 - h], [x - 16, y + 8 - h]], item.id.startsWith('home') ? c['m-red'] : c['m-white']);
      if (item.id.startsWith('home')) {
        polygon(g, [[x - 16, y + 8 - h], [x, y - h - 10], [x, y + 16 - h]], c.frame);
        polygon(g, [[x, y - h - 10], [x + 16, y + 8 - h], [x, y + 16 - h]], c['m-red']);
      }
    } else if (item.kind === 'front') {
      if (item.left) {
        polygon(g, [[x - 16, y + 8 - h], [x, y + 16 - h], [x, y + 16], [x - 16, y + 8]], c.frame);
        rect(g, c['m-cyan'], x - 10, y + 16 - h, 4, 6);
      }
      if (item.right) {
        polygon(g, [[x, y + 16 - h], [x + 16, y + 8 - h], [x + 16, y + 8], [x, y + 16]], item.id.startsWith('home') ? c['m-amber'] : c['m-paper']);
        rect(g, c['m-blue2'], x + 5, y + 18 - h, 5, 6);
        rect(g, c['m-cyan'], x + 6, y + 18 - h, 3, 4);
        rect(g, c['m-blue2'], x + 2, y + 5, 5, 8);
        if (item.id === 'gp' || item.id === 'hospital') {
          rect(g, c['m-blue'], x + 4, y - h + 26, 9, 5);
          rect(g, c['m-white'], x + 8, y - h + 26, 1, 5);
          rect(g, c['m-white'], x + 6, y - h + 28, 5, 1);
        }
      }
    } else if (item.kind === 'walker') {
      rect(g, c['m-paperink'], x - 3, y - 1, 7, 2);
      rect(g, c['m-blue3'], x - 2, y - 4, 2, 4);
      rect(g, c['m-blue3'], x + 1, y - 4, 2, 4);
      rect(g, item.status === 'referred' ? c['m-cyan'] : c['m-red'], x - 3, y - 10, 7, 6);
      rect(g, c.parchment, x - 2, y - 14, 5, 4);
      rect(g, c.frame, x - 2, y - 15, 5, 2);
      if (item.status === 'referred') rect(g, c['m-white'], x + 4, y - 8, 3, 4);
    } else if (item.kind === 'tree') {
      rect(g, c.frame, x - 1, y - 12, 3, 13);
      polygon(g, [[x, y - 28], [x + 11, y - 8], [x - 11, y - 8]], c['m-green']);
    } else if (item.kind === 'market') {
      rect(g, c.frame, x - 10, y - 12, 2, 14); rect(g, c.frame, x + 9, y - 12, 2, 14);
      for (let i = 0; i < 5; i++) rect(g, i % 2 ? c['m-white'] : c['m-red'], x - 12 + i * 5, y - 14, 5, 5);
      rect(g, c['m-amber'], x - 11, y - 3, 22, 3);
    } else {
      for (const dx of [-5, 5]) {
        rect(g, c['m-paperink'], x + dx - 3, y - 4, 7, 6);
        rect(g, c['m-gold'], x + dx - 2, y - 3, 5, 4);
      }
      rect(g, c['m-blue3'], x - 4, y - 4, 9, 2); rect(g, c['m-blue3'], x + 2, y - 8, 2, 6);
    }
  }
  // Cache exact opaque silhouettes, including gables/windows, not bounding boxes.
  // Ground-depth sorting alone cannot hide a head behind a roof on a side edge.
  const masks = world.buildings.map(building => {
    const mask = layer(), mg = mask.getContext('2d');
    depthSort(buildingParts([building])).forEach(part => drawItem(part, mg));
    return { building, mask, left: offset(project(building.x, building.y + building.d))[0],
      right: offset(project(building.x + building.w, building.y))[0],
      top: offset(project(building.x, building.y))[1] - building.height - 10,
      bottom: offset(project(building.x + building.w, building.y + building.d))[1] };
  });
  // Building states from the snapshot: closed = dithered dark, construction = amber scaffold stripes.
  const stateLayers = new Map();
  function drawState(building, state) {
    const key = `${building.id}:${state}`;
    if (!stateLayers.has(key)) {
      const layerCanvas = layer(), lg = layerCanvas.getContext('2d');
      lg.fillStyle = lg.createPattern(patterns[state], 'repeat'); lg.fillRect(0, 0, 800, 448);
      lg.globalCompositeOperation = 'destination-in'; lg.drawImage(masks.find(m => m.building === building).mask, 0, 0);
      stateLayers.set(key, layerCanvas);
    }
    g.drawImage(stateLayers.get(key), 0, 0);
  }
  function outline(building, colour) {
    const points = buildingHull(building).map(([x, y]) => offset({ x, y }));
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let k = 0; k <= steps; k++)
        rect(g, colour, Math.round(x0 + (x1 - x0) * k / steps), Math.round(y0 + (y1 - y0) * k / steps), 2, 2);
    }
  }
  const sprite = Object.assign(document.createElement('canvas'), { width: 12, height: 18 });
  const sg = sprite.getContext('2d');
  function drawWalker(walker) {
    const [x, y] = offset(project(walker.x, walker.y));
    const occluders = masks.filter(({ building: b, left, right, top, bottom }) =>
      (walker.x < b.x || walker.y < b.y) && walker.x < b.x + b.w && walker.y < b.y + b.d &&
      x + 7 > left && x - 3 < right && y + 1 > top && y - 15 < bottom);
    if (!occluders.length) { drawItem(walker); return; }
    sg.clearRect(0, 0, 12, 18);
    sg.setTransform(1, 0, 0, 1, 4 - x, 16 - y);
    drawItem(walker, sg);
    sg.resetTransform();
    sg.globalCompositeOperation = 'destination-out';
    for (const { mask } of occluders) {
      // Outside either rear edge, but not beyond either front edge. This uses
      // the entire footprint, so long buildings work even when x+y is larger.
      sg.drawImage(mask, x - 4, y - 16, 12, 18, 0, 0, 12, 18);
    }
    sg.globalCompositeOperation = 'source-over';
    g.drawImage(sprite, x - 4, y - 16);
  }
  return {
    get camera() { return { ...camera }; },
    resize(width, height) { canvas.width = width; canvas.height = height; camera = { ...camera, width, height }; },
    pan(dx, dy) {
      camera.x = Math.max(-300, Math.min(300, camera.x + dx / camera.scale));
      camera.y = Math.max(0, Math.min(384, camera.y + dy / camera.scale));
    },
    zoom(scale) { camera.scale = integerScale(scale); },
    reset() { camera = createCamera(canvas.width, canvas.height); },
    // view = { hover, selected } building ids drawn as outlines (gold = hover/focus, white = selected).
    render(snapshot, time = snapshot.time, view = {}) {
      g.clearRect(0, 0, scene.width, scene.height); g.drawImage(ground, 0, 0);
      // State layers sort at the building's front-most part, so walkers in front stay undimmed.
      const states = (snapshot.buildings ?? []).flatMap(entry => {
        const building = world.buildings.find(b => b.id === entry.id);
        return building && patterns[entry.state] ? [{ kind: 'state', building, state: entry.state,
          x: building.x + building.w - .5, y: building.y + building.d - .5, z: -1 }] : [];
      });
      depthSort([...fixed, ...states, ...walkersAt(snapshot, time)]).forEach(item =>
        item.kind === 'walker' ? drawWalker(item) : item.kind === 'state' ? drawState(item.building, item.state) : drawItem(item));
      for (const [id, colour] of [[view.hover, c['m-gold']], [view.selected, c['m-white']]]) {
        const building = id && world.buildings.find(b => b.id === id);
        if (building) outline(building, colour);
      }
      rect(context, c['m-blue3'], 0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      const origin = toScreen({ x: -400, y: -32 }, camera);
      context.drawImage(scene, origin.x, origin.y, scene.width * camera.scale, scene.height * camera.scale);
      if (view.xray) {
        drawInfrastructureXray(context, snapshot, camera, {
          '--m-blue3': c['m-blue3'], '--m-gold': c['m-gold'], '--m-cyan': c['m-cyan'],
          '--m-green': c['m-green'], '--m-red': c['m-red'], '--m-amber': c['m-amber']
        });
      }
    }
  };
}
