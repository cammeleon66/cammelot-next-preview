/**
 * @typedef {number|string} Seed
 * @typedef {string|number} SimId
 * @typedef {{ id: SimId, issuedAt: number, interventionId: string, parameters?: Readonly<Record<string, number|string|boolean>> }} Decision
 * @typedef {{ id: string, type: 'staff'|'facility'|'integration'|'workflow'|'agent', costs: readonly object[], implementationDelayDays: number, adoption: object, effects: readonly object[], preconditions?: readonly string[], failureMode?: object }} InterventionDef
 * @typedef {{ kind: 'home', id: SimId }|{ kind: 'road', id: SimId, progress: number }|{ kind: 'area', id: SimId, queuePosition?: number }|{ kind: 'in_transit', from: SimId, to: SimId, startedAt: number, arrivesAt: number }} LogicalLocation
 * @typedef {{ id: SimId, state: string, acuity: 'urgent'|'routine', location: LogicalLocation, createdAt: number, referralAt?: number, treatmentAt?: number }} NamedPatientDetail
 * @typedef {{ id: SimId, role: string, assignedArea: SimId|null, onShift: boolean }} NamedStaffDetail
 * @typedef {{ cohortId: string, patients: number, waiting: number, inService: number, completed: number, abandoned: number }} CohortAggregate
 * @typedef {{ patients: readonly NamedPatientDetail[], staff: readonly NamedStaffDetail[] }} NamedEntityDetails
 * @typedef {{ areaId: SimId, queueLength: number, inService: number, capacity: number, utilisation: number,
 *   capacityReductionPending?: boolean, meanWaitMinutes?: number, medianWaitMinutes?: number }} ResourceSnapshot
 * @typedef {{ id: SimId, completeness: number, latencyMinutes: number, manualHandoffRate: number, failureRate: number }} InfrastructureSnapshot
 * @typedef {{ schemaVersion: 1, scenario: { id: string, version: string, schemaVersion: number, sha256: string }, engineVersion: string, seed: Seed, time: number, entities: NamedEntityDetails, cohorts: readonly CohortAggregate[], outcomes: OutcomeMetrics, resources: readonly ResourceSnapshot[], infrastructure: readonly InfrastructureSnapshot[], metrics: Readonly<Record<string, number>> }} Snapshot
 * @typedef {{ time: number, sequence: number, type: string, entityId?: SimId, areaId?: SimId,
 *   role?: string, fte?: number, effectiveAt?: number, acuity?: 'urgent'|'routine' }} EventMetadata
 * @typedef {{ decision: Decision, at: number, status: 'queued'|'applied'|'rejected', effectiveAt?: number, reasonCode?: string }} DecisionLogEntry
 * @typedef {{ schemaVersion: 1, scenario: { id: string, version: string, schemaVersion: number, sha256: string }, engineVersion: string, seed: Seed, decisions: readonly DecisionLogEntry[], events: readonly EventMetadata[], finalTime: number, finalOutcomes: OutcomeMetrics, finalMetrics: Readonly<Record<string, number>>, finalResources: readonly ResourceSnapshot[], finalSnapshotHash: string }} RunLog
 * @typedef {import('./scenario.js').ScenarioDef} ScenarioDef
 * @typedef {{ step: () => object|null, runUntil: (time: number) => void, snapshot: () => Snapshot,
 *   apply: (decision: Decision) => DecisionLogEntry, assignStaff: (staffId: SimId, areaId: SimId|null) => object,
 *   recruit: (role: string, options?: object) => object, attritStaff: (staffId: SimId) => object,
 *   runLog: () => RunLog }} Sim
 */

/** @typedef {{ treatmentStarts: number, abandonedPatients: number }} OutcomeMetrics */

import {
  advanceClock,
  createClock,
  isOpenAt,
  MINUTES_PER_DAY,
  MINUTES_PER_QUARTER,
  MINUTES_PER_WEEK,
  nextOpenAt,
} from "./clock.js";
import { scheduleArrivals } from "./demand.js";
import { createArea, createPatient } from "./entities.js";
import { EventQueue } from "./events.js";
import { checkCosts, costIssue, createFundingLedger, postCost, summarizeLedger } from "./funding.js";
import { applyIntervention, parseTarget, resolveVariant, scheduleIntervention, validateIntervention } from "./interventions.js";
import { collectSnapshot } from "./metrics.js";
import { allowedTransitions, createPathway, PATHWAY_STAGES, transitionPatient } from "./pathway.js";
import {
  capacityAt,
  completeService,
  createResourcePool,
  enqueue,
  removeFromQueue,
  setOutageCapacity,
  setStaffCapacity,
  startNext,
} from "./resources.js";
import { indexedStream, lognormal, uniform } from "./rng.js";
import { DEFAULT_ABANDONMENT_EXTRA_WEEKS, canonicalJson, loadScenario } from "./scenario.js";
import { sha256Hex } from "./sha256.js";
import {
  applyStaffAssignment,
  applyStaffDay,
  assignStaff as scheduleStaffAssignment,
  availableFteForArea,
  completeRecruitment,
  createWorkforce,
  removeStaff,
  scheduleRecruitment,
} from "./workforce.js";

export const ENGINE_VERSION = "0.4.0";

