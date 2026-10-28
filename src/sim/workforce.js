/**
 * @typedef {{ staff: object[], assignments: Map<string, string> }} Workforce
 */

/** @param {object[]} staff @returns {Workforce} */
export function createWorkforce(staff) {
  throw new Error('NotImplemented: createWorkforce');
}

/** @param {Workforce} workforce @param {string} staffId @param {string} areaId @param {number} effectiveAt */
export function assignStaff(workforce, staffId, areaId, effectiveAt) {
  throw new Error('NotImplemented: assignStaff');
}

/** @param {Workforce} workforce @param {string} role @param {object} rng @param {number} time */
export function scheduleRecruitment(workforce, role, rng, time) {
  throw new Error('NotImplemented: scheduleRecruitment');
}
