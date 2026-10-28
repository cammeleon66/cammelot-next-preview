// Live wiring: runs the deterministic engine and adapts its Snapshots for the renderers.
// Renderers only read what this module publishes; nothing here mutates simulation state.
// Wall-clock time never enters the sim: the caller passes real elapsed milliseconds to `advance`.
import { createSim } from '../sim/engine.js';
import { calendarAt, isOpenAt, MINUTES_PER_DAY, MINUTES_PER_WEEK } from '../sim/clock.js';

export const HONEST_LABEL = 'Simulation — synthetic population, parameters tagged in the evidence register';
export const SPEEDS = Object.freeze([1, 4, 16]);
export const SIM_MINUTES_PER_SECOND = MINUTES_PER_DAY; // 1× = one simulated day per real second
export const MAX_FRAME_MS = 100; // a long frame never makes the sim jump
export const MAX_RESIDENTS = 12;
const HOSPITAL_AREAS = Object.freeze(['referral_office', 'outpatient', 'diagnostics']);
const INTERIOR_IDS = Object.freeze({ referral_office: 'referral', outpatient: 'outpatient', diagnostics: 'diagnostics' });
const ROLES = Object.freeze({ referral_office: 'clerk', outpatient: 'doctor', diagnostics: 'radiographer' });

const pad = n => String(n).padStart(2, '0');
const hhmm = minute => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
const hoursLabel = hours => hours ? `${hhmm(hours.startMinute)}–${hhmm(hours.endMinute)}` : 'Open day and night';

export function describeTime(time) {
  const { week, dayOfWeek, minuteOfDay } = calendarAt(time);
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][dayOfWeek];
  return { week: week + 1, text: `Week ${week + 1} · ${day} ${hhmm(minuteOfDay)}` };
}

/** Maps an engine Snapshot to the shape the town, building UI and hospital cutaway read. */
export function toRenderSnapshot(snapshot, scenario) {
  const areas = new Map(scenario.initialState.areas.map(area => [area.id, area]));
  const resource = id => snapshot.resources.find(r => r.areaId === id);
  const open = id => isOpenAt(areas.get(id)?.hours, snapshot.time);
  const param = name => scenario.parameters[name]?.value;
  const treeknormMinutes = (param('treeknormWeeks') ?? 12) * MINUTES_PER_WEEK;

  const patients = snapshot.entities.patients.map(p => p.location.kind === 'area'
    ? { ...p, state: p.location.queuePosition === undefined ? 'in_service' : 'queued',
      location: { ...p.location, id: INTERIOR_IDS[p.location.id] ?? p.location.id } }
    : p);
  const staff = HOSPITAL_AREAS.flatMap(id => Array.from({ length: resource(id)?.capacity ?? 0 }, (_, i) =>
    ({ id: `${id}-${i}`, role: ROLES[id], assignedArea: INTERIOR_IDS[id], onShift: true })));
  const resources = snapshot.resources.map(r => ({ ...r, areaId: INTERIOR_IDS[r.areaId] ?? r.areaId }));

  const gp = resource('gp'), hospital = HOSPITAL_AREAS.map(resource).filter(Boolean);
  const sum = (list, key) => list.reduce((total, r) => total + r[key], 0);
  const breaches = snapshot.entities.patients.filter(p => p.referralAt !== undefined && p.treatmentAt === undefined
    && snapshot.time - p.referralAt > treeknormMinutes).length;
  const edge = snapshot.infrastructure.find(e => e.id === 'gp_to_hospital');

  const buildings = [
    { id: 'gp', state: open('gp') ? 'open' : 'closed', hours: hoursLabel(areas.get('gp')?.hours),
      numbers: [{ label: 'Waiting', value: gp?.queueLength ?? 0, unit: 'people' },
        { label: 'Staff on duty', value: open('gp') ? gp?.capacity ?? 0 : 0 },
        { label: 'Rooms free', value: Math.max(0, (gp?.capacity ?? 0) - (gp?.inService ?? 0)) }] },
    { id: 'hospital', state: HOSPITAL_AREAS.some(open) ? 'open' : 'closed', hours: hoursLabel(areas.get('outpatient')?.hours),
      numbers: [{ label: 'Waiting', value: sum(hospital, 'queueLength'), unit: 'people' },
        { label: `Past ${param('treeknormWeeks') ?? 12}-week norm`, value: breaches },
        { label: 'Staff on duty', value: sum(hospital, 'capacity') }] }];

  const residents = [...snapshot.entities.patients].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_RESIDENTS).map((p, i) => ({ id: p.id, name: p.id, status: p.referralAt === undefined ? 'walking' : 'referred',
      travel: [{ time: 0, x: 2 + i * 2, y: 8.5 }, { time: 20, x: 21 - i * 2, y: 8.5 }, { time: 40, x: 2 + i * 2, y: 8.5 }] }));

  return Object.freeze({
    ...snapshot, entities: { patients, staff }, resources, buildings, residents,
    metrics: { ...snapshot.metrics, gpAppointmentBacklog: gp?.queueLength, gpReferralRate: param('pReferral'),
      gpReferralCompleteness: edge?.completeness, treeknormBreaches: breaches }
  });
}

/** Sim controller: owns the engine, speed and pause state. Real time only arrives via `advance(ms)`. */
export function createLive(scenario, { seed = 42, paused = false, speed = 1 } = {}) {
  const sim = createSim(scenario, seed);
  const state = { paused, speed, carry: 0 };
  let snapshot = sim.snapshot(), decisions = 0;
  return {
    get paused() { return state.paused; },
    get speed() { return state.speed; },
    get snapshot() { return snapshot; },
    runLog() { return sim.runLog(); },
    setPaused(value) { state.paused = Boolean(value); },
    setSpeed(value) {
      if (!SPEEDS.includes(value)) throw new RangeError(`speed must be one of ${SPEEDS.join(', ')}`);
      state.speed = value;
    },
    /** Commits an intervention at the current simulated time; returns the engine's decision-log entry. */
    commit(interventionId, variant = null) {
      const entry = sim.apply({ id: `decision-${++decisions}`, issuedAt: snapshot.time, interventionId,
        ...(variant !== null && { parameters: { variant } }) });
      snapshot = sim.snapshot();
      return entry;
    },
    runLog: () => sim.runLog(),
    /** Advances the engine by wall-clock milliseconds at the chosen speed; returns the (possibly new) Snapshot. */
    advance(ms) {
      if (state.paused || !(ms > 0)) return snapshot;
      state.carry += Math.min(ms, MAX_FRAME_MS) / 1000 * SIM_MINUTES_PER_SECOND * state.speed;
      const minutes = Math.floor(state.carry);
      if (minutes < 1) return snapshot;
      state.carry -= minutes;
      sim.runUntil(snapshot.time + minutes);
      snapshot = sim.snapshot();
      return snapshot;
    }
  };
}
