/**
 * @typedef {import('./engine.js').Snapshot} Snapshot
 * @typedef {import('./engine.js').RunLog} RunLog
 * @typedef {import('./engine.js').CohortAggregate} CohortAggregate
 * @typedef {import('./engine.js').OutcomeMetrics} OutcomeMetrics
 * @typedef {import('./engine.js').Seed} Seed
 * @typedef {{ id: string, version: string, schemaVersion: number, sha256: string }} ScenarioIdentity
 */

/** @typedef {{ schemaVersion: 1, scenario: ScenarioIdentity, engineVersion: string, seed: Seed, cohorts: readonly CohortAggregate[], outcomes: OutcomeMetrics, metrics: Readonly<Record<string, number>> }} AggregateExport */
// Aggregate-only export; named entity and per-patient detail are excluded.
/** @param {object} state @returns {Snapshot} */
export function collectSnapshot(state) {
  throw new Error('NotImplemented: collectSnapshot');
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
