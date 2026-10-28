/** Deterministic replay, comparison, and aggregate-only RunLog interchange. */
import { createSim } from "./engine.js";
import { canonicalJson } from "./scenario.js";
import { sha256Hex } from "./sha256.js";

const EXPORT_FORMAT = "cammelot-run-log";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const taggedSeed = (seed) => `${typeof seed}:${String(seed)}`;

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRunLog(runLog) {
  if (!isRecord(runLog) || runLog.schemaVersion !== 1) {
    throw new TypeError("RunLog must have schemaVersion 1");
  }
  if (
    !isRecord(runLog.scenario) ||
    typeof runLog.scenario.id !== "string" ||
    typeof runLog.scenario.version !== "string" ||
    !Number.isSafeInteger(runLog.scenario.schemaVersion) ||
    typeof runLog.scenario.sha256 !== "string"
  ) {
    throw new TypeError("RunLog has an invalid scenario identity");
  }
  if (typeof runLog.engineVersion !== "string" || runLog.engineVersion.length === 0) {
    throw new TypeError("RunLog has an invalid engine version");
  }
  if (
    !(typeof runLog.seed === "string" && runLog.seed.length > 0) &&
    !(Number.isSafeInteger(runLog.seed))
  ) {
    throw new TypeError("RunLog seed must be a string or safe integer");
  }
  if (!Number.isSafeInteger(runLog.finalTime) || runLog.finalTime < 0) {
    throw new TypeError("RunLog finalTime must be a non-negative safe integer");
  }
  if (!isRecord(runLog.finalOutcomes) || !isRecord(runLog.finalMetrics)) {
    throw new TypeError("RunLog must contain aggregate outcomes and metrics");
  }
  for (const [name, value] of Object.entries(runLog.finalOutcomes)) {
    if (!isFiniteNumber(value)) throw new TypeError(`RunLog outcome ${name} must be finite`);
  }
  for (const [name, value] of Object.entries(runLog.finalMetrics)) {
    if (!isFiniteNumber(value)) throw new TypeError(`RunLog metric ${name} must be finite`);
  }
  if (!Array.isArray(runLog.decisions)) throw new TypeError("RunLog decisions must be an array");
  let previousAt = -1;
  for (const [index, entry] of runLog.decisions.entries()) {
    if (
      !isRecord(entry) ||
      !Object.hasOwn(entry, "decision") ||
      !Number.isSafeInteger(entry.at) ||
      entry.at < previousAt ||
      !["queued", "applied", "rejected"].includes(entry.status)
    ) {
      throw new TypeError(`RunLog decision ${index} must be an ordered decision entry`);
    }
    previousAt = entry.at;
  }
  if (runLog.finalResources !== undefined) {
    if (!Array.isArray(runLog.finalResources)) throw new TypeError("RunLog finalResources must be an array");
    for (const resource of runLog.finalResources) {
      if (!isRecord(resource) || !["string", "number"].includes(typeof resource.areaId)) {
        throw new TypeError("RunLog resource has an invalid areaId");
      }
      for (const key of ["queueLength", "inService", "capacity", "utilisation"]) {
        if (!isFiniteNumber(resource[key])) throw new TypeError(`RunLog resource ${key} must be finite`);
      }
      for (const key of ["meanWaitMinutes", "medianWaitMinutes"]) {
        if (resource[key] !== undefined && !isFiniteNumber(resource[key])) {
          throw new TypeError(`RunLog resource ${key} must be finite when present`);
        }
      }
    }
  }
  if (runLog.finalSnapshotHash !== undefined && !/^[0-9a-f]{64}$/.test(runLog.finalSnapshotHash)) {
    throw new TypeError("RunLog finalSnapshotHash must be a SHA-256 hex digest");
  }
  if (runLog.events !== undefined && !Array.isArray(runLog.events)) {
    throw new TypeError("RunLog events must be an array when present");
  }
  return runLog;
}

