/**
 * Multi-server resource pool with a priority queue (SIMULATION_SPEC §5).
 *
 * A pool is mutable engine state; every function validates its inputs, mutates
 * the pool in place and returns plain data. Capacity is the minimum of the
 * effective staff limit, rooms, equipment and any active outage cap; null optional
 * caps are unconstrained. When workforce is enabled, staffCapacity replaces the
 * legacy fixed servers value. Queue order is urgent before routine, FIFO within each
 * class; this is
 * separate from DES calendar order in events.js. If capacity later falls below
 * the number of busy servers, in-flight services finish (no pre-emption) and
 * no new service starts until busy < capacity.
 *
 * @typedef {string|number} SimId
 * @typedef {'urgent'|'routine'} Priority
 * @typedef {{ entityId: SimId, priority: Priority, enqueuedAt: number, sequence: number }} QueueEntry
 * @typedef {{
 *   id: SimId, servers: number, rooms: number|null, equipment: number|null,
 *   staffCapacity: number|null, outageCapacity: number|null,
 *   busy: SimId[], busyStartedAt: number[], queue: QueueEntry[],
 *   nextSequence: number, lastTime: number, served: number, totalWaitMinutes: number, waitMinutes: number[]
 * }} ResourcePool
 */

const PRIORITY_RANK = Object.freeze({ urgent: 0, routine: 1 });

function requireSimId(id, label) {
  const valid =
    (typeof id === "string" && id.length > 0) || (Number.isSafeInteger(id) && id >= 0);
  if (!valid) {
    throw new TypeError(`${label} must be a non-empty string or non-negative safe integer`);
  }
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function optionalCap(value, label) {
  if (value === undefined || value === null) return null;
  requireCount(value, label);
  return value;
}

function requirePool(pool) {
  if (!pool || typeof pool !== "object" || !Array.isArray(pool.busy) || !Array.isArray(pool.queue)) {
    throw new TypeError("pool must be created by createResourcePool");
  }
}

/** Validate `time` and keep per-pool time monotonic. */
function advance(pool, time) {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError("time must be a non-negative safe integer minute");
  }
  if (time < pool.lastTime) {
    throw new RangeError(`time ${time} is earlier than the last pool update at ${pool.lastTime}`);
  }
  pool.lastTime = time;
}

function queueIndex(pool, entityId) {
  return pool.queue.findIndex((entry) => entry.entityId === entityId);
}

/**
 * @param {{ id: SimId, servers: number, rooms?: number|null, equipment?: number|null,
 *   staffCapacity?: number|null, outageCapacity?: number|null }} data
 * @returns {ResourcePool}
 */
export function createResourcePool(data) {
  if (!data || typeof data !== "object") throw new TypeError("data must be an object");
  requireSimId(data.id, "id");
  requireCount(data.servers, "servers");
  return {
    id: data.id,
    servers: data.servers,
    rooms: optionalCap(data.rooms, "rooms"),
    equipment: optionalCap(data.equipment, "equipment"),
    staffCapacity: optionalCap(data.staffCapacity, "staffCapacity"),
    outageCapacity: optionalCap(data.outageCapacity, "outageCapacity"),
    busy: [],
    busyStartedAt: [],
    queue: [],
    nextSequence: 0,
    lastTime: 0,
    served: 0,
    totalWaitMinutes: 0,
    waitMinutes: [],
  };
}

/**
 * Available capacity at `time`: min(effective staff, rooms, equipment, outage cap).
 * Null optional caps do not constrain capacity. Time is validated for a stable API; scheduled
 * changes are applied to the pool by engine events before this function is called.
 * @param {ResourcePool} pool @param {number} time
 */
export function capacityAt(pool, time) {
  requirePool(pool);
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError("time must be a non-negative safe integer minute");
  }
  return Math.min(
    pool.staffCapacity ?? pool.servers,
    pool.rooms ?? Infinity,
    pool.equipment ?? Infinity,
    pool.outageCapacity ?? Infinity,
  );
}

/** Apply current effective staff capacity; null restores the legacy server-only cap. */
export function setStaffCapacity(pool, capacity) {
  requirePool(pool);
  pool.staffCapacity = optionalCap(capacity, "staffCapacity");
}

/** Set an active facility outage cap; null removes the outage constraint. */
export function setOutageCapacity(pool, capacity) {
  requirePool(pool);
  pool.outageCapacity = optionalCap(capacity, "outageCapacity");
}

/**
 * Join the queue. Urgent entities sit ahead of routine ones; FIFO within a class.
 * @param {ResourcePool} pool @param {SimId} entityId @param {number} time
 * @param {Priority} [priority]
 * @returns {number} zero-based queue position (entities ahead)
 */
