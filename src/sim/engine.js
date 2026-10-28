/**
 * @typedef {number|string} Seed
 * @typedef {string|number} SimId
 * @typedef {{ id: SimId, issuedAt: number, interventionId: string, parameters?: Readonly<Record<string, number|string|boolean>> }} Decision
 * @typedef {{ id: string, type: 'staff'|'facility'|'integration'|'workflow'|'agent', costs: readonly object[], implementationDelayDays: number, adoption: object, effects: readonly object[], preconditions?: readonly string[], failureMode?: object }} InterventionDef
 * @typedef {{ kind: 'home', id: SimId }|{ kind: 'road', id: SimId, progress: number }|{ kind: 'area', id: SimId, queuePosition?: number }|{ kind: 'in_transit', from: SimId, to: SimId, startedAt: number, arrivesAt: number }} LogicalLocation
 * @typedef {{ id: SimId, state: string, location: LogicalLocation, createdAt: number, referralAt?: number, treatmentAt?: number }} NamedPatientDetail
 * @typedef {{ id: SimId, role: string, assignedArea: SimId|null, onShift: boolean }} NamedStaffDetail
 * @typedef {{ cohortId: string, patients: number, waiting: number, inService: number, completed: number, abandoned: number }} CohortAggregate
 * @typedef {{ patients: readonly NamedPatientDetail[], staff: readonly NamedStaffDetail[] }} NamedEntityDetails
 * @typedef {{ areaId: SimId, queueLength: number, inService: number, capacity: number, utilisation: number, meanWaitMinutes?: number }} ResourceSnapshot
 * @typedef {{ id: SimId, completeness: number, latencyMinutes: number, manualHandoffRate: number, failureRate: number }} InfrastructureSnapshot
 * @typedef {{ schemaVersion: 1, scenario: { id: string, version: string, schemaVersion: number, sha256: string }, engineVersion: string, seed: Seed, time: number, entities: NamedEntityDetails, cohorts: readonly CohortAggregate[], outcomes: OutcomeMetrics, resources: readonly ResourceSnapshot[], infrastructure: readonly InfrastructureSnapshot[], metrics: Readonly<Record<string, number>> }} Snapshot
 * @typedef {{ time: number, sequence: number, type: string }} EventMetadata
 * @typedef {{ decision: Decision, at: number, status: 'queued'|'applied'|'rejected', effectiveAt?: number, reasonCode?: string }} DecisionLogEntry
 * @typedef {{ schemaVersion: 1, scenario: { id: string, version: string, schemaVersion: number, sha256: string }, engineVersion: string, seed: Seed, decisions: readonly DecisionLogEntry[], events: readonly EventMetadata[], finalTime: number, finalOutcomes: OutcomeMetrics, finalMetrics: Readonly<Record<string, number>> }} RunLog
 * @typedef {import('./scenario.js').ScenarioDef} ScenarioDef
 * @typedef {{ step: Function, runUntil: Function, snapshot: Function, apply: Function }} Sim
 */

/** @typedef {{ treatmentStarts: number, abandonedPatients: number }} OutcomeMetrics */
// Privacy boundary: snapshots may contain named entity detail; run logs contain only
// aggregate/final outcomes and decision/event metadata, never named-patient data.
/**
 * @param {ScenarioDef} scenario
 * @param {Seed} seed
 * @returns {Sim}
 */
export function createSim(scenario, seed) {
  throw new Error('NotImplemented: createSim');
}
