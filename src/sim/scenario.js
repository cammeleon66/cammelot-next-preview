/**
 * @typedef {'SOURCED'|'CALIBRATED'|'SIMPLIFICATION'|'BALANCE'|'HYPOTHETICAL'|'assumption'} Provenance
 * @typedef {{ value: unknown, provenance: Provenance, source?: { id: string, url: string, title?: string, verified: boolean }, method?: string, rationale?: string }} ProvenancedValue
 * @typedef {{ value: number, provenance: 'assumption', rationale?: string }} AbandonmentExtraWeeks
 * @typedef {{ abandonmentExtraWeeks?: AbandonmentExtraWeeks, [key: string]: ProvenancedValue|AbandonmentExtraWeeks }} ScenarioParameters
 * @typedef {{ id: string, version: string, schemaVersion: number, title: string, description: string, parameters: Readonly<ScenarioParameters>, initialState: { patients?: readonly object[], staff?: readonly object[], areas: readonly object[], fundingSources?: readonly object[], infrastructure?: readonly object[] }, interventions?: readonly import('./engine.js').InterventionDef[] }} ScenarioDef
 */

const PROVENANCE_TAGS = Object.freeze([
  "SOURCED",
  "CALIBRATED",
  "SIMPLIFICATION",
  "BALANCE",
  "HYPOTHETICAL",
  "assumption",
]);

/** Default added beyond the fixed 12-week Treeknorm when `abandonmentExtraWeeks` is omitted. */
export const DEFAULT_ABANDONMENT_EXTRA_WEEKS = 12;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isSimId = (value) => isNonEmptyString(value) || (Number.isSafeInteger(value) && value >= 0);
const isFraction = (value) => typeof value === "number" && value >= 0 && value <= 1;
const isNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isPositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Domain of each engine-required parameter. Presence is enforced by the engine that consumes it;
 * when a parameter is present its value must be in this domain.
 */
const PARAMETER_DOMAINS = Object.freeze({
  treeknormWeeks: [isPositive, "a positive finite number"],
  arrivalsPerWeek: [isNonNegative, "a non-negative finite number"],
  pUrgent: [isFraction, "a number in [0, 1]"],
  pReferral: [isFraction, "a number in [0, 1]"],
  pDiagnostics: [isFraction, "a number in [0, 1]"],
  gpReworkMeanMinutes: [isPositive, "a positive finite number"],
  followupMeanMinutes: [isPositive, "a positive finite number"],
  staffSicknessProbability: [isFraction, "a number in [0, 1]"],
  recruitmentSuccessProbability: [isFraction, "a number in [0, 1]"],
  burnoutHazardMultiplierAboveRho: [
    (value) => isPositive(value) && value >= 1,
    "a finite number >= 1",
  ],
});
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** Provenance tag plus source requirements shared by parameters, areas and edges. */
function checkProvenance(entry, label, errors) {
  if (!PROVENANCE_TAGS.includes(entry.provenance)) {
    errors.push(`${label}: provenance must be one of ${PROVENANCE_TAGS.join(", ")}`);
    return;
  }
  if (entry.provenance !== "SOURCED") return;
  const source = entry.source;
  if (!isRecord(source) || !isNonEmptyString(source.id) || !isNonEmptyString(source.url)) {
    errors.push(`${label}: SOURCED requires source { id, url, verified }`);
  } else if (typeof source.verified !== "boolean") {
    errors.push(`${label}: source.verified must be a boolean`);
  }
}

function checkHours(hours, label, errors) {
  if (hours === undefined) return;
  const valid =
    isRecord(hours) &&
    Array.isArray(hours.days) &&
    hours.days.length > 0 &&
    hours.days.every((day) => Number.isSafeInteger(day) && day >= 0 && day <= 6) &&
    Number.isSafeInteger(hours.startMinute) &&
    Number.isSafeInteger(hours.endMinute) &&
    hours.startMinute >= 0 &&
    hours.startMinute < hours.endMinute &&
    hours.endMinute <= 1440;
  if (!valid) errors.push(`${label}.hours: expected { days: 0..6[], startMinute < endMinute <= 1440 }`);
}

