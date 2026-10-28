/** Aggregate-only N-seed × M-strategy experiments. All outputs are synthetic. */
import { runHeadless, SYNTHETIC_LABEL } from "../sim/runner.js";
import { canonicalJson, loadScenario } from "../sim/scenario.js";
import { compareRunLogs, summarizeRunDistribution } from "../sim/replay.js";

const taggedSeed = (seed) => `${typeof seed}:${String(seed)}`;
const sensitivityMetric = "system.medianReferralToTreatmentMinutes";

/** Five mechanism paths already covered by the acceptance sensitivity smoke. */
export const TOP_SENSITIVITY_PARAMETERS = Object.freeze([
  { id: "arrivalsPerWeek", path: "parameters.arrivalsPerWeek" },
  { id: "pReferral", path: "parameters.pReferral" },
  { id: "pDiagnostics", path: "parameters.pDiagnostics" },
  { id: "outpatientServiceMean", path: "areas.outpatient.serviceTime.mean" },
  { id: "referralCompleteness", path: "infrastructure.gp_to_hospital.completeness" },
].map(Object.freeze));

function validateInput({ scenario, seeds, strategies, quarters }) {
  if (!Array.isArray(seeds) || seeds.length < 2) throw new RangeError("experiments require at least two seeds");
  const seedIds = new Set();
  for (const seed of seeds) {
    if (!(typeof seed === "string" && seed.length > 0) && !Number.isSafeInteger(seed)) {
      throw new TypeError("seeds must be non-empty strings or safe integers");
    }
    if (seedIds.has(taggedSeed(seed))) throw new RangeError("experiment seeds must be distinct");
    seedIds.add(taggedSeed(seed));
  }
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new RangeError("experiments require at least one strategy");
  }
  if (!Number.isSafeInteger(quarters) || quarters < 1) throw new RangeError("quarters must be a positive integer");
  const ids = new Set();
  for (const strategy of strategies) {
    if (!strategy || typeof strategy.id !== "string" || !strategy.id ||
        typeof strategy.label !== "string" || !strategy.label ||
        (strategy.overrides !== undefined && !Array.isArray(strategy.overrides))) {
      throw new TypeError("each strategy needs a non-empty id, label, and optional overrides array");
    }
    if (ids.has(strategy.id)) throw new RangeError(`duplicate strategy id ${strategy.id}`);
    ids.add(strategy.id);
  }
  return loadScenario(scenario);
}

function targetAt(scenario, path) {
  let match = /^parameters\.([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (match && Object.hasOwn(scenario.parameters, match[1])) {
    return [scenario.parameters[match[1]], "value"];
  }
  match = /^areas\.([A-Za-z0-9_-]+)\.(servers|serviceTime\.mean)$/.exec(path);
  if (match) {
    const area = scenario.initialState.areas.find((item) => item.id === match[1]);
    if (area?.[match[2]] !== undefined && match[2] === "servers") return [area, "servers"];
    if (area?.serviceTime && match[2] === "serviceTime.mean") return [area.serviceTime, "mean"];
  }
  match = /^infrastructure\.([A-Za-z0-9_-]+)\.(completeness|latencyMinutes)$/.exec(path);
  if (match) {
    const edge = scenario.initialState.infrastructure?.find((item) => item.id === match[1]);
    if (edge) return [edge, match[2]];
  }
  throw new RangeError(`unsupported or missing numeric scenario path: ${String(path)}`);
}

function numericAt(scenario, path) {
  const [object, key] = targetAt(scenario, path);
  if (typeof object[key] !== "number" || !Number.isFinite(object[key])) {
    throw new TypeError(`scenario path ${path} must contain a finite number`);
  }
  return object[key];
}

function makeScenario(base, overrides = []) {
  if (!Array.isArray(overrides)) throw new TypeError("strategy overrides must be an array");
  const scenario = structuredClone(base);
  const paths = new Set();
  for (const { path, value } of overrides) {
    if (typeof path !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("each override needs a supported path and a finite numeric value");
    }
    if (paths.has(path)) throw new RangeError(`strategy changes ${path} more than once`);
    paths.add(path);
    const [object, key] = targetAt(scenario, path);
    if (typeof object[key] !== "number") throw new TypeError(`scenario path ${path} must contain a number`);
    object[key] = value;
  }
  return loadScenario(scenario);
}

function metricsOf(log) {
  return Object.fromEntries(compareRunLogs(log, log).metrics
    .filter(({ a }) => Number.isFinite(a))
    .map(({ name, a }) => [name, a]));
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p) => {
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
  };
  return {
    n: values.length,
    min: sorted[0],
    p10: quantile(0.1),
    median: quantile(0.5),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p90: quantile(0.9),
    max: sorted.at(-1),
  };
}

function summarizePairedChanges(runs) {
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.metrics)))].sort();
  return Object.fromEntries(names.map((name) =>
    [name, summarize(runs.map((run) => run.metrics[name]).filter(Number.isFinite))]));
}

