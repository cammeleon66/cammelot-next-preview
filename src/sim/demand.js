/**
 * Exogenous demand (SIMULATION_SPEC §3). Arrival times and IDs depend only on the scenario,
 * the supplied `arrivals` stream and the window, never on policy-dependent state, so every
 * compared policy sees the same arrival trace for a seed.
 */

import { exponential } from "./rng.js";

/**
 * Poisson arrivals in `[fromTime, toTime)` at `parameters.arrivalsPerWeek` per 10,080 minutes.
 * IDs are stable strings `pt-<fromTime>-<index>`; the engine calls this for fixed week-aligned
 * windows, each with an indexed stream, so the trace is independent of how a run is chunked.
 * @param {{ parameters: { arrivalsPerWeek: { value: number } } }} scenario
 * @param {import('./rng.js').Rng} rng
 * @param {number} fromTime
 * @param {number} toTime
 * @returns {{ id: string, time: number }[]} in ascending time order
 */
export function scheduleArrivals(scenario, rng, fromTime, toTime) {
  if (!Number.isSafeInteger(fromTime) || fromTime < 0 || !Number.isSafeInteger(toTime) || toTime < fromTime) {
    throw new RangeError("fromTime and toTime must be non-negative safe integer minutes with toTime >= fromTime");
  }
  const perWeek = scenario?.parameters?.arrivalsPerWeek?.value;
  if (!(perWeek >= 0) || !Number.isFinite(perWeek)) {
    throw new RangeError("parameters.arrivalsPerWeek.value must be a non-negative finite number");
  }
  const arrivals = [];
  if (perWeek === 0) return arrivals;
  const ratePerMinute = perWeek / (7 * 24 * 60);
  let offset = 0;
  for (;;) {
    offset += exponential(rng, ratePerMinute);
    const time = fromTime + Math.floor(offset);
    if (time >= toTime) return arrivals;
    arrivals.push({ id: `pt-${fromTime}-${arrivals.length}`, time });
  }
}