function checkArea(area, index, errors) {
  const label = `initialState.areas[${index}]`;
  if (!isRecord(area)) {
    errors.push(`${label}: must be an object`);
    return;
  }
  if (!isSimId(area.id)) errors.push(`${label}.id: must be a non-empty string or non-negative safe integer`);
  checkProvenance(area, label, errors);
  if (!isCount(area.servers)) errors.push(`${label}.servers: must be a non-negative integer`);
  for (const key of ["rooms", "equipment"]) {
    if (area[key] !== undefined && area[key] !== null && !isCount(area[key])) {
      errors.push(`${label}.${key}: must be a non-negative integer when present`);
    }
  }
  if (area.staffRole !== undefined && !isNonEmptyString(area.staffRole)) {
    errors.push(`${label}.staffRole: must be a non-empty string when present`);
  }
  for (const key of ["outageProbability", "maintenanceProbability"]) {
    if (area[key] !== undefined && !isFraction(area[key])) {
      errors.push(`${label}.${key}: must be a number in [0, 1] when present`);
    }
  }
  if (
    area.maintenanceDowntimeMinutes !== undefined &&
    (!Number.isSafeInteger(area.maintenanceDowntimeMinutes) || area.maintenanceDowntimeMinutes <= 0)
  ) {
    errors.push(`${label}.maintenanceDowntimeMinutes: must be a positive safe integer when present`);
  }
  if (area.construction !== undefined) {
    const construction = area.construction;
    if (!isRecord(construction)) {
      errors.push(`${label}.construction: must be an object`);
    } else {
      if (!Number.isSafeInteger(construction.completesAt) || construction.completesAt < 0) {
        errors.push(`${label}.construction.completesAt: must be a non-negative safe integer minute`);
      }
      let addsCapacity = false;
      for (const key of ["rooms", "equipment"]) {
        if (construction[key] !== undefined) {
          if (!isCount(construction[key])) {
            errors.push(`${label}.construction.${key}: must be a non-negative integer`);
          } else if (construction[key] > 0) {
            addsCapacity = true;
          }
        }
      }
      if (!addsCapacity) errors.push(`${label}.construction: must add rooms or equipment capacity`);
      if (construction.technicianRole !== undefined && !isNonEmptyString(construction.technicianRole)) {
        errors.push(`${label}.construction.technicianRole: must be a non-empty string when present`);
      }
    }
  }
  const time = area.serviceTime;
  if (!isRecord(time) || !(time.mean > 0) || !Number.isFinite(time.mean) || !(time.cv >= 0) || !Number.isFinite(time.cv)) {
    errors.push(`${label}.serviceTime: expected { mean > 0, cv >= 0 }`);
  }
  checkHours(area.hours, label, errors);
}

function checkEdge(edge, index, errors) {
  const label = `initialState.infrastructure[${index}]`;
  if (!isRecord(edge)) {
    errors.push(`${label}: must be an object`);
    return;
  }
  if (!isSimId(edge.id)) errors.push(`${label}.id: must be a non-empty string or non-negative safe integer`);
  checkProvenance(edge, label, errors);
  if (!isFraction(edge.completeness)) errors.push(`${label}.completeness: must be in [0, 1]`);
  if (!isFraction(edge.manualHandoffRate)) errors.push(`${label}.manualHandoffRate: must be in [0, 1]`);
  if (!isFraction(edge.failureRate)) errors.push(`${label}.failureRate: must be in [0, 1]`);
  if (!isCount(edge.latencyMinutes)) errors.push(`${label}.latencyMinutes: must be a non-negative integer`);
}

function checkStaffMember(staff, index, areas, errors) {
  const label = `initialState.staff[${index}]`;
  if (!isRecord(staff)) {
    errors.push(`${label}: must be an object`);
    return;
  }
  if (!isSimId(staff.id)) errors.push(`${label}.id: must be a non-empty string or non-negative safe integer`);
  if (!isNonEmptyString(staff.role)) errors.push(`${label}.role: must be a non-empty string`);
  if (staff.fte !== undefined && !isPositive(staff.fte)) {
    errors.push(`${label}.fte: must be a positive finite number when present`);
  }
  if (staff.assignedArea !== undefined && staff.assignedArea !== null) {
    if (!isSimId(staff.assignedArea)) {
      errors.push(`${label}.assignedArea: must be null or a valid area id`);
    } else {
      const area = Array.isArray(areas)
        ? areas.find((candidate) => candidate?.id === staff.assignedArea)
        : undefined;
      if (area === undefined) {
        errors.push(`${label}.assignedArea: must reference an initialState area`);
      }
    }
  }
  for (const key of ["onShift", "sick"]) {
    if (staff[key] !== undefined && typeof staff[key] !== "boolean") {
      errors.push(`${label}.${key}: must be a boolean when present`);
    }
  }
}