function pairedChanges(baselineRunLogs, variantRunLogs) {
  const baselineBySeed = new Map(baselineRunLogs.map((runLog) => [taggedSeed(runLog.seed), runLog]));
  const pairedDeltas = variantRunLogs.map((runLog) => {
    const before = baselineBySeed.get(taggedSeed(runLog.seed));
    if (!before) throw new RangeError("paired experiment runs must use the same seeds");
    const comparison = compareRunLogs(before, runLog);
    return {
      seed: runLog.seed,
      metrics: Object.fromEntries(comparison.metrics
        .filter(({ delta }) => Number.isFinite(delta))
        .map(({ name, delta }) => [name, delta])),
    };
  });
  return { pairedDeltas, summary: summarizePairedChanges(pairedDeltas) };
}

/**
 * Run all strategies and paired ±20% sensitivity cases with the same explicit seed list.
 * Paths are limited to numeric scenario parameters, area servers/service time, and edge
 * completeness/latency; every modified scenario is validated and canonically hashed.
 * @param {{ scenario: object, seeds: (number|string)[], strategies: object[], quarters?: number, sensitivity?: boolean }} input
 */
export function runExperiment(input) {
  const { scenario, seeds, strategies, quarters = 4, sensitivity = true } = input ?? {};
  const base = validateInput({ scenario, seeds, strategies, quarters });
  if (typeof sensitivity !== "boolean") throw new TypeError("sensitivity must be a boolean");
  const cache = new Map();
  const runCase = (variant) => {
    const key = canonicalJson(variant);
    if (!cache.has(key)) {
      const runLogs = seeds.map((seed) => {
        const { engineVersion, runLog } = runHeadless(variant, { seed, quarters, recordEvents: false });
        if (engineVersion !== runLog.engineVersion) {
          throw new RangeError("headless result and RunLog engine versions differ");
        }
        return runLog;
      });
      if (new Set(runLogs.map((runLog) => runLog.engineVersion)).size !== 1) {
        throw new RangeError("engine version changed during one experiment");
      }
      const runs = runLogs.map((runLog) => ({
        seed: runLog.seed,
        engineVersion: runLog.engineVersion,
        scenarioHash: runLog.scenario.sha256,
        metrics: metricsOf(runLog),
      }));
      cache.set(key, {
        runLogs,
        runs,
        summary: summarizeRunDistribution(runLogs).metrics,
      });
    }
    return cache.get(key);
  };

  const baseline = runCase(base);
  const strategyResults = strategies.map((strategy) => {
    const result = runCase(makeScenario(base, strategy.overrides ?? []));
    return {
      id: strategy.id,
      label: strategy.label,
      scenarioHash: result.runs[0].scenarioHash,
      runs: result.runs,
      summary: result.summary,
    };
  });
  const sensitivityParameters = sensitivity ? TOP_SENSITIVITY_PARAMETERS.map(({ id, path }) => {
    const baseValue = numericAt(base, path);
    const cases = [-0.2, 0.2].map((delta) => {
      const result = runCase(makeScenario(base, [{ path, value: baseValue * (1 + delta) }]));
      const paired = pairedChanges(baseline.runLogs, result.runLogs);
      return {
        id: `${id}:${delta < 0 ? "-20%" : "+20%"}`,
        change: delta < 0 ? "-20%" : "+20%",
        value: baseValue * (1 + delta),
        scenarioHash: result.runs[0].scenarioHash,
        runs: result.runs,
        summary: result.summary,
        pairedDeltas: paired.pairedDeltas,
        pairedChangeSummary: paired.summary,
      };
    });
    return { id, path, baseValue, cases };
  }) : [];

  return {
    format: "cammelot-experiment",
    schemaVersion: 1,
    synthetic: true,
    label: SYNTHETIC_LABEL,
    methodology: "All variants use matched seeds and named/indexed engine streams. Changes to exogenous parameters may change the realized trace; results are synthetic, not healthcare evidence.",
    scenario: {
      id: base.id,
      version: base.version,
      schemaVersion: base.schemaVersion,
      sha256: baseline.runs[0].scenarioHash,
    },
    engineVersion: baseline.runs[0].engineVersion,
    quarters,
    seeds: [...seeds],
    seedCount: seeds.length,
    strategyCount: strategies.length,
    commonRandomNumbers: { matchedSeeds: true },
    strategies: strategyResults,
    sensitivity: {
      enabled: sensitivity,
      perturbation: "±20%",
      note: "Five existing acceptance-smoke parameters; paired deltas assert no universal direction.",
      parameters: sensitivityParameters,
    },
  };
}

