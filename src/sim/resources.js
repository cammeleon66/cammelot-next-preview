/**
 * @typedef {{ id: string, servers: number, rooms: number, equipment: number, busy: string[] }} ResourcePool
 */

/** @param {object} data @returns {ResourcePool} */
export function createResourcePool(data) {
  throw new Error('NotImplemented: createResourcePool');
}

/** @param {ResourcePool} pool @param {number} time */
export function capacityAt(pool, time) {
  throw new Error('NotImplemented: capacityAt');
}

/** @param {ResourcePool} pool @param {string} entityId @param {number} time */
export function startService(pool, entityId, time) {
  throw new Error('NotImplemented: startService');
}

/** @param {ResourcePool} pool @param {string} entityId @param {number} time */
export function completeService(pool, entityId, time) {
  throw new Error('NotImplemented: completeService');
}
