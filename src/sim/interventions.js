/**
 * Typed interventions (SIMULATION_SPEC §10). Effects change mechanism parameters only — staffed
 * seats, rooms, equipment, information-edge completeness and latency — never waits, outcomes or
 * metrics. Each effect belongs to a phase: `implementation` (fixed delay, then adoption ramp) or
 * `recruitment` (workforce recruitment delay; may fail). Costs post to the funding ledger: one-off
 * costs at commitment, recurring costs each quarter from their phase's activation.
 *
 * @typedef {import('./scenario.js').ScenarioDef} ScenarioDef
 * @typedef {import('./engine.js').Decision} Decision
 * @typedef {import('./engine.js').InterventionDef} InterventionDef
 */
import { MINUTES_PER_DAY } from "./clock.js";
import { costIssue, isRecurringCategory } from "./funding.js";

export const INTERVENTION_TYPES = Object.freeze(["staff", "facility", "integration", "workflow", "agent"]);
export const PHASES = Object.freeze(["implementation", "recruitment"]);
/** The only parameters an effect may touch, by target kind; `count` values stay whole and >= 0. */
export const MECHANISM_PARAMS = Object.freeze({
  area: Object.freeze({ servers: "count", rooms: "count", equipment: "count" }),
  edge: Object.freeze({ completeness: "fraction", latencyMinutes: "count" }),
});
const OPS = Object.freeze({
  set: (base, value) => value,
  add: (base, value) => base + value,
  mul: (base, value) => base * value,
});
const PRECONDITIONS = Object.freeze(["once"]);
const FULL_ADOPTION = Object.freeze({ start: 1, end: 1, rampDays: 0 });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFraction = (value) => typeof value === "number" && value >= 0 && value <= 1;

/** Split `area:<id>` / `edge:<id>` targets. */
export function parseTarget(target) {
  const match = typeof target === "string" ? /^(area|edge):(.+)$/.exec(target) : null;
  return match === null ? null : { kind: match[1], id: match[2] };
}

/** Definition with the chosen variant's overrides; the first variant is the default. Null if unknown. */
export function resolveVariant(definition, variantId) {
  const variants = definition.variants ?? [];
  if (variants.length === 0) return variantId === undefined ? definition : null;
  const variant = variantId === undefined ? variants[0] : variants.find((candidate) => candidate.id === variantId);
  if (variant === undefined) return null;
  const { variants: _omit, ...base } = definition;
  return { ...base, ...variant, id: definition.id, variant: variant.id };
}