/**
 * Check shape, provenance and source requirements (SIMULATION_SPEC §1). Does not mutate the
 * definition and does not invent defaults; whether a given engine-required parameter exists
 * is checked by the engine that consumes it.
 * @param {ScenarioDef} definition
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateScenario(definition) {
  const errors = [];
  if (!isRecord(definition)) return { ok: false, errors: ["scenario must be an object"] };
  for (const key of ["id", "version", "title", "description"]) {
    if (!isNonEmptyString(definition[key])) errors.push(`${key}: must be a non-empty string`);
  }
  if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
    errors.push("schemaVersion: must be a positive integer");
  }

  if (!isRecord(definition.parameters)) {
    errors.push("parameters: must be an object");
  } else {
    for (const [name, entry] of Object.entries(definition.parameters)) {
      const label = `parameters.${name}`;
      if (!isRecord(entry) || !Object.hasOwn(entry, "value")) {
        errors.push(`${label}: must be { value, provenance }`);
        continue;
      }
      checkProvenance(entry, label, errors);
      const domain = Object.hasOwn(PARAMETER_DOMAINS, name) ? PARAMETER_DOMAINS[name] : undefined;
      if (domain !== undefined && !domain[0](entry.value)) errors.push(`${label}: value must be ${domain[1]}`);
    }
    const recruitmentDelay = definition.parameters.recruitmentDelayQuarters?.value;
    if (recruitmentDelay !== undefined) {
      if (
        !isRecord(recruitmentDelay) ||
        !isPositive(recruitmentDelay.min) ||
        !isPositive(recruitmentDelay.max) ||
        recruitmentDelay.min < 1 ||
        recruitmentDelay.max > 2 ||
        recruitmentDelay.min > recruitmentDelay.max
      ) {
        errors.push("parameters.recruitmentDelayQuarters: value must have 1 <= min <= max <= 2");
      }
      if (
        isRecord(recruitmentDelay) &&
        recruitmentDelay.probability !== undefined &&
        !isFraction(recruitmentDelay.probability)
      ) {
        errors.push("parameters.recruitmentDelayQuarters: probability must be a number in [0, 1]");
      }
    }
    const extra = definition.parameters.abandonmentExtraWeeks;
    if (extra !== undefined && isRecord(extra)) {
      if (extra.provenance !== "assumption") {
        errors.push("parameters.abandonmentExtraWeeks: provenance must be the literal 'assumption'");
      }
      if (!(typeof extra.value === "number" && Number.isFinite(extra.value) && extra.value >= 0)) {
        errors.push("parameters.abandonmentExtraWeeks: value must be a non-negative number");
      }
    }
  }

  const state = definition.initialState;
  if (!isRecord(state)) {
    errors.push("initialState: must be an object");
  } else {
    if (!Array.isArray(state.areas) || state.areas.length === 0) {
      errors.push("initialState.areas: must be a non-empty array");
    } else {
      state.areas.forEach((area, index) => checkArea(area, index, errors));
      const ids = state.areas.map((area) => area?.id);
      if (new Set(ids).size !== ids.length) errors.push("initialState.areas: ids must be unique");
    }
    for (const key of ["patients", "staff", "fundingSources", "infrastructure"]) {
      if (state[key] !== undefined && !Array.isArray(state[key])) errors.push(`initialState.${key}: must be an array`);
    }
    if (Array.isArray(state.infrastructure)) {
      state.infrastructure.forEach((edge, index) => checkEdge(edge, index, errors));
    }
    if (Array.isArray(state.staff)) {
      state.staff.forEach((staff, index) => checkStaffMember(staff, index, state.areas ?? [], errors));
      const ids = state.staff.map((staff) => staff?.id);
      if (new Set(ids).size !== ids.length) errors.push("initialState.staff: ids must be unique");
    }
  }
  if (definition.interventions !== undefined && !Array.isArray(definition.interventions)) {
    errors.push("interventions: must be an array");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Canonical JSON: object keys sorted recursively, array order preserved, no whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (isRecord(value)) {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

/**
 * @param {ScenarioDef} definition
 * @param {(canonicalJson: string) => string} sha256 injected pure-JavaScript SHA-256 (hex)
 * @returns {string}
 */
export function hashScenario(definition, sha256) {
  if (typeof sha256 !== "function") throw new TypeError("sha256 must be an injected function");
  return sha256(canonicalJson(definition));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate and return a deep-frozen canonical copy of the definition (round-tripped through
 * canonical JSON, so loading is idempotent and hashing the result equals hashing the input).
 * @param {ScenarioDef} definition
 * @returns {Readonly<ScenarioDef>}
 */
export function loadScenario(definition) {
  const { ok, errors } = validateScenario(definition);
  if (!ok) throw new TypeError(`invalid scenario:\n- ${errors.join("\n- ")}`);
  return deepFreeze(JSON.parse(canonicalJson(definition)));
}
