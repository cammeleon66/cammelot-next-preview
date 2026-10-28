/**
 * @typedef {import('./scenario.js').ScenarioDef} ScenarioDef
 * @typedef {import('./engine.js').Decision} Decision
 * @typedef {import('./engine.js').InterventionDef} InterventionDef
 */

/** @param {InterventionDef} definition @param {ScenarioDef} scenario */
export function validateIntervention(definition, scenario) {
  throw new Error('NotImplemented: validateIntervention');
}

/** @param {InterventionDef} definition @param {Decision} decision @param {number} time */
export function scheduleIntervention(definition, decision, time) {
  throw new Error('NotImplemented: scheduleIntervention');
}

/** @param {object} state @param {object} intervention @param {number} time */
export function applyIntervention(state, intervention, time) {
  throw new Error('NotImplemented: applyIntervention');
}
