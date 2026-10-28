/**
 * @typedef {'SOURCED'|'CALIBRATED'|'SIMPLIFICATION'|'BALANCE'|'HYPOTHETICAL'|'assumption'} Provenance
 * @typedef {{ value: unknown, provenance: Provenance, source?: { id: string, url: string, title?: string, verified: boolean }, method?: string, rationale?: string }} ProvenancedValue
 * @typedef {{ value: number, provenance: 'assumption', rationale?: string }} AbandonmentExtraWeeks
 * @typedef {{ abandonmentExtraWeeks?: AbandonmentExtraWeeks, [key: string]: ProvenancedValue|AbandonmentExtraWeeks }} ScenarioParameters
 * @typedef {{ id: string, version: string, schemaVersion: number, title: string, description: string, parameters: Readonly<ScenarioParameters>, initialState: { patients?: readonly object[], staff?: readonly object[], areas: readonly object[], fundingSources?: readonly object[], infrastructure?: readonly object[] }, interventions?: readonly import('./engine.js').InterventionDef[] }} ScenarioDef
 */

// If omitted, abandonmentExtraWeeks defaults to 12 (assumption), added beyond the fixed 12-week Treeknorm.
/** @param {ScenarioDef} definition */
export function validateScenario(definition) {
  throw new Error('NotImplemented: validateScenario');
}

/** @param {ScenarioDef|object} definition @returns {ScenarioDef} */
export function loadScenario(definition) {
  throw new Error('NotImplemented: loadScenario');
}
