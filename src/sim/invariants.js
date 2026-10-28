import { validateLedger } from "./funding.js";
import { capacityAt } from "./resources.js";

/**
 * @typedef {import('./engine.js').Snapshot} Snapshot
 * @typedef {import('./resources.js').ResourcePool} ResourcePool
 */

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate the public population and resource invariants. When engine state is
 * supplied, also check that every live patient occupies exactly one valid place.
 * @param {object|null|undefined} state
 * @param {Snapshot} snapshot
 * @returns {string[]}
 */
export function checkInvariants(state, snapshot) {
  const errors = [];
  if (snapshot === null || typeof snapshot !== "object") return ["snapshot must be an object"];

  const metrics = snapshot.metrics;
  const outcomes = snapshot.outcomes;
  if (metrics === null || typeof metrics !== "object" || outcomes === null || typeof outcomes !== "object") {
    return ["snapshot must include metrics and outcomes"];
  }

  const { patientsCreated, patientsExited, patientsLive } = metrics;
  const { treatmentStarts, abandonedPatients } = outcomes;
  if (![patientsCreated, patientsExited, patientsLive, treatmentStarts, abandonedPatients].every(isCount)) {
    errors.push("population counts must be non-negative safe integers");
  } else if (patientsCreated !== patientsExited + patientsLive + treatmentStarts + abandonedPatients) {
    errors.push("patient conservation: created must equal live, exited, treatment starts, and abandoned");
  }

  if (!Array.isArray(snapshot.entities?.patients)) {
    errors.push("snapshot.entities.patients must be an array");
  } else if (isCount(patientsLive) && snapshot.entities.patients.length !== patientsLive) {
    errors.push("live patient detail count must equal metrics.patientsLive");
  }
  if (!Array.isArray(snapshot.entities?.staff)) {
    errors.push("snapshot.entities.staff must be an array");
  } else {
    const areaIds = new Set(
      Array.isArray(snapshot.resources) ? snapshot.resources.map((resource) => resource?.areaId) : [],
    );
    const staffIds = new Set();
    for (const staff of snapshot.entities.staff) {
      const validId =
        (typeof staff?.id === "string" && staff.id.length > 0) ||
        (Number.isSafeInteger(staff?.id) && staff.id >= 0);
      if (!validId || staffIds.has(staff.id)) {
        errors.push(`staff ${String(staff?.id)} has an invalid or duplicate id`);
      } else {
        staffIds.add(staff.id);
      }
      if (typeof staff?.role !== "string" || staff.role.length === 0) {
        errors.push(`staff ${String(staff?.id)} has an invalid role`);
      }
      if (typeof staff?.onShift !== "boolean") {
        errors.push(`staff ${String(staff?.id)} has an invalid onShift status`);
      }
      if (staff?.assignedArea !== null && !areaIds.has(staff?.assignedArea)) {
        errors.push(`staff ${String(staff?.id)} is assigned to an unknown area`);
      }
    }
  }

  if (!Array.isArray(snapshot.cohorts)) {
    errors.push("snapshot.cohorts must be an array");
  } else {
    let cohortPatients = 0;
    let cohortWaiting = 0;
    let cohortInService = 0;
    let cohortCompleted = 0;
    let cohortAbandoned = 0;
    for (const cohort of snapshot.cohorts) {
      const counts = [cohort.patients, cohort.waiting, cohort.inService, cohort.completed, cohort.abandoned];
      if (!counts.every(isCount)) {
        errors.push(`cohort ${String(cohort.cohortId)} counts must be non-negative safe integers`);
        continue;
      }
      if (cohort.patients !== cohort.waiting + cohort.inService + cohort.completed + cohort.abandoned) {
        errors.push(`cohort ${String(cohort.cohortId)} does not conserve patients`);
      }
      cohortPatients += cohort.patients;
      cohortWaiting += cohort.waiting;
      cohortInService += cohort.inService;
      cohortCompleted += cohort.completed;
      cohortAbandoned += cohort.abandoned;
    }
    if (isCount(patientsCreated) && cohortPatients !== patientsCreated) {
      errors.push("cohort patient total must equal metrics.patientsCreated");
    }
    if (isCount(patientsLive) && cohortWaiting + cohortInService !== patientsLive) {
      errors.push("cohort waiting and in-service total must equal metrics.patientsLive");
    }
    if (isCount(patientsExited) && isCount(treatmentStarts) && cohortCompleted !== patientsExited + treatmentStarts) {
      errors.push("cohort completed total must equal exited patients plus treatment starts");
    }
    if (isCount(abandonedPatients) && cohortAbandoned !== abandonedPatients) {
      errors.push("cohort abandoned total must equal outcomes.abandonedPatients");
    }
  }

  if (!Array.isArray(snapshot.resources)) {
    errors.push("snapshot.resources must be an array");
  } else {
    for (const resource of snapshot.resources) {
      if (
        !isCount(resource.capacity) ||
        !isCount(resource.inService) ||
        !isCount(resource.queueLength) ||
        !Number.isFinite(resource.utilisation) ||
        resource.utilisation < 0 ||
        (resource.capacityReductionPending !== undefined &&
          typeof resource.capacityReductionPending !== "boolean")
      ) {
        errors.push(`resource ${String(resource.areaId)} has invalid queue or capacity counts`);
      } else {
        const capacityReducedDuringInFlightService = resource.capacityReductionPending === true;
        if (
          (resource.inService > resource.capacity && !capacityReducedDuringInFlightService) ||
          (resource.inService <= resource.capacity && capacityReducedDuringInFlightService)
        ) {
          errors.push(`resource ${String(resource.areaId)} exceeds staffed capacity`);
        }
        const expected = resource.capacity === 0 ? 0 : resource.inService / resource.capacity;
        if (resource.utilisation !== expected) {
          errors.push(`resource ${String(resource.areaId)} utilisation does not match capacity`);
        }
      }
    }
  }

  if (snapshot.funding !== undefined) {
    const sources = Array.isArray(snapshot.funding.sources) ? snapshot.funding.sources : [];
    const sum = (key) => sources.reduce((total, source) => total + source[key], 0);
    if (!sources.every((source) => [source.initial, source.balance, source.spent].every(isCount))) {
      errors.push("funding sources must have non-negative whole-euro initial, balance and spent amounts");
    } else if (sum("balance") + sum("spent") !== sum("initial")) {
      errors.push("funding ledger: balances plus expenses must equal initial funds");
    }
  }

  if (state !== null && state !== undefined) {
    if (state.ledger !== undefined) errors.push(...validateLedger(state.ledger).errors.map((error) => `funding ledger: ${error}`));
    checkEngineState(state, errors, snapshot);
    if (isCount(patientsCreated) && state.counters?.created !== patientsCreated) {
      errors.push("engine and snapshot created-patient counts differ");
    }
    if (isCount(patientsLive) && state.live?.size !== patientsLive) {
      errors.push("engine and snapshot live-patient counts differ");
    }
  }
  return errors;
}