function checkResolved(def, scenario, label, errors) {
  const sources = new Map((scenario.initialState.fundingSources ?? []).map((source) => [source.id, source]));
  const areas = new Map(scenario.initialState.areas.map((area) => [String(area.id), area]));
  const edges = new Map((scenario.initialState.infrastructure ?? []).map((edge) => [String(edge.id), edge]));
  if (!INTERVENTION_TYPES.includes(def.type)) errors.push(`${label}.type: must be one of ${INTERVENTION_TYPES.join(", ")}`);
  if (!Number.isSafeInteger(def.implementationDelayDays) || def.implementationDelayDays < 0) {
    errors.push(`${label}.implementationDelayDays: must be a non-negative safe integer`);
  }
  const adoption = def.adoption;
  if (!isRecord(adoption) || !isFraction(adoption.start) || !isFraction(adoption.end) ||
      !Number.isSafeInteger(adoption.rampDays) || adoption.rampDays < 0) {
    errors.push(`${label}.adoption: expected { start, end in [0, 1], rampDays >= 0 }`);
  }
  const phaseOf = (item) => item.phase ?? "implementation";
  for (const [index, cost] of (Array.isArray(def.costs) ? def.costs : []).entries()) {
    const at = `${label}.costs[${index}]`;
    if (!Number.isSafeInteger(cost?.amount) || cost.amount <= 0) errors.push(`${at}.amount: must be a positive whole-euro integer`);
    if (!PHASES.includes(phaseOf(cost ?? {}))) errors.push(`${at}.phase: must be one of ${PHASES.join(", ")}`);
    const issue = costIssue(sources.get(cost?.sourceId), cost ?? {}, def.type);
    if (issue !== null) errors.push(`${at}: ${issue} for source ${String(cost?.sourceId)}`);
  }
  if (!Array.isArray(def.costs)) errors.push(`${label}.costs: must be an array`);
  if (!Array.isArray(def.effects) || def.effects.length === 0) {
    errors.push(`${label}.effects: must be a non-empty array`);
    return;
  }
  for (const [index, effect] of def.effects.entries()) {
    const at = `${label}.effects[${index}]`;
    const target = parseTarget(effect?.target);
    const kind = target === null ? undefined : MECHANISM_PARAMS[target.kind][effect.param];
    if (kind === undefined) {
      errors.push(`${at}: ${String(effect?.target)}.${String(effect?.param)} is not a mechanism parameter; effects may not target outcomes or metrics`);
      continue;
    }
    const record = target.kind === "area" ? areas.get(target.id) : edges.get(target.id);
    if (record === undefined) errors.push(`${at}.target: unknown ${target.kind} ${target.id}`);
    if (!Object.hasOwn(OPS, effect.op) || !Number.isFinite(effect.value)) errors.push(`${at}: op must be set/add/mul with a finite value`);
    if (!PHASES.includes(phaseOf(effect))) errors.push(`${at}.phase: must be one of ${PHASES.join(", ")}`);
    if (kind === "count") {
      if (effect.op !== "add" || !Number.isSafeInteger(effect.value)) errors.push(`${at}: count parameters change by whole-number add only`);
      if (phaseOf(effect) === "implementation" && isRecord(adoption) && (adoption.start !== 1 || adoption.end !== 1)) {
        errors.push(`${at}: count parameters cannot ramp; adoption must start and end at 1`);
      }
      if (target.kind === "area" && effect.param !== "servers" && record !== undefined && typeof record[effect.param] !== "number") {
        errors.push(`${at}: cannot add to unbounded ${effect.param}; declare the area's ${effect.param} first`);
      }
      if (effect.param === "servers" && scenario.initialState.staff !== undefined) {
        errors.push(`${at}: servers is superseded by the staff roster in this scenario; use workforce commands`);
      }
    }
  }
  const keys = def.effects.map((effect) => `${effect?.target}.${effect?.param}`);
  if (new Set(keys).size !== keys.length) errors.push(`${label}.effects: each mechanism parameter may appear once`);
  const phases = new Set(def.effects.map(phaseOf));
  for (const cost of Array.isArray(def.costs) ? def.costs : []) {
    if (isRecurringCategory(String(cost?.category)) && !phases.has(phaseOf(cost ?? {}))) {
      errors.push(`${label}: recurring cost in phase ${phaseOf(cost)} has no effect to start it`);
    }
  }
}

/**
 * Check an intervention definition (and every variant) against the scenario it will run in.
 * @param {InterventionDef} definition @param {ScenarioDef} scenario
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateIntervention(definition, scenario) {
  const errors = [];
  if (!isRecord(definition) || typeof definition.id !== "string" || definition.id.length === 0) {
    return { ok: false, errors: ["intervention: must be an object with a non-empty string id"] };
  }
  const label = `interventions.${definition.id}`;
  if (definition.preconditions !== undefined &&
      !(Array.isArray(definition.preconditions) && definition.preconditions.every((p) => PRECONDITIONS.includes(p)))) {
    errors.push(`${label}.preconditions: supported values are ${PRECONDITIONS.join(", ")}`);
  }
  const variants = definition.variants ?? [];
  if (!Array.isArray(variants)) errors.push(`${label}.variants: must be an array when present`);
  else if (new Set(variants.map((variant) => variant?.id)).size !== variants.length) {
    errors.push(`${label}.variants: ids must be unique`);
  }
  if (Array.isArray(variants) && variants.length > 0) {
    for (const variant of variants) {
      if (typeof variant?.id !== "string" || variant.id.length === 0) errors.push(`${label}.variants: each needs a string id`);
      else checkResolved(resolveVariant(definition, variant.id), scenario, `${label}[${variant.id}]`, errors);
    }
  } else {
    checkResolved(definition, scenario, label, errors);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Plan a committed (resolved) intervention: one-off costs due now, and per-phase effects and
 * recurring costs. `time` is the decision's effective minute. The recruitment phase's time and
 * success are drawn by the engine from the `recruitment` stream.
 * @param {InterventionDef} definition @param {Decision} decision @param {number} time
 */
