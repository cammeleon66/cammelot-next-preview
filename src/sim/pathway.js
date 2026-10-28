/**
 * Care pathway state machine (SIMULATION_SPEC §5).
 *
 * Pathways are immutable plain data: `transitionPatient` returns a new frozen
 * pathway. The module records stages and timestamps only; the engine decides
 * which branch a patient takes (referral, diagnostics, rework) from its own
 * draws, so no clinical outcome is inferred here.
 *
 * @typedef {string|number} SimId
 * @typedef {{ stage: string, enteredAt: number }} PathwayEntry
 * @typedef {{
 *   patientId: SimId,
 *   stage: string,
 *   enteredAt: number,
 *   timestamps: Readonly<Record<string, number>>,
 *   history: readonly PathwayEntry[],
 *   referralAt?: number,
 *   treatmentAt?: number
 * }} Pathway
 * @typedef {{ time: number, to: string }} PathwayEvent
 */

export const PATHWAY_STAGES = Object.freeze([
  "arrived",
  "gp_queue",
  "gp_consult",
  "referral_transfer",
  "referral_triage",
  "gp_rework",
  "outpatient_queue",
  "outpatient_consult",
  "diagnostics_queue",
  "diagnostics_scan",
  "followup_queue",
  "followup_consult",
  "exited",
  "treatment_started",
  "abandoned",
]);

/** Terminal stages. `exited` and `treatment_started` count as completed; `abandoned` is a failed outcome. */
export const TERMINAL_STAGES = Object.freeze(["exited", "treatment_started", "abandoned"]);

/** Non-service waiting/transfer stages after referral creation, from which a patient may abandon. */
const ABANDONABLE_STAGES = Object.freeze([
  "referral_transfer",
  "referral_triage",
  "gp_rework",
  "outpatient_queue",
  "diagnostics_queue",
  "followup_queue",
]);

const FORWARD = {
  arrived: ["gp_queue"],
  gp_queue: ["gp_consult"],
  gp_consult: ["exited", "referral_transfer"],
  referral_transfer: ["referral_triage"],
  referral_triage: ["gp_rework", "outpatient_queue"],
  gp_rework: ["referral_transfer"],
  outpatient_queue: ["outpatient_consult"],
  outpatient_consult: ["diagnostics_queue", "treatment_started"],
  diagnostics_queue: ["diagnostics_scan"],
  diagnostics_scan: ["followup_queue"],
  followup_queue: ["followup_consult"],
  followup_consult: ["treatment_started"],
  exited: [],
  treatment_started: [],
  abandoned: [],
};

const TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(FORWARD).map(([stage, next]) => [
      stage,
      Object.freeze(ABANDONABLE_STAGES.includes(stage) ? [...next, "abandoned"] : next),
    ]),
  ),
);

function requireSimId(id, label) {
  const valid =
    (typeof id === "string" && id.length > 0) || (Number.isSafeInteger(id) && id >= 0);
  if (!valid) {
    throw new TypeError(`${label} must be a non-empty string or non-negative safe integer`);
  }
}

function requireTime(time, label) {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer minute`);
  }
}

/** @param {string} stage @returns {boolean} */
export function isTerminalStage(stage) {
  return TERMINAL_STAGES.includes(stage);
}

/**
 * Stages a patient may enter next from `stage`.
 * @param {string} stage
 * @returns {readonly string[]}
 */
export function allowedTransitions(stage) {
  if (!Object.hasOwn(TRANSITIONS, stage)) {
    throw new RangeError(`unknown pathway stage: ${String(stage)}`);
  }
  return TRANSITIONS[stage];
}

function build(patientId, history, referralAt, treatmentAt) {
  const timestamps = {};
  for (const entry of history) timestamps[entry.stage] = entry.enteredAt;
  const last = history[history.length - 1];
  const pathway = {
    patientId,
    stage: last.stage,
    enteredAt: last.enteredAt,
    timestamps: Object.freeze(timestamps),
    history: Object.freeze(history.map((entry) => Object.freeze({ ...entry }))),
  };
  if (referralAt !== undefined) pathway.referralAt = referralAt;
  if (treatmentAt !== undefined) pathway.treatmentAt = treatmentAt;
  return Object.freeze(pathway);
}

/**
 * Create a pathway in the `arrived` stage.
 * `timestamps[stage]` holds the most recent entry time for that stage;
 * `history` keeps every entry, so rework loops stay auditable.
 * @param {SimId} patientId
 * @param {number} [createdAt] simulated minute of arrival (engine passes the arrival time)
 * @returns {Pathway}
 */
export function createPathway(patientId, createdAt = 0) {
  requireSimId(patientId, "patientId");
  requireTime(createdAt, "createdAt");
  return build(patientId, [{ stage: "arrived", enteredAt: createdAt }]);
}

/**
 * Move a patient to `event.to` at `event.time`. Returns a new pathway; the input is unchanged.
 * `referralAt` is set on the first entry to `referral_transfer` and never reset by rework
 * loops; `treatmentAt` is set on entering `treatment_started`.
 * @param {Pathway} pathway
 * @param {PathwayEvent} event
 * @returns {Pathway}
 */
export function transitionPatient(pathway, event) {
  if (!pathway || typeof pathway !== "object" || !Array.isArray(pathway.history)) {
    throw new TypeError("pathway must be created by createPathway");
  }
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  requireTime(event.time, "event.time");
  if (event.time < pathway.enteredAt) {
    throw new RangeError(
      `event.time ${event.time} is earlier than the current stage entry ${pathway.enteredAt}`,
    );
  }
  const allowed = allowedTransitions(pathway.stage);
  if (typeof event.to !== "string" || !allowed.includes(event.to)) {
    throw new RangeError(
      `invalid pathway transition ${pathway.stage} -> ${String(event.to)}; allowed: ${allowed.join(", ") || "none (terminal)"}`,
    );
  }
  const referralAt =
    pathway.referralAt === undefined && event.to === "referral_transfer"
      ? event.time
      : pathway.referralAt;
  const treatmentAt = event.to === "treatment_started" ? event.time : pathway.treatmentAt;
  return build(
    pathway.patientId,
    [...pathway.history, { stage: event.to, enteredAt: event.time }],
    referralAt,
    treatmentAt,
  );
}
