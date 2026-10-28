/**
 * @typedef {import('./engine.js').Snapshot} Snapshot
 */

/** @param {object} state @param {Snapshot} snapshot */
export function checkInvariants(state, snapshot) {
  throw new Error('NotImplemented: checkInvariants');
}

/** @param {object} state @param {Snapshot} snapshot */
export function assertInvariants(state, snapshot) {
  throw new Error('NotImplemented: assertInvariants');
}