function comparisonMetrics(runLog) {
  const metrics = {};
  for (const [name, value] of Object.entries(runLog.finalOutcomes)) metrics[`system.${name}`] = value;
  for (const [name, value] of Object.entries(runLog.finalMetrics)) metrics[`system.${name}`] = value;
  for (const resource of runLog.finalResources ?? []) {
    const prefix = `local.${String(resource.areaId)}.`;
    for (const name of ["queueLength", "inService", "capacity", "utilisation", "meanWaitMinutes", "medianWaitMinutes"]) {
      if (resource[name] !== undefined) metrics[prefix + name] = resource[name];
    }
  }
  return metrics;
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * fraction;
}

function aggregateDecision(entry) {
  const { decision, ...metadata } = entry;
  if (!isRecord(decision)) return { ...metadata, decision: null };
  const safe = Object.fromEntries(Object.entries(decision).filter(([key, value]) => {
    if (["id", "issuedAt", "interventionId"].includes(key)) return true;
    return key === "parameters" && isRecord(value) && Object.values(value).every((item) =>
      typeof item === "string" || typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)));
  }));
  return { ...metadata, decision: safe };
}

function assertComparable(runLogs, { allowScenarioHashMismatch = false } = {}) {
  const first = assertRunLog(runLogs[0]);
  for (const log of runLogs.slice(1).map(assertRunLog)) {
    if (
      log.scenario.id !== first.scenario.id ||
      log.scenario.schemaVersion !== first.scenario.schemaVersion ||
      (!allowScenarioHashMismatch && log.scenario.sha256 !== first.scenario.sha256) ||
      log.engineVersion !== first.engineVersion ||
      log.finalTime !== first.finalTime
    ) {
      throw new RangeError("RunLogs must use compatible scenario identity, engine version, and final time");
    }
  }
  return first;
}

/** Hashes the complete snapshot; exports retain only this digest. */
export function hashSnapshot(snapshot) {
  return sha256Hex(canonicalJson(snapshot));
}

/** Replays a scenario, seed, and ordered decisions; imported logs verify through the final hash. */
export function replayRunLog(scenario, sourceLog, options = {}) {
  const expected = assertRunLog(sourceLog);
  const sim = createSim(scenario, expected.seed, { sha256: options.sha256 });
  const initialLog = sim.runLog();
  if (
    canonicalJson(initialLog.scenario) !== canonicalJson(expected.scenario) ||
    initialLog.engineVersion !== expected.engineVersion
  ) {
    throw new RangeError("RunLog scenario or engine version does not match this replay");
  }

  for (const entry of expected.decisions) {
    if (entry.at < sim.snapshot().time || entry.at > expected.finalTime) {
      throw new RangeError("RunLog decision time is outside the replay interval");
    }
    sim.runUntil(entry.at);
    const replayed = sim.apply(entry.decision);
    if (
      canonicalJson(replayed.decision) !== canonicalJson(entry.decision) ||
      replayed.status !== entry.status ||
      (replayed.reasonCode ?? null) !== (entry.reasonCode ?? null) ||
      (replayed.effectiveAt ?? null) !== (entry.effectiveAt ?? null)
    ) {
      throw new Error(`RunLog decision ${String(entry.decision?.id)} did not replay identically`);
    }
  }
  sim.runUntil(expected.finalTime);
  const snapshot = sim.snapshot();
  const runLog = sim.runLog();
  const snapshotHash = hashSnapshot(snapshot);
  if (expected.finalSnapshotHash !== undefined && snapshotHash !== expected.finalSnapshotHash) {
    throw new Error("replay snapshot hash does not match the RunLog");
  }
  if (expected.events?.length > 0 && canonicalJson(runLog.events) !== canonicalJson(expected.events)) {
    throw new Error("replay event trace does not match the RunLog");
  }
  return Object.freeze({ exact: true, snapshot, snapshotHash, runLog });
}

/** Serializes decisions, aggregate KPIs, resource totals, and hash; omits entities and events. */
export function exportRunLog(runLog) {
  assertRunLog(runLog);
  const exportable = {
    format: EXPORT_FORMAT,
    schemaVersion: 1,
    scenario: runLog.scenario,
    engineVersion: runLog.engineVersion,
    seed: runLog.seed,
    decisions: runLog.decisions.map(aggregateDecision),
    finalTime: runLog.finalTime,
    finalOutcomes: runLog.finalOutcomes,
    finalMetrics: runLog.finalMetrics,
    finalResources: runLog.finalResources ?? [],
    finalSnapshotHash: runLog.finalSnapshotHash,
  };
  return JSON.stringify(exportable, null, 2);
}

