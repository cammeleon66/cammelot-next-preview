// Hospital cutaway renderer. Reads a Snapshot (docs/SIM_CONTRACTS.md), never mutates it or any sim state.
// The fixture below is synthetic display data shaped like a Snapshot; it is not a measurement or a prediction.
// Patients: entities.patients[] with location { kind: 'area', id, queuePosition? } and state 'queued' | 'in_service'.
export const AREAS = Object.freeze([
  Object.freeze({ id: 'referral', name: 'Referral office' }),
  Object.freeze({ id: 'outpatient', name: 'Outpatient clinic' }),
  Object.freeze({ id: 'diagnostics', name: 'Diagnostics' })]);
export const MAX_CHAIRS = 12, MAX_QUEUE_DRAWN = 8, MAX_STAFF_DRAWN = 4;
export const ROOM = Object.freeze({ w: 256, h: 300, top: 24 });
export const CANVAS_SIZE = Object.freeze({ width: ROOM.w * AREAS.length, height: ROOM.h + ROOM.top + 8 });

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const patient = (id, areaId, state, queuePosition) => ({ id, state, createdAt: 0,
  location: { kind: 'area', id: areaId, ...(queuePosition === undefined ? {} : { queuePosition }) } });
const staff = (id, role, assignedArea, onShift = true) => ({ id, role, assignedArea, onShift });
export const MOCK_INTERIOR_SNAPSHOT = deepFreeze({
  schemaVersion: 1, scenario: { id: 'fixture', version: '0', schemaVersion: 1, sha256: 'fixture' },
  engineVersion: 'fixture', seed: 0, time: 0,
  entities: {
    patients: [
      patient('p1', 'referral', 'in_service'), patient('p2', 'referral', 'queued', 1), patient('p3', 'referral', 'queued', 2),
      patient('p4', 'outpatient', 'in_service'), patient('p5', 'outpatient', 'in_service'), patient('p6', 'outpatient', 'in_service'),
      ...Array.from({ length: 11 }, (_, i) => patient(`q${i}`, 'outpatient', 'queued', i + 1)),
      patient('p7', 'diagnostics', 'in_service'), patient('p8', 'diagnostics', 'queued', 1)],
    staff: [staff('s1', 'clerk', 'referral'), staff('s2', 'clerk', 'referral', false),
      staff('s3', 'doctor', 'outpatient'), staff('s4', 'doctor', 'outpatient'), staff('s5', 'nurse', 'outpatient'),
      staff('s6', 'radiographer', 'diagnostics')] },
  cohorts: [], outcomes: { treatmentStarts: 0, abandonedPatients: 0 },
  resources: [
    { areaId: 'referral', queueLength: 2, inService: 1, capacity: 2, utilisation: 0.5, meanWaitMinutes: 1440 },
    { areaId: 'outpatient', queueLength: 14, inService: 3, capacity: 3, utilisation: 1, meanWaitMinutes: 20160 },
    { areaId: 'diagnostics', queueLength: 1, inService: 1, capacity: 1, utilisation: 0.9, meanWaitMinutes: 5760 }],
  infrastructure: [], metrics: {} });

// ρ tint is always paired with a word label, so colour is never the only signal.
export function utilisationBand(rho) {
  return rho >= 1 ? { band: 'overloaded', label: 'Overloaded', colour: '--m-red' }
    : rho >= 0.85 ? { band: 'strained', label: 'Strained', colour: '--m-amber' }
      : { band: 'ok', label: 'Coping', colour: '--m-green' };
}
const resourceOf = (snapshot, areaId) => snapshot.resources.find(r => r.areaId === areaId);
const patientsIn = (snapshot, areaId, state) => snapshot.entities.patients.filter(p =>
  p.location.kind === 'area' && p.location.id === areaId && p.state === state);

export function describeArea(snapshot, areaId) {
  const area = AREAS.find(a => a.id === areaId), res = resourceOf(snapshot, areaId);
  if (!area || !res) return null;
  const onShift = snapshot.entities.staff.filter(s => s.assignedArea === areaId && s.onShift).length;
  const band = utilisationBand(res.utilisation);
  const reason = onShift === 0 ? 'No staff on shift' : res.utilisation >= 1 ? 'Demand is at or above capacity'
    : res.utilisation >= 0.85 ? 'Running close to capacity' : 'Capacity is available';
  return { id: areaId, name: area.name, queue: res.queueLength, inService: res.inService, capacity: res.capacity,
    rho: res.utilisation, band: band.band, bandLabel: band.label,
    meanWaitDays: res.meanWaitMinutes === undefined ? null : Math.round(res.meanWaitMinutes / 1440 * 10) / 10,
    staffOnShift: onShift, reason };
}