/**
 * @param {object} state
 * @param {string[]} errors
 */
function checkEngineState(state, errors, snapshot) {
  if (!Number.isSafeInteger(state.time) || state.time < 0) errors.push("engine time must be a non-negative integer");
  if (!(state.live instanceof Map) || !Array.isArray(state.areas) || !state.counters) {
    errors.push("engine state must include live patients, areas, and counters");
    return;
  }

  const { created, exited, treatmentStarts, abandoned } = state.counters;
  if (![created, exited, treatmentStarts, abandoned].every(isCount)) {
    errors.push("engine outcome counters must be non-negative safe integers");
  } else if (created !== state.live.size + exited + treatmentStarts + abandoned) {
    errors.push("engine patient conservation failed");
  }
  if (state.workforce !== undefined) checkWorkforceState(state.workforce, state.areas, snapshot, errors);

  const locations = new Map();
  for (const { area, pool } of state.areas) {
    if (!area || !pool || !Array.isArray(pool.busy) || !Array.isArray(pool.queue)) {
      errors.push("engine area must include a resource pool");
      continue;
    }
    if (
      !Array.isArray(pool.busyStartedAt) ||
      pool.busyStartedAt.length !== pool.busy.length ||
      !pool.busyStartedAt.every((startedAt) => Number.isSafeInteger(startedAt) && startedAt >= 0 && startedAt <= state.time)
    ) {
      errors.push(`resource ${String(pool.id)} has invalid in-service start times`);
    }
    const resourceSnapshot = Array.isArray(snapshot.resources)
      ? snapshot.resources.find((resource) => resource?.areaId === pool.id)
      : undefined;
    if (
      resourceSnapshot === undefined ||
      resourceSnapshot.capacity !== capacityAt(pool, state.time) ||
      resourceSnapshot.inService !== pool.busy.length
    ) {
      errors.push(`resource ${String(pool.id)} snapshot does not match engine capacity`);
    }
    for (const id of pool.busy) {
      if (locations.has(id)) errors.push(`patient ${String(id)} occupies multiple resource positions`);
      locations.set(id, { pool, inService: true });
    }
    for (const entry of pool.queue) {
      if (locations.has(entry.entityId)) errors.push(`patient ${String(entry.entityId)} occupies multiple resource positions`);
      locations.set(entry.entityId, { pool, inService: false });
    }
  }
  for (const [id, runtime] of state.live) {
    if (runtime.poolId === null) {
      if (locations.has(id)) errors.push(`patient ${String(id)} has a resource position without a pool assignment`);
      continue;
    }
    const position = locations.get(id);
    if (position === undefined || position.pool !== runtime.areaPool || position.inService !== runtime.inService) {
      errors.push(`patient ${String(id)} does not match its resource pool position`);
    }
  }
  for (const id of locations.keys()) {
    if (!state.live.has(id)) errors.push(`resource pool contains non-live patient ${String(id)}`);
  }
}

