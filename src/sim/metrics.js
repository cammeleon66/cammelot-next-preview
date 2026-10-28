/**
 * @typedef {import('./engine.js').Snapshot} Snapshot
 * @typedef {import('./engine.js').RunLog} RunLog
 * @typedef {import('./engine.js').CohortAggregate} CohortAggregate
 * @typedef {import('./engine.js').OutcomeMetrics} OutcomeMetrics
 * @typedef {import('./engine.js').Seed} Seed
 * @typedef {{ id: string, version: string, schemaVersion: number, sha256: string }} ScenarioIdentity
 */

/** @typedef {{ schemaVersion: 1, scenario: ScenarioIdentity, engineVersion: string, seed: Seed, cohorts: readonly CohortAggregate[], outcomes: OutcomeMetrics, metrics: Readonly<Record<string, number>> }} AggregateExport */
import { queuePosition, snapshotPool } from "./resources.js";

/**
 * Engine state read by `collectSnapshot` (built by engine.js; never mutated here):
 * `{ scenario: ScenarioIdentity, engineVersion, seed, time, areas: {id, pool}[],
 *    infrastructure: object[], live: Map<id, runtime>, cohorts: Map<cohortId, counts>,
 *    counters: { created, exited, treatmentStarts, abandoned, events } }`
 * where each live runtime is `{ record, pathway, poolId, inService, transfer }`.
 * The snapshot reports queue counts, resource wait summaries and referral-to-treatment
 * percentiles alongside the system outcome counters.
 */

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function quantile(values, probability) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * fraction;
}

function locationOf(runtime) {
  if (runtime.transfer) {
    return {
      kind: "in_transit",
      from: runtime.transfer.from,
      to: runtime.transfer.to,
      startedAt: runtime.transfer.startedAt,
      arrivesAt: runtime.transfer.arrivesAt,
    };
  }
  if (runtime.poolId !== null) {
    const location = { kind: "area", id: runtime.poolId };
    if (!runtime.inService) {
      location.queuePosition = queuePosition(runtime.areaPool, runtime.record.id);
    }
    return location;
  }
  return { kind: "home", id: runtime.record.id };
}

/**
 * Immutable snapshot per SIM_CONTRACTS `Snapshot`. Entity detail lists live (non-terminal)
 * patients only; terminal patients are counted in `cohorts` and `outcomes`. Synthetic output.
 * @param {object} state
 * @returns {Snapshot}
 */
export function collectSnapshot(state) {
  const patients = [];
  const staff = state.workforce === undefined
    ? []
    : state.workforce.staff
        .map((member) => ({
          id: member.id,
          role: member.role,
          assignedArea: state.workforce.assignments.get(member.id) ?? null,
          onShift: member.onShift && !member.sick,
        }))
        .sort((left, right) => {
          const a = `${typeof left.id}:${String(left.id)}`;
          const b = `${typeof right.id}:${String(right.id)}`;
          return a < b ? -1 : a > b ? 1 : 0;
        });
  const waiting = new Map();
  const inService = new Map();
  for (const runtime of state.live.values()) {
    const { record, pathway } = runtime;
    const detail = {
      id: record.id,
      state: pathway.stage,
      location: locationOf(runtime),
      createdAt: record.createdAt,
      acuity: record.acuity,
    };
    if (pathway.referralAt !== undefined) detail.referralAt = pathway.referralAt;
    if (pathway.treatmentAt !== undefined) detail.treatmentAt = pathway.treatmentAt;
    patients.push(detail);
    const bucket = runtime.inService ? inService : waiting;
    bucket.set(record.cohortId, (bucket.get(record.cohortId) ?? 0) + 1);
  }

  const cohorts = [...state.cohorts.keys()].sort().map((cohortId) => {
    const counts = state.cohorts.get(cohortId);
    return {
      cohortId,
      patients: counts.patients,
      waiting: waiting.get(cohortId) ?? 0,
      inService: inService.get(cohortId) ?? 0,
      completed: counts.completed,
      abandoned: counts.abandoned,
    };
  });

  const { counters } = state;
  return deepFreeze({
    schemaVersion: 1,
    synthetic: true,
    scenario: { ...state.scenario },
    engineVersion: state.engineVersion,
    seed: state.seed,
    time: state.time,
    entities: { patients, staff },
    cohorts,
    outcomes: {
      treatmentStarts: counters.treatmentStarts,
      abandonedPatients: counters.abandoned,
    },
    resources: state.areas.map(({ pool }) => snapshotPool(pool, state.time)),
    infrastructure: state.infrastructure.map((edge) => ({
      id: edge.id,
      completeness: edge.completeness,
      latencyMinutes: edge.latencyMinutes,
      manualHandoffRate: edge.manualHandoffRate,
      failureRate: edge.failureRate,
    })),
    // Optional (schema-additive): funding balances by source and committed intervention progress.
    ...(state.funding !== undefined && { funding: state.funding }),
    ...(state.interventions !== undefined && { interventions: state.interventions }),
    metrics: {
      patientsCreated: counters.created,
      patientsExited: counters.exited,
      patientsLive: state.live.size,
      eventsProcessed: counters.events,
      medianReferralToTreatmentMinutes: quantile(state.completedReferralWaitMinutes, 0.5),
      p90ReferralToTreatmentMinutes: quantile(state.completedReferralWaitMinutes, 0.9),
      treatmentWaitSamples: state.completedReferralWaitMinutes.length,
    },
  });
}

/**
 * Summarizes snapshots into an aggregate-only export; named patient detail is
 * excluded from exports and run logs.
 * @param {Snapshot[]} snapshots
 * @param {RunLog} runLog
 * @returns {AggregateExport}
 */
export function summarizeRun(snapshots, runLog) {
  throw new Error('NotImplemented: summarizeRun');
}