const csv = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Deterministic one-row-per-run CSV with scenario and engine metadata. */
export function formatExperimentCsv(result) {
  if (result?.synthetic !== true || result.format !== "cammelot-experiment") {
    throw new TypeError("expected a synthetic Cammelot experiment result");
  }
  const rows = [];
  for (const strategy of result.strategies) {
    for (const run of strategy.runs) rows.push({
      kind: "strategy", id: strategy.id, label: strategy.label, seed: run.seed, change: "",
      run, deltas: {},
    });
  }
  for (const parameter of result.sensitivity.parameters) {
    for (const item of parameter.cases) {
      const bySeed = new Map(item.pairedDeltas.map((run) => [taggedSeed(run.seed), run.metrics]));
      for (const run of item.runs) rows.push({
        kind: "sensitivity", id: item.id, label: `${parameter.path} ${item.change}`,
        seed: run.seed, change: item.change, run, deltas: bySeed.get(taggedSeed(run.seed)) ?? {},
      });
    }
  }
  const names = [...new Set(rows.flatMap(({ run }) => Object.keys(run.metrics)))].sort();
  const headers = [
    "kind", "id", "label", "seed", "change", "engineVersion", "baseScenarioHash", "scenarioHash",
    ...names, ...names.map((name) => `delta.${name}`),
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => {
      if (header.startsWith("delta.")) return csv(row.deltas[header.slice(6)]);
      if (["kind", "id", "label", "seed", "change"].includes(header)) return csv(row[header]);
      if (header === "engineVersion") return csv(row.run.engineVersion);
      if (header === "baseScenarioHash") return csv(result.scenario.sha256);
      if (header === "scenarioHash") return csv(row.run.scenarioHash);
      return csv(row.run.metrics[header]);
    }).join(",")),
  ].join("\n");
}

const display = (value) => Number.isFinite(value) ? Number(value.toFixed(2)).toString() : "n/a";

/** Compact synthetic summary for CLI output or a small checked-in example. */
export function formatExperimentReport(result) {
  if (result?.synthetic !== true || result.format !== "cammelot-experiment") {
    throw new TypeError("expected a synthetic Cammelot experiment result");
  }
  const out = [
    "# Synthetic multi-seed experiment report", "",
    `> ${result.label}`, "",
    `Scenario: \`${result.scenario.id}@${result.scenario.version}\` · schema ${result.scenario.schemaVersion} · SHA-256 \`${result.scenario.sha256}\``,
    `Engine: \`${result.engineVersion}\` · ${result.quarters} quarter(s) · seeds: ${result.seeds.join(", ")}`, "",
    "Results describe this synthetic scenario only; they are not clinical, national, or causal claims.",
    "Strategies and sensitivity variants use matched seeds and named exogenous streams. Changing an exogenous parameter can change its realized trace.",
    "Sensitivity changes are smoke tests; no universal direction is asserted.", "",
    "| Strategy | Median referral-to-treatment (min) | Median treatment starts | Median diagnostics queue |",
    "|---|---:|---:|---:|",
  ];
  for (const strategy of result.strategies) {
    const s = strategy.summary;
    out.push(`| ${strategy.label.replaceAll("|", "\\|")} | ${display(s[sensitivityMetric]?.median)} | ${display(s["system.treatmentStarts"]?.median)} | ${display(s["local.diagnostics.queueLength"]?.median)} |`);
  }
  if (result.sensitivity.enabled) {
    out.push("", "## ±20% sensitivity smoke", "",
      "| Parameter | Change | Paired median Δ referral-to-treatment (min) | Paired Δ range (min) |",
      "|---|---:|---:|---:|");
    for (const parameter of result.sensitivity.parameters) {
      for (const item of parameter.cases) {
        const s = item.pairedChangeSummary[sensitivityMetric];
        out.push(`| \`${parameter.path}\` | ${item.change} | ${display(s?.median)} | ${display(s?.min)} to ${display(s?.max)} |`);
      }
    }
  } else out.push("", "Sensitivity smoke: disabled.");
  out.push("", "Paired deltas are model outputs under shared seeds; interpret them as a reproducibility check, not as evidence about real care.");
  return out.join("\n");
}