const REQUIRED_AREAS = Object.freeze(["gp", "referral_office", "outpatient", "diagnostics"]);
const REQUIRED_PARAMETERS = Object.freeze([
  "treeknormWeeks",
  "arrivalsPerWeek",
  "pUrgent",
  "pReferral",
  "pDiagnostics",
  "gpReworkMeanMinutes",
  "followupMeanMinutes",
]);
const REFERRAL_EDGE = "gp_to_hospital";

/** Queueing stage -> pool that serves it. `gp_rework` and `referral_triage` queue and serve in one stage. */
const STAGE_POOL = Object.freeze({
  gp_queue: "gp",
  gp_rework: "gp",
  referral_triage: "referral_office",
  outpatient_queue: "outpatient",
  followup_queue: "outpatient",
  diagnostics_queue: "diagnostics",
});
/** Stage entered when service starts (stages absent here are both queue and service stage). */
const STAGE_ON_START = Object.freeze({
  gp_queue: "gp_consult",
  outpatient_queue: "outpatient_consult",
  followup_queue: "followup_consult",
  diagnostics_queue: "diagnostics_scan",
});
/** Service kind per queueing stage; selects the mean and keys the per-service random draw. */
const STAGE_KIND = Object.freeze({
  gp_queue: "consult",
  gp_rework: "rework",
  referral_triage: "triage",
  outpatient_queue: "consult",
  followup_queue: "followup",
  diagnostics_queue: "scan",
});
const ABANDONABLE = new Set(PATHWAY_STAGES.filter((stage) => allowedTransitions(stage).includes("abandoned")));
const COHORT_IDS = Object.freeze(["routine", "urgent"]);

/**
 * Detached, deeply frozen copy of caller-supplied data, so later caller mutation can never reach
 * the run log. Plain objects and arrays are copied; cycles and non-plain values (functions,
 * symbols, class instances) are replaced by fixed text markers so the copy is always safe to hold.
 */
function detach(value, ancestors = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "symbol")) {
    return value;
  }
  if (typeof value !== "object") return `[${typeof value}]`;
  if (ancestors.has(value)) return "[circular]";
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return `[${Object.prototype.toString.call(value)}]`;
  ancestors.add(value);
  const copy = isArray ? value.map((item) => detach(item, ancestors)) : {};
  if (!isArray) for (const key of Object.keys(value)) copy[key] = detach(value[key], ancestors);
  ancestors.delete(value);
  return Object.freeze(copy);
}

/**
 * Deterministic discrete-event engine for the GP -> referral -> outpatient -> diagnostics slice
 * (SIMULATION_SPEC §§5–7). Same scenario, seed and ordered commands give identical event logs and
 * snapshots. `apply` commits scenario interventions against the funding ledger; their effects
 * arrive later as simulated-time events (SIMULATION_SPEC §§9–10).
 *
 * Randomness: exogenous draws use the contract streams (`arrivals` per week window, `acuity` per
 * patient); `serviceTimes.<area>` (the contract names for outpatient/diagnostics, extended to
 * `gp` and `referral_office`) and `referralCompleteness` are indexed by stable service/referral
 * identity so a policy change never shifts another patient's draws. Arrival windows are
 * generated lazily, one week ahead of the next event, so tie order never depends on how a caller
 * chunks `runUntil`.
 *
 * @param {ScenarioDef} scenarioDefinition
 * @param {Seed} seed
 * @param {{ sha256?: (canonicalJson: string) => string, recordEvents?: boolean }} [options]
 * @returns {Sim}
 */
