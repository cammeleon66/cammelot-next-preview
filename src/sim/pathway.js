/**
 * @typedef {{ patientId: string, stage: string, timestamps: Record<string, number> }} Pathway
 */

/** @param {string} patientId @returns {Pathway} */
export function createPathway(patientId) {
  throw new Error('NotImplemented: createPathway');
}

/** @param {Pathway} pathway @param {object} event */
export function transitionPatient(pathway, event) {
  throw new Error('NotImplemented: transitionPatient');
}
