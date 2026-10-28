import { MINUTES_PER_QUARTER } from "./clock.js";
import { createStaffMember } from "./entities.js";
import { indexedStream, uniform } from "./rng.js";

const DEFAULT_RECRUITMENT = Object.freeze({ min: 1, max: 2, probability: 0.7 });
const DEFAULT_SICKNESS_PROBABILITY = 0.08;
const DEFAULT_BURNOUT_MULTIPLIER = 1.5;
const BURNOUT_AFTER_HIGH_RHO_DAYS = 7;

function isSimId(value) {
  return (typeof value === "string" && value.length > 0) || (Number.isSafeInteger(value) && value >= 0);
}

function requireWorkforce(workforce) {
  if (
    workforce === null ||
    typeof workforce !== "object" ||
    !Array.isArray(workforce.staff) ||
    !(workforce.assignments instanceof Map) ||
    !(workforce.staffByRole instanceof Map)
  ) {
    throw new TypeError("workforce must be created by createWorkforce");
  }
}

function requireTime(time, label = "time") {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer minute`);
  }
}

function requireProbability(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a number in [0, 1]`);
  }
}

function roleRequiredAt(workforce, areaId) {
  return workforce.areaRoles.get(areaId);
}

function addStaffMember(workforce, data) {
  const record = createStaffMember(data);
  if (workforce.staff.some((staff) => staff.id === record.id)) {
    throw new Error(`duplicate staff id ${String(record.id)}`);
  }
  const staff = { ...record, highRhoDays: 0 };
  workforce.staff.push(staff);
  if (record.assignedArea !== null) workforce.assignments.set(record.id, record.assignedArea);
  let pool = workforce.staffByRole.get(record.role);
  if (pool === undefined) {
    pool = new Set();
    workforce.staffByRole.set(record.role, pool);
  }
  pool.add(record.id);
  return staff;
}

/**
 * Mutable simulation workforce. FTE is conserved by tracking the initial roster, successful
 * hires, and explicit attrition separately. Areas may declare `staffRole` to require a role.
 *
 * @param {object[]} staff
 * @param {{ enabled?: boolean, areaRoles?: Map<string|number, string>|object,
 *   recruitmentDelayQuarters?: { min?: number, max?: number, probability?: number },
 *   recruitmentSuccessProbability?: number }} [options]
 */
export function createWorkforce(staff = [], options = {}) {
  if (!Array.isArray(staff)) throw new TypeError("staff must be an array");
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const areaRoles = options.areaRoles instanceof Map
    ? new Map(options.areaRoles)
    : new Map(Object.entries(options.areaRoles ?? {}));
  const delay = { ...DEFAULT_RECRUITMENT, ...options.recruitmentDelayQuarters };
  if (
    !Number.isFinite(delay.min) ||
    !Number.isFinite(delay.max) ||
    delay.min < 1 ||
    delay.max > 2 ||
    delay.max < delay.min
  ) {
    throw new RangeError("recruitment delay must satisfy 1 <= min <= max <= 2 quarters");
  }
  const recruitmentSuccessProbability =
    options.recruitmentSuccessProbability ?? delay.probability ?? DEFAULT_RECRUITMENT.probability;
  requireProbability(recruitmentSuccessProbability, "recruitmentSuccessProbability");

  const workforce = {
    staff: [],
    assignments: new Map(),
    staffByRole: new Map(),
    areaRoles,
    pendingAssignments: [],
    pendingRecruitments: [],
    enabled: options.enabled ?? staff.length > 0,
    initialFte: 0,
    recruitedFte: 0,
    attritedFte: 0,
    nextRecruitmentId: 0,
    lastStaffDay: -1,
    recruitmentDelayQuarters: Object.freeze({ min: delay.min, max: delay.max }),
    recruitmentSuccessProbability,
  };
  for (const member of staff) {
    const added = addStaffMember(workforce, member);
    workforce.initialFte += added.fte;
    if (!Number.isFinite(workforce.initialFte)) throw new RangeError("total initial FTE must be finite");
  }
  return workforce;
}

/**
 * Schedule an exclusive reassignment at an explicit effective minute. The engine computes this
 * as midnight of the day after the request; this helper records the transition without moving
 * capacity early.
 * @param {ReturnType<typeof createWorkforce>} workforce
 * @param {string|number} staffId
 * @param {string|number|null} areaId
 * @param {number} effectiveAt
 */