/** Imports an aggregate-only RunLog from JSON text or a parsed object. */
export function importRunLog(input) {
  let record = input;
  if (typeof input === "string") {
    try {
      record = JSON.parse(input);
    } catch {
      throw new TypeError("RunLog import must be valid JSON");
    }
  }
  if (!isRecord(record) || record.format !== EXPORT_FORMAT || record.schemaVersion !== 1) {
    throw new TypeError("unsupported RunLog export format");
  }
  const allowed = new Set([
    "format", "schemaVersion", "scenario", "engineVersion", "seed", "decisions", "finalTime",
    "finalOutcomes", "finalMetrics", "finalResources", "finalSnapshotHash",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("RunLog export contains unsupported or non-aggregate detail");
  }
  const runLog = JSON.parse(canonicalJson({
    schemaVersion: 1,
    scenario: record.scenario,
    engineVersion: record.engineVersion,
    seed: record.seed,
    decisions: record.decisions,
    events: [],
    finalTime: record.finalTime,
    finalOutcomes: record.finalOutcomes,
    finalMetrics: record.finalMetrics,
    finalResources: record.finalResources,
    finalSnapshotHash: record.finalSnapshotHash,
  }));
  assertRunLog(runLog);
  return deepFreeze(runLog);
}

/** Compares generic RunLogs; deltas are B − A and queue changes are not causal. */
export function compareRunLogs(a, b) {
  assertComparable([a, b], { allowScenarioHashMismatch: true });
  const left = comparisonMetrics(a);
  const right = comparisonMetrics(b);
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const metrics = names.map((name) => {
    const before = left[name] ?? null;
    const after = right[name] ?? null;
    return Object.freeze({
      name,
      category: name.startsWith("local.") ? "local" : "system",
      a: before,
      b: after,
      delta: before === null || after === null ? null : after - before,
    });
  });
  const queueChanges = metrics
    .filter((metric) => metric.name.startsWith("local.") && metric.name.endsWith(".queueLength"))
    .map((metric) => Object.freeze({
      areaId: metric.name.slice("local.".length, -".queueLength".length),
      a: metric.a,
      b: metric.b,
      delta: metric.delta,
    }));
  return Object.freeze({
    seedA: a.seed,
    seedB: b.seed,
    finalTime: a.finalTime,
    metrics: Object.freeze(metrics),
    local: Object.freeze(metrics.filter((metric) => metric.category === "local")),
    system: Object.freeze(metrics.filter((metric) => metric.category === "system")),
    queueChanges: Object.freeze(queueChanges),
  });
}

/** Summarizes numeric KPIs over multiple paired-seed RunLogs. */
export function summarizeRunDistribution(runLogs) {
  if (!Array.isArray(runLogs) || runLogs.length < 2) {
    throw new RangeError("a multi-seed distribution needs at least two RunLogs");
  }
  assertComparable(runLogs);
  if (new Set(runLogs.map((log) => taggedSeed(log.seed))).size !== runLogs.length) {
    throw new RangeError("multi-seed distributions require distinct seeds");
  }
  const rows = runLogs.map(comparisonMetrics);
  const names = Object.keys(rows[0]).filter((name) => rows.every((row) => isFiniteNumber(row[name]))).sort();
  const metrics = Object.fromEntries(names.map((name) => {
    const values = rows.map((row, index) => ({ seed: runLogs[index].seed, value: row[name] }));
    const numbers = values.map(({ value }) => value);
    return [name, Object.freeze({
      values: Object.freeze(values.map(Object.freeze)),
      min: Math.min(...numbers),
      p10: quantile(numbers, 0.1),
      median: quantile(numbers, 0.5),
      mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
      p90: quantile(numbers, 0.9),
      max: Math.max(...numbers),
    })];
  }));
  return Object.freeze({
    scenario: runLogs[0].scenario,
    engineVersion: runLogs[0].engineVersion,
    finalTime: runLogs[0].finalTime,
    seeds: Object.freeze(runLogs.map((log) => log.seed)),
    runCount: runLogs.length,
    metrics: Object.freeze(metrics),
  });
}