export function createSim(scenarioDefinition, seed, options = {}) {
  const scenario = loadScenario(scenarioDefinition);
  const sha256 = options.sha256 ?? sha256Hex;
  const recordEvents = options.recordEvents ?? true;
  indexedStream(seed, "arrivals", 0); // validates the seed before any state is built

  const param = (name) => {
    const entry = scenario.parameters[name];
    if (entry === undefined) throw new RangeError(`scenario is missing required parameter ${name}`);
    return entry.value;
  };
  for (const name of REQUIRED_PARAMETERS) param(name);
  const treeknormWeeks = param("treeknormWeeks");
  const extraWeeks = scenario.parameters.abandonmentExtraWeeks?.value ?? DEFAULT_ABANDONMENT_EXTRA_WEEKS;
  const abandonAfterMinutes = Math.round((treeknormWeeks + extraWeeks) * MINUTES_PER_WEEK);
  const pUrgent = param("pUrgent");
  const pReferral = param("pReferral");
  const pDiagnostics = param("pDiagnostics");
  const arrivalsEnabled = param("arrivalsPerWeek") > 0;

  // Mutable copies: interventions change edge mechanisms (completeness, latency) during a run.
  const edges = (scenario.initialState.infrastructure ?? []).map((definition) => ({ ...definition }));
  const edge = edges.find((candidate) => candidate.id === REFERRAL_EDGE);
  if (edge === undefined) throw new RangeError(`scenario is missing infrastructure edge ${REFERRAL_EDGE}`);

  const areas = scenario.initialState.areas.map((definition) => {
    const area = createArea(definition);
    const pool = createResourcePool(area);
    return {
      area,
      pool,
      openScheduled: false,
      facility: {
        baseRooms: pool.rooms,
        baseEquipment: pool.equipment,
        constructionComplete: area.construction === undefined,
        outageUntil: 0,
        maintenanceUntil: 0,
      },
      loadCursor: 0,
      busyMinutesToday: 0,
      capacityMinutesToday: 0,
    };
  });
  const areaById = new Map(areas.map((entry) => [entry.area.id, entry]));
  for (const id of REQUIRED_AREAS) {
    if (!areaById.has(id)) throw new RangeError(`scenario is missing required area ${id}`);
  }

  const recruitmentDelay = scenario.parameters.recruitmentDelayQuarters?.value;
  const workforce = createWorkforce(scenario.initialState.staff ?? [], {
    enabled: scenario.initialState.staff !== undefined,
    areaRoles: new Map(
      areas.filter(({ area }) => area.staffRole !== undefined).map(({ area }) => [area.id, area.staffRole]),
    ),
    recruitmentDelayQuarters: recruitmentDelay,
    recruitmentSuccessProbability:
      scenario.parameters.recruitmentSuccessProbability?.value ?? recruitmentDelay?.probability,
  });
  // Intervention hires use the workforce recruitment rules on a separate desk: the scenario
  // roster (if any) is untouched and recruitment effects change only declared mechanisms.
  const recruitmentDesk = createWorkforce([], {
    recruitmentDelayQuarters: recruitmentDelay,
    recruitmentSuccessProbability: workforce.recruitmentSuccessProbability,
  });
  const ledger = createFundingLedger(scenario.initialState.fundingSources ?? []);
  // Definitions invalid for this scenario (e.g. `servers` effects once a staff roster replaces
  // servers) stay listed but every decision on them is rejected with INVALID_INTERVENTION.
  const interventionDefs = new Map(
    (scenario.interventions ?? []).map((definition) => [definition.id, { definition, valid: validateIntervention(definition, scenario).ok }]),
  );
  const commitments = new Map();
  const decisionKeys = new Set();
  const staffSicknessProbability =
    scenario.parameters.staffSicknessProbability?.value ?? 0.08;
  const burnoutMultiplier =
    scenario.parameters.burnoutHazardMultiplierAboveRho?.value ?? 1.5;

  const queue = new EventQueue();
  const clock = createClock(0);
  const live = new Map();
  const cohorts = new Map(COHORT_IDS.map((id) => [id, { patients: 0, completed: 0, abandoned: 0 }]));
  const counters = { created: 0, exited: 0, treatmentStarts: 0, abandoned: 0, events: 0 };
  const completedReferralWaitMinutes = [];
  const eventLog = [];
  const decisions = [];
  let arrivalsScheduledThrough = 0;

  const identity = Object.freeze({
    id: scenario.id,
    version: scenario.version,
    schemaVersion: scenario.schemaVersion,
    sha256: sha256(canonicalJson(scenario)),
  });

  function schedule(time, type, fields) {
    queue.enqueue({ time, type, ...fields });
  }

  let logSequence = 0;
  let dailyOperationsEnabled =
    (workforce.enabled && workforce.staff.length > 0) ||
    areas.some(({ area }) => (area.outageProbability ?? 0) > 0 || (area.maintenanceProbability ?? 0) > 0);
  let dailyOperationsScheduled = false;

  function recordCommand(type, fields) {
    if (!recordEvents) return;
    eventLog.push(Object.freeze({
      time: clock.now,
      sequence: logSequence,
      type,
      ...fields,
    }));
    logSequence += 1;
  }

  function openMinutesBetween(hours, from, to) {
    if (hours === undefined) return to - from;
    let total = 0;
    for (let cursor = from; cursor < to; ) {
      const day = Math.floor(cursor / MINUTES_PER_DAY);
      const endOfDay = Math.min(to, (day + 1) * MINUTES_PER_DAY);
      if (hours.days.includes(day % 7)) {
        const openAt = day * MINUTES_PER_DAY + hours.startMinute;
        const closeAt = day * MINUTES_PER_DAY + hours.endMinute;
        total += Math.max(0, Math.min(endOfDay, closeAt) - Math.max(cursor, openAt));
      }
      cursor = endOfDay;
    }
    return total;
  }

  /** Integrate staff occupancy over each area's scheduled open minutes, split by simulated day. */
  function recordWorkloadUntil(time) {
    if (!dailyOperationsEnabled) return;
    for (const entry of areas) {
      let cursor = entry.loadCursor;
      while (cursor < time) {
        const endOfDay = (Math.floor(cursor / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
        const segmentEnd = Math.min(time, endOfDay);
        const openMinutes = openMinutesBetween(entry.area.hours, cursor, segmentEnd);
        entry.busyMinutesToday += entry.pool.busy.length * openMinutes;
        entry.capacityMinutesToday += capacityAt(entry.pool, cursor) * openMinutes;
        cursor = segmentEnd;
      }
      entry.loadCursor = time;
    }
  }

  function refreshStaffCapacity() {
    for (const entry of areas) {
      if (!workforce.enabled) {
        setStaffCapacity(entry.pool, null);
      } else {
        const fte = availableFteForArea(workforce, entry.area.id);
        setStaffCapacity(entry.pool, Math.floor(fte));
      }
    }
  }

  function hasAssignedTechnician(entry) {
    const role = entry.area.construction?.technicianRole ?? "technician";
    return workforce.staff.some(
      (staff) => staff.role === role && workforce.assignments.get(staff.id) === entry.area.id,
    );
  }

  function refreshFacilityCapacity(entry, time) {
    const { area, pool, facility } = entry;
    const construction = area.construction;
    const constructionAvailable =
      construction !== undefined && facility.constructionComplete && hasAssignedTechnician(entry);
    pool.rooms =
      constructionAvailable && construction.rooms !== undefined
        ? (facility.baseRooms ?? 0) + construction.rooms
        : facility.baseRooms;
    pool.equipment =
      constructionAvailable && construction.equipment !== undefined
        ? (facility.baseEquipment ?? 0) + construction.equipment
        : facility.baseEquipment;
    setOutageCapacity(
      pool,
      time < facility.outageUntil || time < facility.maintenanceUntil ? 0 : null,
    );
  }

  function refreshAllCapacity(time) {
    refreshStaffCapacity();
    for (const entry of areas) refreshFacilityCapacity(entry, time);
  }

  function shouldRunDailyOperations() {
    return (
      workforce.staff.length > 0 ||
      areas.some(({ area }) => (area.outageProbability ?? 0) > 0 || (area.maintenanceProbability ?? 0) > 0)
    );
  }

  function ensureDailyOperations(requestedAt = 0) {
    if (dailyOperationsScheduled || !shouldRunDailyOperations()) return;
    const time =
      requestedAt === 0
        ? 0
        : (Math.floor(requestedAt / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
    schedule(time, "daily_operations", {});
    dailyOperationsScheduled = true;
    dailyOperationsEnabled = true;
  }

  function onDailyOperations(event) {
    dailyOperationsScheduled = false;
    const day = Math.floor(event.time / MINUTES_PER_DAY);
    const rhoByArea = new Map(
      areas.map((entry) => [
        entry.area.id,
        entry.capacityMinutesToday === 0 ? null : entry.busyMinutesToday / entry.capacityMinutesToday,
      ]),
    );

    if (workforce.staff.length > 0) {
      applyStaffDay(workforce, day, {
        seed,
        baseProbability: staffSicknessProbability,
        burnoutMultiplier,
        rhoByArea,
      });
    }
    // Burnout uses the prior day's assignment and rho; the transfer is effective for today's
    // capacity and later sickness days.
    for (const assignment of workforce.pendingAssignments.slice()) {
      if (assignment.effectiveAt <= event.time) {
        applyStaffAssignment(workforce, assignment.staffId, assignment.areaId, event.time);
      }
    }

    for (const entry of areas) {
      const { area, facility } = entry;
      const rng = indexedStream(seed, "outages", `${typeof area.id}:${String(area.id)}:${day}`);
      if (uniform(rng) < (area.outageProbability ?? 0)) {
        facility.outageUntil = Math.max(facility.outageUntil, event.time + MINUTES_PER_DAY);
      }
      if (uniform(rng) < (area.maintenanceProbability ?? 0)) {
        facility.maintenanceUntil = Math.max(
          facility.maintenanceUntil,
          event.time + (area.maintenanceDowntimeMinutes ?? MINUTES_PER_DAY),
        );
      }
      refreshFacilityCapacity(entry, event.time);
      for (const until of [facility.outageUntil, facility.maintenanceUntil]) {
        if (until > event.time && until < event.time + MINUTES_PER_DAY) {
          schedule(until, "facility_refresh", { entityId: area.id });
        }
      }
      entry.busyMinutesToday = 0;
      entry.capacityMinutesToday = 0;
      entry.loadCursor = event.time;
    }
    refreshStaffCapacity();
    for (const entry of areas) tryStart(entry, event.time);

    if (shouldRunDailyOperations()) {
      schedule(event.time + MINUTES_PER_DAY, "daily_operations", {});
      dailyOperationsScheduled = true;
    }
  }

  function onFacilityRefresh(event) {
    const entry = areaById.get(event.entityId);
    if (entry === undefined) return;
    refreshFacilityCapacity(entry, event.time);
    tryStart(entry, event.time);
  }

  function onConstructionComplete(event) {
    const entry = areaById.get(event.entityId);
    if (entry === undefined || entry.area.construction === undefined) return;
    entry.facility.constructionComplete = true;
    refreshFacilityCapacity(entry, event.time);
    tryStart(entry, event.time);
  }

  function onStaffAssignmentEffective() {
    // The matching daily_operations event applies all due transfers at this boundary, before
    // drawing the new day's sickness outcomes. This event preserves an explicit replay trace.
  }

  function onRecruitmentComplete(event) {
    const result = completeRecruitment(workforce, event.requestId, event.time);
    refreshAllCapacity(event.time);
    if (result.staff?.assignedArea !== null && result.staff?.assignedArea !== undefined) {
      const entry = areaById.get(result.staff.assignedArea);
      if (entry !== undefined) tryStart(entry, event.time);
    }
    if (result.staff !== null) ensureDailyOperations(event.time);
  }

  refreshAllCapacity(clock.now);
  for (const entry of areas) {
    if (entry.area.construction !== undefined) {
      schedule(entry.area.construction.completesAt, "construction_complete", { entityId: entry.area.id });
    }
  }
  ensureDailyOperations();

  function scheduleArrivalWindow() {
    const from = arrivalsScheduledThrough;
    const to = from + MINUTES_PER_WEEK;
    const rng = indexedStream(seed, "arrivals", from / MINUTES_PER_WEEK);
    for (const arrival of scheduleArrivals(scenario, rng, from, to)) {
      schedule(arrival.time, "arrival", { entityId: arrival.id });
    }
    arrivalsScheduledThrough = to;
  }

  /** Keep one full week of arrivals scheduled beyond the next event. */
  function ensureArrivals() {
    if (!arrivalsEnabled) return;
    for (;;) {
      const next = queue.peek();
      const horizon = next === null ? arrivalsScheduledThrough : next.time;
      if (arrivalsScheduledThrough > horizon + MINUTES_PER_WEEK) return;
      scheduleArrivalWindow();
    }
  }

  function finish(runtime, time, outcome) {
    const cohort = cohorts.get(runtime.record.cohortId);
    live.delete(runtime.record.id);
    runtime.poolId = null;
    runtime.areaPool = null;
    if (outcome === "abandoned") {
      counters.abandoned += 1;
      cohort.abandoned += 1;
    } else {
      if (outcome === "treatment_started") {
        counters.treatmentStarts += 1;
        const referralAt = runtime.pathway.referralAt;
        if (referralAt === undefined) {
          throw new Error(`patient ${String(runtime.record.id)} started treatment without a referral`);
        }
        completedReferralWaitMinutes.push(time - referralAt);
      } else counters.exited += 1;
      cohort.completed += 1;
    }
  }

  /** Transition a patient; a patient past the abandonment threshold leaves on entering a waiting stage. */
  function moveTo(runtime, stage, time) {
    runtime.pathway = transitionPatient(runtime.pathway, { time, to: stage });
    if (stage === "exited" || stage === "treatment_started") {
      finish(runtime, time, stage);
      return false;
    }
    if (runtime.abandonDue && ABANDONABLE.has(stage)) {
      runtime.pathway = transitionPatient(runtime.pathway, { time, to: "abandoned" });
      finish(runtime, time, "abandoned");
      return false;
    }
    return true;
  }

  function joinQueue(runtime, stage, time) {
    if (!moveTo(runtime, stage, time)) return;
    const entry = areaById.get(STAGE_POOL[stage]);
    runtime.poolId = entry.area.id;
    runtime.areaPool = entry.pool;
    enqueue(entry.pool, runtime.record.id, time, runtime.record.acuity);
    tryStart(entry, time);
  }

  function serviceMinutes(entry, runtime, kind) {
    const count = runtime.serviceCounts[kind] ?? 0;
    runtime.serviceCounts[kind] = count + 1;
    const mean =
      kind === "rework"
        ? param("gpReworkMeanMinutes")
        : kind === "followup"
          ? param("followupMeanMinutes")
          : entry.area.serviceTime.mean;
    const rng = indexedStream(seed, `serviceTimes.${entry.area.id}`, `${runtime.record.id}:${kind}:${count}`);
    return Math.max(1, Math.round(lognormal(rng, mean, entry.area.serviceTime.cv)));
  }

  /** Start as many queued services as capacity and opening hours allow; wake at the next opening otherwise. */
  function tryStart(entry, time) {
    const { pool, area } = entry;
    if (pool.queue.length === 0) return;
    if (!isOpenAt(area.hours, time)) {
      if (!entry.openScheduled) {
        const opensAt = nextOpenAt(area.hours, time);
        if (opensAt !== null) {
          entry.openScheduled = true;
          schedule(opensAt, "area_open", { entityId: area.id });
        }
      }
      return;
    }
    while (pool.queue.length > 0 && pool.busy.length < capacityAt(pool, time)) {
      const { entityId } = pool.queue[0];
      const runtime = live.get(entityId);
      const stage = runtime.pathway.stage;
      startNext(pool, time);
      runtime.inService = true;
      const onStart = STAGE_ON_START[stage];
      if (onStart !== undefined) runtime.pathway = transitionPatient(runtime.pathway, { time, to: onStart });
      const minutes = serviceMinutes(entry, runtime, STAGE_KIND[stage]);
      schedule(time + minutes, "service_complete", { entityId, areaId: area.id });
    }
  }

  function startTransfer(runtime, time) {
    runtime.transfer = {
      from: "gp",
      to: "referral_office",
      startedAt: time,
      arrivesAt: time + edge.latencyMinutes,
    };
    schedule(runtime.transfer.arrivesAt, "transfer_arrive", { entityId: runtime.record.id });
  }

  function sendReferral(runtime, time) {
    if (!moveTo(runtime, "referral_transfer", time)) return;
    if (runtime.abandonAt === null) {
      runtime.abandonAt = time + abandonAfterMinutes;
      schedule(runtime.abandonAt, "abandon_check", { entityId: runtime.record.id });
    }
    startTransfer(runtime, time);
  }

  function onArrival(event) {
    const id = event.entityId;
    const attributes = indexedStream(seed, "acuity", id);
    const acuity = uniform(attributes) < pUrgent ? "urgent" : "routine";
    const record = createPatient({
      id,
      acuity,
      needsReferral: uniform(attributes) < pReferral,
      needsDiagnostics: uniform(attributes) < pDiagnostics,
      createdAt: event.time,
    });
    const runtime = {
      record,
      pathway: createPathway(id, event.time),
      poolId: null,
      areaPool: null,
      inService: false,
      transfer: null,
      abandonAt: null,
      abandonDue: false,
      serviceCounts: {},
    };
    live.set(id, runtime);
    counters.created += 1;
    cohorts.get(record.cohortId).patients += 1;
    joinQueue(runtime, "gp_queue", event.time);
  }

  function onServiceComplete(event) {
    const runtime = live.get(event.entityId);
    const entry = areaById.get(event.areaId);
    const time = event.time;
    completeService(entry.pool, event.entityId, time);
    runtime.inService = false;
    runtime.poolId = null;
    runtime.areaPool = null;
    const { id } = runtime.record;
    switch (runtime.pathway.stage) {
      case "gp_consult":
        if (runtime.record.needsReferral) sendReferral(runtime, time);
        else moveTo(runtime, "exited", time);
        break;
      case "gp_rework":
        sendReferral(runtime, time);
        break;
      case "referral_triage": {
        const attempt = runtime.serviceCounts.triage - 1;
        const complete = uniform(indexedStream(seed, "referralCompleteness", `${id}:${attempt}`)) < edge.completeness;
        if (complete) joinQueue(runtime, "outpatient_queue", time);
        else if (moveTo(runtime, "gp_rework", time)) joinRework(runtime, time);
        break;
      }
      case "outpatient_consult":
        if (runtime.record.needsDiagnostics) joinQueue(runtime, "diagnostics_queue", time);
        else moveTo(runtime, "treatment_started", time);
        break;
      case "diagnostics_scan":
        joinQueue(runtime, "followup_queue", time);
        break;
      case "followup_consult":
        moveTo(runtime, "treatment_started", time);
        break;
      default:
        throw new Error(`unexpected stage ${runtime.pathway.stage} at service completion`);
    }
    tryStart(entry, time);
  }

  /** Re-enter the GP pool for admin rework; the stage is already `gp_rework`. */
  function joinRework(runtime, time) {
    const entry = areaById.get("gp");
    runtime.poolId = "gp";
    runtime.areaPool = entry.pool;
    enqueue(entry.pool, runtime.record.id, time, runtime.record.acuity);
    tryStart(entry, time);
  }

  function onTransferArrive(event) {
    const runtime = live.get(event.entityId);
    if (runtime === undefined || runtime.pathway.stage !== "referral_transfer") return; // abandoned in transit
    runtime.transfer = null;
    joinQueue(runtime, "referral_triage", event.time);
  }

  function onAbandonCheck(event) {
    const runtime = live.get(event.entityId);
    if (runtime === undefined) return; // already finished
    const stage = runtime.pathway.stage;
    if (!ABANDONABLE.has(stage) || runtime.inService) {
      runtime.abandonDue = true; // leaves on entering the next waiting stage
      return;
    }
    if (runtime.areaPool !== null) removeFromQueue(runtime.areaPool, runtime.record.id, event.time);
    runtime.transfer = null;
    runtime.abandonDue = true;
    runtime.pathway = transitionPatient(runtime.pathway, { time: event.time, to: "abandoned" });
    finish(runtime, event.time, "abandoned");
  }

  function onAreaOpen(event) {
    const entry = areaById.get(event.entityId);
    entry.openScheduled = false;
    tryStart(entry, event.time);
  }

  const mechanisms = {
    locate(target) {
      const { kind, id } = parseTarget(target);
      return kind === "edge"
        ? { edge: edges.find((candidate) => String(candidate.id) === id) }
        : { entry: areas.find((candidate) => String(candidate.area.id) === id) };
    },
    get(target, param) {
      const { edge: info, entry } = this.locate(target);
      if (info !== undefined) return info[param];
      if (param === "servers") return entry.pool.servers;
      return entry.facility[param === "rooms" ? "baseRooms" : "baseEquipment"];
    },
    set(target, param, value) {
      const { edge: info, entry } = this.locate(target);
      if (info !== undefined) info[param] = value;
      else if (param === "servers") entry.pool.servers = value;
      else entry.facility[param === "rooms" ? "baseRooms" : "baseEquipment"] = value;
    },
  };

  function chargeRecurring(commitment, phase, time) {
    for (const cost of phase.recurringCosts) {
      const result = postCost(ledger, { ...cost, time });
      if (!result.ok) {
        ledger.shortfalls.push(Object.freeze({ decisionId: commitment.decisionId, sourceId: cost.sourceId, amount: cost.amount, time }));
        recordCommand("funding_shortfall", { entityId: commitment.decisionId, reasonCode: result.reasonCode });
      }
    }
  }

  function applyPhase(commitment, phase, time) {
    const result = applyIntervention(mechanisms, phase, time);
    if (!result.ok) return result;
    for (const effect of phase.effects) {
      const { entry } = mechanisms.locate(effect.target);
      if (entry !== undefined) {
        refreshFacilityCapacity(entry, time);
        tryStart(entry, time);
      }
    }
    phase.adoptionNow = result.adoption;
    return result;
  }

  function onInterventionPhase(event) {
    const commitment = commitments.get(event.decisionKey);
    const phase = commitment.phases.find((candidate) => candidate.phase === event.phase);
    if (phase.phase === "recruitment" && !completeRecruitment(recruitmentDesk, phase.requestId, event.time).succeeds) {
      phase.status = "failed";
      recordCommand("intervention_failed", { entityId: commitment.decisionId, reasonCode: "RECRUITMENT_FAILED" });
      return;
    }
    phase.activatedAt = event.time;
    const result = applyPhase(commitment, phase, event.time);
    if (!result.ok) {
      phase.status = "failed";
      recordCommand("intervention_failed", { entityId: commitment.decisionId, reasonCode: result.reasonCode });
      return;
    }
    phase.status = "active";
    if (phase.adoption.rampDays > 0) {
      schedule(event.time + Math.min(MINUTES_PER_WEEK, phase.adoption.rampDays * MINUTES_PER_DAY), "intervention_ramp", {
        entityId: commitment.decisionId, decisionKey: event.decisionKey, phase: phase.phase,
      });
    }
    if (phase.recurringCosts.length > 0) {
      chargeRecurring(commitment, phase, event.time);
      schedule(event.time + MINUTES_PER_QUARTER, "intervention_charge", {
        entityId: commitment.decisionId, decisionKey: event.decisionKey, phase: phase.phase,
      });
    }
  }

  function onInterventionRamp(event) {
    const commitment = commitments.get(event.decisionKey);
    const phase = commitment.phases.find((candidate) => candidate.phase === event.phase);
    applyPhase(commitment, phase, event.time);
    const rampEnd = phase.activatedAt + phase.adoption.rampDays * MINUTES_PER_DAY;
    if (event.time < rampEnd) {
      schedule(Math.min(rampEnd, event.time + MINUTES_PER_WEEK), "intervention_ramp", {
        entityId: commitment.decisionId, decisionKey: event.decisionKey, phase: phase.phase,
      });
    }
  }

  function onInterventionCharge(event) {
    const commitment = commitments.get(event.decisionKey);
    const phase = commitment.phases.find((candidate) => candidate.phase === event.phase);
    chargeRecurring(commitment, phase, event.time);
    schedule(event.time + MINUTES_PER_QUARTER, "intervention_charge", {
      entityId: commitment.decisionId, decisionKey: event.decisionKey, phase: phase.phase,
    });
  }

  const HANDLERS = {
    arrival: onArrival,
    service_complete: onServiceComplete,
    transfer_arrive: onTransferArrive,
    abandon_check: onAbandonCheck,
    area_open: onAreaOpen,
    daily_operations: onDailyOperations,
    facility_refresh: onFacilityRefresh,
    construction_complete: onConstructionComplete,
    staff_assignment_effective: onStaffAssignmentEffective,
    recruitment_complete: onRecruitmentComplete,
    intervention_phase: onInterventionPhase,
    intervention_ramp: onInterventionRamp,
    intervention_charge: onInterventionCharge,
  };

  function step() {
    ensureArrivals();
    const event = queue.dequeue();
    if (event === null) return null;
    recordWorkloadUntil(event.time);
    advanceClock(clock, event.time);
    HANDLERS[event.type](event);
    if (recordEvents) {
      const metadata = { time: event.time, sequence: logSequence, type: event.type, entityId: event.entityId };
      if (event.type === "arrival") metadata.acuity = live.get(event.entityId)?.record.acuity;
      eventLog.push(
        Object.freeze(metadata),
      );
      logSequence += 1;
    }
    counters.events += 1;
    return event;
  }

  function runUntil(time) {
    if (!Number.isSafeInteger(time) || time < clock.now) {
      throw new RangeError(`runUntil target must be a safe integer minute >= ${clock.now}`);
    }
    for (;;) {
      ensureArrivals();
      const next = queue.peek();
      if (next === null || next.time > time) break;
      step();
    }
    advanceClock(clock, time);
  }

  function state() {
    return {
      scenario: identity,
      engineVersion: ENGINE_VERSION,
      seed,
      time: clock.now,
      areas,
      infrastructure: edges,
      funding: summarizeLedger(ledger),
      ledger,
      interventions: [...commitments.values()].map((commitment) => ({
        decisionId: commitment.decisionId,
        interventionId: commitment.interventionId,
        variant: commitment.variant,
        effectiveAt: commitment.effectiveAt,
        phases: commitment.phases.map((phase) => ({
          phase: phase.phase,
          status: phase.status,
          at: phase.at,
          adoption: phase.status === "active" ? phase.adoptionNow : 0,
        })),
      })),
      live,
      cohorts,
      workforce,
      counters,
      completedReferralWaitMinutes,
    };
  }

  /**
   * Commit a decision at the current simulated time. A decision is rejected (logged with a reason
   * code, no side effects) when malformed, unknown, already used, impossible or unfundable.
   * Accepted decisions post one-off costs now and take effect from the next simulated midnight:
   * the implementation phase after its fixed delay and adoption ramp; a recruitment phase after a
   * drawn 1–2-quarter delay, and only if the hire succeeds. Recurring costs start with their phase.
   */
  function apply(decision) {
    const record = (fields) => {
      const entry = Object.freeze({ decision: detach(decision), at: clock.now, ...fields });
      decisions.push(entry);
      return entry;
    };
    const reject = (reasonCode) => record({ status: "rejected", reasonCode });
    const valid =
      decision !== null &&
      typeof decision === "object" &&
      ((typeof decision.id === "string" && decision.id.length > 0) ||
        (Number.isSafeInteger(decision.id) && decision.id >= 0)) &&
      Number.isSafeInteger(decision.issuedAt) &&
      decision.issuedAt >= 0 &&
      typeof decision.interventionId === "string" &&
      decision.interventionId.length > 0 &&
      (decision.parameters === undefined || (decision.parameters !== null && typeof decision.parameters === "object"));
    if (!valid) return reject("INVALID_DECISION");
    const key = `${typeof decision.id}:${String(decision.id)}`;
    if (decisionKeys.has(key)) return reject("DUPLICATE_DECISION_ID");
    decisionKeys.add(key);
    const { definition, valid: definitionValid } = interventionDefs.get(decision.interventionId) ?? {};
    if (definition === undefined) return reject("UNKNOWN_INTERVENTION");
    if (!definitionValid) return reject("INVALID_INTERVENTION");
    const resolved = resolveVariant(definition, decision.parameters?.variant);
    if (resolved === null) return reject("UNKNOWN_VARIANT");
    if (definition.preconditions?.includes("once") &&
        [...commitments.values()].some((commitment) => commitment.interventionId === definition.id)) {
      return reject("ALREADY_COMMITTED");
    }
    const effectiveAt = (Math.floor(clock.now / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
    const plan = scheduleIntervention(resolved, decision, effectiveAt);
    for (const phase of plan.phases) {
      for (const effect of phase.effects) {
        if (effect.op === "add" && mechanisms.get(effect.target, effect.param) + effect.value < 0) {
          return reject("INSUFFICIENT_CAPACITY");
        }
      }
    }
    const recurringIssue = plan.phases.flatMap((phase) => phase.recurringCosts)
      .map((cost) => costIssue(ledger.sources.get(cost.sourceId), cost, cost.interventionType))
      .find((issue) => issue !== null);
    const fundingIssue = recurringIssue ?? checkCosts(ledger, plan.oneOffCosts);
    if (fundingIssue !== null) return reject(fundingIssue);
    for (const cost of plan.oneOffCosts) postCost(ledger, { ...cost, time: clock.now });
    // Keyed by intervention, variant and ordinal (not by caller-chosen decision ids), so the same
    // ordered choices draw the same recruitment outcome whatever the decisions are named.
    const ordinal = [...commitments.values()].filter(
      (commitment) => commitment.interventionId === plan.interventionId && commitment.variant === plan.variant,
    ).length;
    for (const phase of plan.phases) {
      if (phase.phase === "recruitment") {
        const request = scheduleRecruitment(
          recruitmentDesk,
          resolved.role ?? resolved.type,
          indexedStream(seed, "interventionRecruitment", `intervention:${plan.interventionId}:${plan.variant}:${ordinal}`),
          effectiveAt,
        );
        phase.requestId = request.requestId;
        phase.at = request.completesAt;
      }
      schedule(phase.at, "intervention_phase", { entityId: decision.id, decisionKey: key, phase: phase.phase });
    }
    commitments.set(key, plan);
    return record({ status: "applied", effectiveAt });
  }

  function runLog() {
    const snapshot = collectSnapshot(state());
    // Entries, events, outcomes and metrics are immutable; fresh arrays and a frozen envelope
    // keep every call's result detached from the internal log and from other calls.
    return Object.freeze({
      schemaVersion: 1,
      scenario: identity,
      engineVersion: ENGINE_VERSION,
      seed,
      decisions: Object.freeze([...decisions]),
      events: Object.freeze([...eventLog]),
      finalTime: clock.now,
      finalOutcomes: snapshot.outcomes,
      finalMetrics: snapshot.metrics,
      finalResources: Object.freeze(snapshot.resources.map((resource) => Object.freeze({ ...resource }))),
      finalSnapshotHash: sha256(canonicalJson(snapshot)),
    });
  }

  function assignStaff(staffId, areaId) {
    if (areaId !== null && !areaById.has(areaId)) {
      throw new RangeError(`unknown area ${String(areaId)}`);
    }
    const effectiveAt = (Math.floor(clock.now / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
    const assignment = scheduleStaffAssignment(workforce, staffId, areaId, effectiveAt);
    schedule(assignment.effectiveAt, "staff_assignment_effective", { staffId, areaId });
    recordCommand("staff_assignment_scheduled", {
      entityId: staffId,
      areaId,
      effectiveAt: assignment.effectiveAt,
    });
    return assignment;
  }

  function recruit(role, options = {}) {
    if (options?.assignedArea !== undefined && options.assignedArea !== null && !areaById.has(options.assignedArea)) {
      throw new RangeError(`unknown area ${String(options.assignedArea)}`);
    }
    const requestId = `recruitment-${workforce.nextRecruitmentId}`;
    const request = scheduleRecruitment(
      workforce,
      role,
      indexedStream(seed, "recruitment", requestId),
      clock.now,
      options,
    );
    schedule(request.completesAt, "recruitment_complete", { requestId: request.requestId });
    refreshAllCapacity(clock.now);
    ensureDailyOperations(clock.now);
    recordCommand("recruitment_scheduled", {
      entityId: request.requestId,
      role: request.role,
      effectiveAt: request.completesAt,
    });
    return request;
  }

  function attritStaff(staffId) {
    const removed = removeStaff(workforce, staffId);
    refreshAllCapacity(clock.now);
    if (removed.assignedArea !== null) {
      const entry = areaById.get(removed.assignedArea);
      if (entry !== undefined) tryStart(entry, clock.now);
    }
    recordCommand("staff_attrition", { entityId: staffId, fte: removed.fte });
    return removed;
  }

  return {
    step,
    runUntil,
    snapshot: () => collectSnapshot(state()),
    apply,
    assignStaff,
    recruit,
    attritStaff,
    runLog,
  };
}