function checkWorkforceState(workforce, areas, snapshot, errors) {
  if (
    !Array.isArray(workforce.staff) ||
    !(workforce.assignments instanceof Map) ||
    !(workforce.staffByRole instanceof Map)
  ) {
    errors.push("engine workforce state is invalid");
    return;
  }
  const areaIds = new Set(areas.map((entry) => entry?.area?.id));
  const staffIds = new Set();
  let currentFte = 0;
  for (const staff of workforce.staff) {
    const id = staff?.id;
    if (
      !((typeof id === "string" && id.length > 0) || (Number.isSafeInteger(id) && id >= 0)) ||
      staffIds.has(id)
    ) {
      errors.push(`engine staff ${String(id)} has an invalid or duplicate id`);
      continue;
    }
    staffIds.add(id);
    if (typeof staff.role !== "string" || staff.role.length === 0) {
      errors.push(`engine staff ${String(id)} has an invalid role`);
    }
    if (!Number.isFinite(staff.fte) || staff.fte <= 0) {
      errors.push(`engine staff ${String(id)} has invalid FTE`);
    } else {
      currentFte += staff.fte;
    }
    if (typeof staff.onShift !== "boolean" || typeof staff.sick !== "boolean") {
      errors.push(`engine staff ${String(id)} has invalid availability state`);
    }
    const assignedArea = workforce.assignments.get(id) ?? null;
    if (staff.assignedArea !== assignedArea) {
      errors.push(`engine staff ${String(id)} assignment does not match the workforce index`);
    }
    if (assignedArea !== null && !areaIds.has(assignedArea)) {
      errors.push(`engine staff ${String(id)} is assigned to an unknown area`);
    }
  }
  for (const [staffId, areaId] of workforce.assignments) {
    if (!staffIds.has(staffId)) errors.push(`workforce assignment references unknown staff ${String(staffId)}`);
    if (!areaIds.has(areaId)) errors.push(`workforce assignment references unknown area ${String(areaId)}`);
  }
  const roleMembers = new Map();
  for (const [role, ids] of workforce.staffByRole) {
    if (!(ids instanceof Set)) {
      errors.push(`workforce role pool ${String(role)} is invalid`);
      continue;
    }
    for (const id of ids) {
      if (roleMembers.has(id)) errors.push(`staff ${String(id)} appears in multiple role pools`);
      if (!staffIds.has(id)) errors.push(`workforce role pool ${String(role)} references unknown staff ${String(id)}`);
      roleMembers.set(id, role);
    }
  }
  for (const staff of workforce.staff) {
    if (roleMembers.get(staff.id) !== staff.role) {
      errors.push(`engine staff ${String(staff.id)} is missing from its role pool`);
    }
  }
  if (Array.isArray(snapshot.entities?.staff)) {
    const snapshotStaff = new Map(snapshot.entities.staff.map((staff) => [staff.id, staff]));
    if (snapshotStaff.size !== workforce.staff.length) {
      errors.push("engine workforce and snapshot staff counts differ");
    }
    for (const staff of workforce.staff) {
      const detail = snapshotStaff.get(staff.id);
      if (
        detail === undefined ||
        detail.role !== staff.role ||
        detail.assignedArea !== (workforce.assignments.get(staff.id) ?? null) ||
        detail.onShift !== (staff.onShift && !staff.sick)
      ) {
        errors.push(`engine staff ${String(staff.id)} does not match snapshot detail`);
      }
    }
  }
  for (const { area, pool } of areas) {
    const areaFte = workforce.staff.reduce(
      (total, staff) =>
        total +
        (staff.assignedArea === area.id &&
        staff.onShift &&
        !staff.sick &&
        (area.staffRole === undefined ? staff.role !== "technician" : staff.role === area.staffRole)
          ? staff.fte
          : 0),
      0,
    );
    const expectedStaffCapacity = workforce.enabled
      ? Math.floor(areaFte)
      : null;
    if (pool.staffCapacity !== expectedStaffCapacity) {
      errors.push(`resource ${String(area.id)} staff capacity does not match assigned workforce`);
    }
  }

  if (!Number.isFinite(currentFte)) errors.push("current workforce FTE total must be finite");
  const totals = [workforce.initialFte, workforce.recruitedFte, workforce.attritedFte];
  if (!totals.every((value) => Number.isFinite(value) && value >= 0)) {
    errors.push("workforce FTE accounting totals must be finite and non-negative");
  } else {
    const expectedFte = workforce.initialFte + workforce.recruitedFte - workforce.attritedFte;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(expectedFte), Math.abs(currentFte)) * 8;
    if (Math.abs(currentFte - expectedFte) > tolerance) {
      errors.push("workforce FTE conservation failed");
    }
  }
}

/** @param {object|null|undefined} state @param {Snapshot} snapshot */
export function assertInvariants(state, snapshot) {
  const errors = checkInvariants(state, snapshot);
  if (errors.length > 0) {
    throw new Error(`Simulation invariant violations:\n- ${errors.join("\n- ")}`);
  }
  return true;
}
