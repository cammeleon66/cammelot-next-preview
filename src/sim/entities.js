/**
 * Plain, frozen domain records (SIMULATION_SPEC §4). Constructors validate and copy; they
 * never advance state.
 */

const ACUITIES = Object.freeze(["routine", "urgent"]);

function requireSimId(id, label) {
  const valid =
    (typeof id === "string" && id.length > 0) || (Number.isSafeInteger(id) && id >= 0);
  if (!valid) throw new TypeError(`${label} must be a non-empty string or non-negative safe integer`);
}

function requireObject(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("data must be an object");
  }
}

/**
 * Attributes are drawn by the caller from the patient's indexed `acuity` stream at arrival.
 * @param {{ id: string|number, cohortId?: string, acuity: 'routine'|'urgent', needsReferral: boolean, needsDiagnostics: boolean, createdAt: number }} data
 */
export function createPatient(data) {
  requireObject(data);
  requireSimId(data.id, "id");
  if (!ACUITIES.includes(data.acuity)) throw new RangeError("acuity must be 'routine' or 'urgent'");
  if (!Number.isSafeInteger(data.createdAt) || data.createdAt < 0) {
    throw new RangeError("createdAt must be a non-negative safe integer minute");
  }
  if (typeof data.needsReferral !== "boolean" || typeof data.needsDiagnostics !== "boolean") {
    throw new TypeError("needsReferral and needsDiagnostics must be booleans");
  }
  return Object.freeze({
    id: data.id,
    cohortId: data.cohortId ?? data.acuity,
    acuity: data.acuity,
    needsReferral: data.needsReferral,
    needsDiagnostics: data.needsDiagnostics,
    createdAt: data.createdAt,
  });
}

export function createReferral(data) {
  throw new Error('NotImplemented: createReferral');
}

export function createStaffMember(data) {
  requireObject(data);
  requireSimId(data.id, "staff id");
  if (typeof data.role !== "string" || data.role.length === 0) {
    throw new TypeError("role must be a non-empty string");
  }
  const fte = data.fte ?? 1;
  if (typeof fte !== "number" || !Number.isFinite(fte) || fte <= 0) {
    throw new RangeError("fte must be a positive finite number");
  }
  if (data.assignedArea !== undefined && data.assignedArea !== null) {
    requireSimId(data.assignedArea, "assignedArea");
  }
  if (data.onShift !== undefined && typeof data.onShift !== "boolean") {
    throw new TypeError("onShift must be a boolean");
  }
  if (data.sick !== undefined && typeof data.sick !== "boolean") {
    throw new TypeError("sick must be a boolean");
  }
  return Object.freeze({
    id: data.id,
    role: data.role,
    fte,
    assignedArea: data.assignedArea ?? null,
    onShift: data.onShift ?? true,
    sick: data.sick ?? false,
  });
}

/**
 * Validated copy of a scenario area definition.
 * @param {{ id: string|number, label?: string, servers: number, rooms?: number|null,
 *   equipment?: number|null, staffRole?: string, construction?: object,
 *   outageProbability?: number, maintenanceProbability?: number,
 *   maintenanceDowntimeMinutes?: number, serviceTime: { mean: number, cv: number },
 *   hours?: { days: number[], startMinute: number, endMinute: number } }} data
 */
export function createArea(data) {
  requireObject(data);
  requireSimId(data.id, "area id");
  if (!Number.isSafeInteger(data.servers) || data.servers < 0) {
    throw new RangeError("servers must be a non-negative safe integer");
  }
  const time = data.serviceTime;
  if (!time || !(time.mean > 0) || !(time.cv >= 0)) {
    throw new RangeError("serviceTime must have mean > 0 and cv >= 0");
  }
  const area = {
    id: data.id,
    label: data.label ?? String(data.id),
    servers: data.servers,
    rooms: data.rooms ?? null,
    equipment: data.equipment ?? null,
    serviceTime: Object.freeze({ mean: time.mean, cv: time.cv }),
  };
  if (data.staffRole !== undefined) area.staffRole = data.staffRole;
  if (data.construction !== undefined) {
    area.construction = Object.freeze({ ...data.construction });
  }
  if (data.outageProbability !== undefined) area.outageProbability = data.outageProbability;
  if (data.maintenanceProbability !== undefined) area.maintenanceProbability = data.maintenanceProbability;
  if (data.maintenanceDowntimeMinutes !== undefined) {
    area.maintenanceDowntimeMinutes = data.maintenanceDowntimeMinutes;
  }
  if (data.hours !== undefined) {
    area.hours = Object.freeze({
      days: Object.freeze([...data.hours.days]),
      startMinute: data.hours.startMinute,
      endMinute: data.hours.endMinute,
    });
  }
  return Object.freeze(area);
}

export function createOrganisation(data) {
  throw new Error('NotImplemented: createOrganisation');
}