// Pure mapping Snapshot -> draw list. Each patient item is a queued/in-service patient; overflow is a "+N" item.
export function buildDrawList(snapshot) {
  const items = [];
  AREAS.forEach((area, index) => {
    const res = resourceOf(snapshot, area.id); if (!res) return;
    const x0 = index * ROOM.w, band = utilisationBand(res.utilisation);
    items.push({ type: 'room', area: area.id, x: x0, y: ROOM.top, w: ROOM.w, h: ROOM.h, band: band.band, colour: band.colour });
    const chairs = Math.min(res.capacity, MAX_CHAIRS);
    const chairAt = i => ({ x: x0 + 24 + (i % 6) * 36, y: ROOM.top + 120 + Math.floor(i / 6) * 40 });
    for (let i = 0; i < chairs; i++) items.push({ type: 'chair', area: area.id, ...chairAt(i) });
    patientsIn(snapshot, area.id, 'in_service').slice(0, chairs).forEach((p, i) =>
      items.push({ type: 'patient', area: area.id, id: p.id, state: 'in_service', ...chairAt(i) }));
    const queued = patientsIn(snapshot, area.id, 'queued')
      .sort((a, b) => (a.location.queuePosition ?? 0) - (b.location.queuePosition ?? 0)).slice(0, MAX_QUEUE_DRAWN);
    queued.forEach((p, i) => items.push({ type: 'patient', area: area.id, id: p.id, state: 'queued',
      x: x0 + 24 + i * 26, y: ROOM.top + 220 }));
    if (res.queueLength > queued.length) items.push({ type: 'overflow', area: area.id, count: res.queueLength - queued.length,
      x: x0 + 24 + MAX_QUEUE_DRAWN * 26, y: ROOM.top + 220 });
    const onShift = snapshot.entities.staff.filter(s => s.assignedArea === area.id && s.onShift);
    onShift.slice(0, MAX_STAFF_DRAWN).forEach((s, i) => items.push({ type: 'staff', area: area.id, id: s.id, role: s.role,
      x: x0 + 40 + i * 48, y: ROOM.top + 70 }));
    if (onShift.length > MAX_STAFF_DRAWN) items.push({ type: 'overflow', area: area.id, kind: 'staff', count: onShift.length - MAX_STAFF_DRAWN,
      x: x0 + 40 + MAX_STAFF_DRAWN * 48, y: ROOM.top + 70 });
  });
  return items;
}

export function areaAt(point) {
  const index = Math.floor(point.x / ROOM.w);
  return point.y >= ROOM.top && point.y <= ROOM.top + ROOM.h ? AREAS[index]?.id ?? null : null;
}

export function createInterior(canvas) {
  const styles = getComputedStyle(document.documentElement), tok = name => styles.getPropertyValue(name).trim();
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  const rect = (colour, x, y, w, h) => { g.fillStyle = colour; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const label = (colour, text, x, y) => { g.fillStyle = colour; g.font = '12px monospace'; g.fillText(text, Math.round(x), Math.round(y)); };
  return {
    render(snapshot, selected = null) {
      rect(tok('--m-blue3'), 0, 0, canvas.width, canvas.height);
      for (const it of buildDrawList(snapshot)) {
        if (it.type === 'room') {
          rect(tok('--m-gold'), it.x + 4, it.y, it.w - 8, it.h);
          rect(tok('--m-blue2'), it.x + 7, it.y + 3, it.w - 14, it.h - 6);
          rect(tok(it.colour), it.x + 7, it.y + 3, it.w - 14, 6);
          rect(tok('--m-blue'), it.x + 7, it.y + it.h - 60, it.w - 14, 57);
          const name = AREAS.find(a => a.id === it.area).name, d = describeArea(snapshot, it.area);
          label(tok('--m-white'), `${name} · ${d.bandLabel}`, it.x + 14, it.y + 26);
          if (it.area === selected) { g.strokeStyle = tok('--m-white'); g.lineWidth = 2; g.strokeRect(it.x + 5, it.y + 1, it.w - 10, it.h - 2); }
        } else if (it.type === 'chair') rect(tok('--m-paper'), it.x, it.y + 12, 16, 6);
        else if (it.type === 'patient') {
          rect(it.state === 'in_service' ? tok('--m-green') : tok('--m-cyan'), it.x + 3, it.y, 10, 12);
          rect(tok('--m-paper'), it.x + 4, it.y - 7, 8, 7);
        } else if (it.type === 'staff') {
          rect(tok('--m-white'), it.x, it.y, 12, 20); rect(tok('--m-paper'), it.x + 2, it.y - 8, 8, 8);
        } else label(tok('--m-gold'), `+${it.count}`, it.x, it.y + 10);
      }
    }
  };
}