export function assignStaff(workforce, staffId, areaId, effectiveAt) {
  requireWorkforce(workforce);
  if (!isSimId(staffId)) throw new TypeError("staffId must be a valid simulation id");
  requireTime(effectiveAt, "effectiveAt");
  const staff = workforce.staff.find((member) => member.id === staffId);
  if (staff === undefined) throw new RangeError(`unknown staff member ${String(staffId)}`);
  if (areaId !== null && !isSimId(areaId)) throw new TypeError("areaId must be null or a valid simulation id");
  if (workforce.pendingAssignments.some((assignment) => assignment.staffId === staffId)) {
    throw new Error(`staff member ${String(staffId)} already has a pending assignment`);
  }
  const assignment = Object.freeze({
    staffId,
    fromArea: workforce.assignments.get(staffId) ?? null,
    areaId,
    effectiveAt,
  });
  workforce.pendingAssignments.push(assignment);
  return assignment;
}

/** Apply an already scheduled reassignment when its next-day event is processed. */
export function applyStaffAssignment(workforce, staffId, areaId, time) {
  requireWorkforce(workforce);
  requireTime(time);
  const index = workforce.pendingAssignments.findIndex(
    (assignment) => assignment.staffId === staffId && assignment.areaId === areaId,
  );
  if (index === -1) throw new Error(`no matching pending assignment for staff member ${String(staffId)}`);
  const assignment = workforce.pendingAssignments[index];
  if (time < assignment.effectiveAt) {
    throw new RangeError(`assignment for ${String(staffId)} is not effective until ${assignment.effectiveAt}`);
  }
  const staff = workforce.staff.find((member) => member.id === staffId);
  if (staff === undefined) throw new RangeError(`unknown staff member ${String(staffId)}`);
  workforce.pendingAssignments.splice(index, 1);
  if (areaId === null) workforce.assignments.delete(staffId);
  else workforce.assignments.set(staffId, areaId);
  staff.assignedArea = areaId;
  return assignment;
}

/**
 * Schedule a hire with a uniform 1–2-quarter delay and a separately drawn success outcome.
 * Pass an indexed stream named `recruitment` from the engine so other activity cannot shift it.
 * @param {ReturnType<typeof createWorkforce>} workforce
 * @param {string} role
 * @param {object} rng
 * @param {number} time
 * @param {{ assignedArea?: string|number|null, fte?: number }} [options]
 */
export function scheduleRecruitment(workforce, role, rng, time, options = {}) {
  requireWorkforce(workforce);
  if (typeof role !== "string" || role.length === 0) throw new TypeError("role must be a non-empty string");
  if (rng === null || typeof rng?.nextUint32 !== "function") {
    throw new TypeError("rng must be a seeded random stream");
  }
  requireTime(time);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const fte = options.fte ?? 1;
  if (typeof fte !== "number" || !Number.isFinite(fte) || fte <= 0) {
    throw new RangeError("fte must be a positive finite number");
  }
  const assignedArea = options.assignedArea ?? null;
  if (assignedArea !== null && !isSimId(assignedArea)) {
    throw new TypeError("assignedArea must be null or a valid simulation id");
  }
  const requestId = `recruitment-${workforce.nextRecruitmentId}`;
  const requestedStaffId = `staff-${requestId}`;
  let staffId = requestedStaffId;
  let collision = 1;
  while (
    workforce.staff.some((member) => member.id === staffId) ||
    workforce.pendingRecruitments.some((request) => request.staffId === staffId)
  ) {
    staffId = `${requestedStaffId}-${collision}`;
    collision += 1;
  }
  const delayQuarters =
    workforce.recruitmentDelayQuarters.min +
    uniform(rng) * (workforce.recruitmentDelayQuarters.max - workforce.recruitmentDelayQuarters.min);
  const completesAt = time + Math.ceil(delayQuarters * MINUTES_PER_QUARTER);
  if (!Number.isSafeInteger(completesAt)) throw new RangeError("recruitment completion time exceeds safe integer range");
  const succeeds = uniform(rng) < workforce.recruitmentSuccessProbability;
  workforce.nextRecruitmentId += 1;
  const request = Object.freeze({
    requestId,
    staffId,
    role,
    fte,
    assignedArea,
    requestedAt: time,
    completesAt,
    succeeds,
  });
  workforce.pendingRecruitments.push(request);
  workforce.enabled = true;
  return request;
}

/** Resolve a scheduled recruitment; successful recruits enter the role pool at completion. */
export function completeRecruitment(workforce, requestId, time) {
  requireWorkforce(workforce);
  requireTime(time);
  const index = workforce.pendingRecruitments.findIndex((request) => request.requestId === requestId);
  if (index === -1) throw new RangeError(`unknown recruitment ${String(requestId)}`);
  const request = workforce.pendingRecruitments[index];
  if (time < request.completesAt) {
    throw new RangeError(`recruitment ${requestId} is not complete until ${request.completesAt}`);
  }
  const recruitedFte = request.succeeds ? workforce.recruitedFte + request.fte : workforce.recruitedFte;
  if (!Number.isFinite(recruitedFte)) throw new RangeError("total recruited FTE must be finite");
  workforce.pendingRecruitments.splice(index, 1);
  let staff = null;
  if (request.succeeds) {
    staff = addStaffMember(workforce, {
      id: request.staffId,
      role: request.role,
      fte: request.fte,
      assignedArea: request.assignedArea,
    });
    workforce.recruitedFte = recruitedFte;
  }
  return Object.freeze({ requestId, succeeds: request.succeeds, staff, completedAt: time });
}