export function scheduleIntervention(definition, decision, time) {
  const withType = (cost) => ({ ...cost, interventionType: definition.type, interventionId: definition.id, decisionId: decision.id });
  const inPhase = (phase) => (item) => (item.phase ?? "implementation") === phase;
  const phases = PHASES.map((phase) => ({
    phase,
    at: phase === "implementation" ? time + definition.implementationDelayDays * MINUTES_PER_DAY : null,
    adoption: phase === "implementation" ? definition.adoption : FULL_ADOPTION,
    effects: definition.effects.filter(inPhase(phase)),
    recurringCosts: definition.costs.filter((cost) => isRecurringCategory(cost.category)).filter(inPhase(phase)).map(withType),
    status: "scheduled",
    activatedAt: null,
    bases: [],
    applied: [],
  })).filter((phase) => phase.effects.length > 0);
  return {
    decisionId: decision.id,
    interventionId: definition.id,
    variant: definition.variant ?? null,
    type: definition.type,
    effectiveAt: time,
    oneOffCosts: definition.costs.filter((cost) => !isRecurringCategory(cost.category)).map(withType),
    phases,
  };
}

/** Adoption fraction of a phase at `time` (linear ramp from `start` to `end` over `rampDays`). */
export function adoptionAt(adoption, activatedAt, time) {
  if (adoption.rampDays === 0) return adoption.end;
  const progress = Math.min(1, Math.max(0, (time - activatedAt) / (adoption.rampDays * MINUTES_PER_DAY)));
  return adoption.start + (adoption.end - adoption.start) * progress;
}

/**
 * Move each mechanism parameter of an active phase to `base + (op(base) - base) * adoption(time)`,
 * where `base` is captured at activation. Only this phase's own contribution changes, so phases
 * on the same parameter compose. Nothing is written if any value would leave its domain.
 * @param {{ get: (target: string, param: string) => number, set: (target: string, param: string, value: number) => void }} state
 * @param {ReturnType<typeof scheduleIntervention>['phases'][number]} intervention phase runtime
 * @param {number} time
 * @returns {{ ok: true, adoption: number }|{ ok: false, reasonCode: string }}
 */
export function applyIntervention(state, intervention, time) {
  const adoption = adoptionAt(intervention.adoption, intervention.activatedAt, time);
  const updates = intervention.effects.map((effect, index) => {
    const current = state.get(effect.target, effect.param);
    const base = intervention.bases[index] ?? current;
    const kind = MECHANISM_PARAMS[parseTarget(effect.target).kind][effect.param];
    let delta = (OPS[effect.op](base, effect.value) - base) * adoption;
    if (kind === "count") delta = Math.round(delta);
    return { effect, base, delta, value: current - (intervention.applied[index] ?? 0) + delta, kind };
  });
  for (const update of updates) {
    const valid = update.kind === "count" ? Number.isSafeInteger(update.value) && update.value >= 0 : isFraction(update.value);
    if (!valid) return { ok: false, reasonCode: "MECHANISM_OUT_OF_RANGE" };
  }
  updates.forEach((update, index) => {
    intervention.bases[index] = update.base;
    state.set(update.effect.target, update.effect.param, update.value);
    intervention.applied[index] = update.delta;
  });
  return { ok: true, adoption };
}