export function enqueue(pool, entityId, time, priority = "routine") {
  requirePool(pool);
  requireSimId(entityId, "entityId");
  if (!Object.hasOwn(PRIORITY_RANK, priority)) {
    throw new RangeError(`priority must be 'urgent' or 'routine', got ${String(priority)}`);
  }
  advance(pool, time);
  if (queueIndex(pool, entityId) !== -1) throw new Error(`entity ${entityId} is already queued`);
  if (pool.busy.includes(entityId)) throw new Error(`entity ${entityId} is already in service`);

  const entry = { entityId, priority, enqueuedAt: time, sequence: pool.nextSequence };
  pool.nextSequence += 1;
  let index = pool.queue.length;
  while (index > 0 && PRIORITY_RANK[pool.queue[index - 1].priority] > PRIORITY_RANK[priority]) {
    index -= 1;
  }
  pool.queue.splice(index, 0, entry);
  return index;
}

/** @param {ResourcePool} pool @returns {number} */
export function queueLength(pool) {
  requirePool(pool);
  return pool.queue.length;
}

/** Zero-based queue position of an entity, or -1 if it is not queued. */
export function queuePosition(pool, entityId) {
  requirePool(pool);
  return queueIndex(pool, entityId);
}

/**
 * Leave the queue without service (e.g. abandonment). Returns the entry or null.
 * @param {ResourcePool} pool @param {SimId} entityId @param {number} time
 */
export function removeFromQueue(pool, entityId, time) {
  requirePool(pool);
  advance(pool, time);
  const index = queueIndex(pool, entityId);
  if (index === -1) return null;
  return pool.queue.splice(index, 1)[0];
}

/**
 * Begin service for an entity. If it is queued it leaves the queue and its wait is recorded;
 * otherwise it starts directly (no wait recorded). Throws when no server is free.
 * @param {ResourcePool} pool @param {SimId} entityId @param {number} time
 * @returns {{ entityId: SimId, startedAt: number, waitMinutes: number }}
 */
export function startService(pool, entityId, time) {
  requirePool(pool);
  requireSimId(entityId, "entityId");
  advance(pool, time);
  if (pool.busy.includes(entityId)) throw new Error(`entity ${entityId} is already in service`);
  if (pool.busy.length >= capacityAt(pool, time)) {
    throw new RangeError(
      `no free capacity in pool ${pool.id} at ${time}: ${pool.busy.length}/${capacityAt(pool, time)} busy`,
    );
  }
  let waitMinutes = 0;
  const index = queueIndex(pool, entityId);
  if (index !== -1) {
    const [entry] = pool.queue.splice(index, 1);
    waitMinutes = time - entry.enqueuedAt;
    pool.totalWaitMinutes += waitMinutes;
    pool.waitMinutes.push(waitMinutes);
    pool.served += 1;
  }
  pool.busy.push(entityId);
  pool.busyStartedAt.push(time);
  return { entityId, startedAt: time, waitMinutes };
}

/**
 * Start service for the head of the queue if capacity is free; returns null otherwise.
 * @param {ResourcePool} pool @param {number} time
 */
export function startNext(pool, time) {
  requirePool(pool);
  advance(pool, time);
  if (pool.queue.length === 0 || pool.busy.length >= capacityAt(pool, time)) return null;
  return startService(pool, pool.queue[0].entityId, time);
}

/**
 * Finish service and free the server.
 * @param {ResourcePool} pool @param {SimId} entityId @param {number} time
 * @returns {{ entityId: SimId, startedAt: number, completedAt: number, serviceMinutes: number }}
 */
export function completeService(pool, entityId, time) {
  requirePool(pool);
  requireSimId(entityId, "entityId");
  advance(pool, time);
  const index = pool.busy.indexOf(entityId);
  if (index === -1) throw new Error(`entity ${entityId} is not in service in pool ${pool.id}`);
  const startedAt = pool.busyStartedAt[index];
  if (time < startedAt) {
    throw new RangeError(`completion time ${time} is before service start ${startedAt}`);
  }
  pool.busy.splice(index, 1);
  pool.busyStartedAt.splice(index, 1);
  return { entityId, startedAt, completedAt: time, serviceMinutes: time - startedAt };
}

/**
 * Read-only record matching `Snapshot.resources[]` (SIM_CONTRACTS). `meanWaitMinutes` is
 * omitted until a queued entity has entered service. Utilisation is busy/capacity (0 when
 * capacity is 0).
 * @param {ResourcePool} pool @param {number} time
 */
export function snapshotPool(pool, time) {
  const capacity = capacityAt(pool, time);
  const record = {
    areaId: pool.id,
    queueLength: pool.queue.length,
    inService: pool.busy.length,
    capacity,
    utilisation: capacity === 0 ? 0 : pool.busy.length / capacity,
  };
  // Already-running service is never pre-empted by a staffing/facility reduction.
  if (pool.busy.length > capacity) record.capacityReductionPending = true;
  if (pool.served > 0) {
    record.meanWaitMinutes = pool.totalWaitMinutes / pool.served;
    const waits = [...pool.waitMinutes].sort((left, right) => left - right);
    const middle = Math.floor(waits.length / 2);
    record.medianWaitMinutes =
      waits.length % 2 === 0 ? (waits[middle - 1] + waits[middle]) / 2 : waits[middle];
  }
  return Object.freeze(record);
}