/** Remove a staff member as explicit attrition, preserving the FTE accounting invariant. */
export function removeStaff(workforce, staffId) {
  requireWorkforce(workforce);
  const index = workforce.staff.findIndex((member) => member.id === staffId);
  if (index === -1) throw new RangeError(`unknown staff member ${String(staffId)}`);
  const nextAttritedFte = workforce.attritedFte + workforce.staff[index].fte;
  if (!Number.isFinite(nextAttritedFte)) throw new RangeError("total attrited FTE must be finite");
  const [staff] = workforce.staff.splice(index, 1);
  workforce.assignments.delete(staffId);
  workforce.staffByRole.get(staff.role)?.delete(staffId);
  workforce.pendingAssignments = workforce.pendingAssignments.filter((assignment) => assignment.staffId !== staffId);
  workforce.attritedFte = nextAttritedFte;
  return Object.freeze({
    id: staff.id,
    role: staff.role,
    fte: staff.fte,
    assignedArea: staff.assignedArea,
  });
}

/**
 * Draw one independent staff-day sickness outcome per member. Burnout starts after seven
 * consecutive daily samples with area rho > 0.9; rho is supplied by the engine's daily
 * busy-capacity integral. Sickness lasts for that simulated day only.
 */
export function applyStaffDay(
  workforce,
  day,
  {
    seed,
    baseProbability = DEFAULT_SICKNESS_PROBABILITY,
    burnoutMultiplier = DEFAULT_BURNOUT_MULTIPLIER,
    burnoutDays = BURNOUT_AFTER_HIGH_RHO_DAYS,
    rhoByArea = new Map(),
  } = {},
) {
  requireWorkforce(workforce);
  if (!Number.isSafeInteger(day) || day < 0) throw new RangeError("day must be a non-negative safe integer");
  if (day <= workforce.lastStaffDay) throw new RangeError("staff days must be processed in strictly increasing order");
  requireProbability(baseProbability, "baseProbability");
  if (typeof burnoutMultiplier !== "number" || !Number.isFinite(burnoutMultiplier) || burnoutMultiplier < 1) {
    throw new RangeError("burnoutMultiplier must be a finite number >= 1");
  }
  if (!Number.isSafeInteger(burnoutDays) || burnoutDays < 1) {
    throw new RangeError("burnoutDays must be a positive safe integer");
  }
  if (!(rhoByArea instanceof Map)) throw new TypeError("rhoByArea must be a Map");

  const updated = [];
  for (const staff of workforce.staff) {
    if (!staff.onShift) {
      staff.highRhoDays = 0;
      continue;
    }
    const rho = staff.assignedArea === null ? null : (rhoByArea.get(staff.assignedArea) ?? null);
    if (rho !== null && (!Number.isFinite(rho) || rho < 0)) {
      throw new RangeError("area rho must be a non-negative finite number or null");
    }
    staff.highRhoDays = rho !== null && rho > 0.9 ? staff.highRhoDays + 1 : 0;
    const multiplier = staff.highRhoDays >= burnoutDays ? burnoutMultiplier : 1;
    const hazard = Math.min(1, baseProbability * multiplier);
    const staffKey = `${typeof staff.id}:${String(staff.id)}:${day}`;
    staff.sick = uniform(indexedStream(seed, "staffSickness", staffKey)) < hazard;
    updated.push(staff.id);
  }
  workforce.lastStaffDay = day;
  return Object.freeze(updated);
}

/** FTE actually available to work in an area at this instant. Areas with an explicit
* `staffRole` count only that role; generic areas count all non-technician staff. */
export function availableFteForArea(workforce, areaId, role = roleRequiredAt(workforce, areaId)) {
  requireWorkforce(workforce);
  if (!isSimId(areaId)) throw new TypeError("areaId must be a valid simulation id");
  if (role !== undefined && (typeof role !== "string" || role.length === 0)) {
    throw new TypeError("role must be a non-empty string when present");
  }
  return workforce.staff.reduce(
    (total, staff) =>
      total +
      (staff.assignedArea === areaId &&
      staff.onShift &&
      !staff.sick &&
      (role === undefined ? staff.role !== "technician" : staff.role === role)
        ? staff.fte
        : 0),
    0,
  );
}

/** Stable copy of a role's current pool; used for snapshots and diagnostics. */
export function staffForRole(workforce, role) {
  requireWorkforce(workforce);
  const ids = workforce.staffByRole.get(role);
  if (ids === undefined) return [];
  return workforce.staff.filter((staff) => ids.has(staff.id));
}
