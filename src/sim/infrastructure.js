/**
 * @typedef {{ id: string, completeness: number, latencyMinutes: number, manualHandoffRate: number, failureRate: number }} InfoEdge
 */

/** @param {object} data @returns {InfoEdge} */
export function createInfoEdge(data) {
  throw new Error('NotImplemented: createInfoEdge');
}

/** @param {InfoEdge} edge @param {object} message @param {object} rng @param {number} time */
export function transmit(edge, message, rng, time) {
  throw new Error('NotImplemented: transmit');
}
