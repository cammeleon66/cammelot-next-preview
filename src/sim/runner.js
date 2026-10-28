/**
 * Headless deterministic runner (issue #8): runs a scenario for whole quarters and returns
 * quarterly rows plus the final snapshot and run log. Pure: no I/O, no wall-clock; the CLI in
 * `scripts/run-v2-headless.mjs` owns files, arguments and timing. All output is synthetic.
 */

import { MINUTES_PER_DAY, MINUTES_PER_QUARTER } from "./clock.js";
import { createSim } from "./engine.js";

export const SYNTHETIC_LABEL =
  "SYNTHETIC OUTPUT - modelled queues for a fictional cohort, not a clinical or national prediction";

/**
 * @param {import('./scenario.js').ScenarioDef} scenario
 * @param {{ seed: number|string, quarters?: number, sha256?: (json: string) => string, recordEvents?: boolean }} options
 */
export function runHeadless(scenario, options) {
  const { seed, quarters = 4 } = options ?? {};
  if (!Number.isSafeInteger(quarters) || quarters < 1) {
    throw new RangeError("quarters must be a positive integer");
  }
  const sim = createSim(scenario, seed, { sha256: options.sha256, recordEvents: options.recordEvents });
  const rows = [];
  let previous = { created: 0, treatmentStarts: 0, exited: 0, abandoned: 0 };
  let snapshot = sim.snapshot();
  for (let quarter = 1; quarter <= quarters; quarter += 1) {
    sim.runUntil(quarter * MINUTES_PER_QUARTER);
    snapshot = sim.snapshot();
    const current = {
      created: snapshot.metrics.patientsCreated,
      treatmentStarts: snapshot.outcomes.treatmentStarts,
      exited: snapshot.metrics.patientsExited,
      abandoned: snapshot.outcomes.abandonedPatients,
    };
    rows.push({
      quarter,
      endDay: snapshot.time / MINUTES_PER_DAY,
      arrivals: current.created - previous.created,
      treatmentStarts: current.treatmentStarts - previous.treatmentStarts,
      gpExits: current.exited - previous.exited,
      abandoned: current.abandoned - previous.abandoned,
      inFlight: snapshot.metrics.patientsLive,
      queues: Object.fromEntries(snapshot.resources.map((area) => [area.areaId, area.queueLength])),
    });
    previous = current;
  }
  return {
    synthetic: true,
    scenario: snapshot.scenario,
    engineVersion: snapshot.engineVersion,
    seed,
    rows,
    finalSnapshot: snapshot,
    runLog: sim.runLog(),
  };
}

/**
 * Fixed-width quarterly table, stable byte-for-byte for a given result.
 * @param {ReturnType<typeof runHeadless>} result
 * @returns {string}
 */
export function formatQuarterly(result) {
  const areaIds = Object.keys(result.rows[0]?.queues ?? {});
  const columns = [
    "quarter",
    "endDay",
    "arrivals",
    "treatmentStarts",
    "gpExits",
    "abandoned",
    "inFlight",
    ...areaIds.map((id) => `queue:${id}`),
  ];
  const table = result.rows.map((row) => [
    row.quarter,
    row.endDay,
    row.arrivals,
    row.treatmentStarts,
    row.gpExits,
    row.abandoned,
    row.inFlight,
    ...areaIds.map((id) => row.queues[id]),
  ]);
  const widths = columns.map((name, index) =>
    Math.max(name.length, ...table.map((cells) => String(cells[index]).length)),
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padStart(widths[index])).join("  ");
  const { scenario } = result;
  return [
    SYNTHETIC_LABEL,
    `scenario=${scenario.id}@${scenario.version} schemaVersion=${scenario.schemaVersion} sha256=${scenario.sha256}`,
    `engine=${result.engineVersion} seed=${result.seed}`,
    line(columns),
    ...table.map(line),
  ].join("\n");
}
