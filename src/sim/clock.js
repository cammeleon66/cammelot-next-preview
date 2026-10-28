/**
 * Monotonic simulated clock and pure calendar conversion (SIMULATION_SPEC §2).
 *
 * Time is a non-negative integer number of minutes from the scenario epoch, which is
 * Monday 00:00 of week 0. The calendar is deliberately regular: 7-day weeks, 13-week
 * quarters and 4-quarter (364-day) years, so quarter boundaries never drift. Nothing here
 * reads wall-clock time.
 */

export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_WEEK = 7;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * DAYS_PER_WEEK;
export const WEEKS_PER_QUARTER = 13;
export const MINUTES_PER_QUARTER = MINUTES_PER_WEEK * WEEKS_PER_QUARTER;
export const QUARTERS_PER_YEAR = 4;
export const MINUTES_PER_YEAR = MINUTES_PER_QUARTER * QUARTERS_PER_YEAR;

function requireTime(time, label) {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer minute`);
  }
}

/**
 * @param {number} [startAt]
 * @returns {{ now: number }}
 */
export function createClock(startAt = 0) {
  requireTime(startAt, "startAt");
  return { now: startAt };
}

/**
 * Move the clock forward (or keep it in place). Never moves backwards.
 * @param {{ now: number }} clock
 * @param {number} toTime
 * @returns {number} the new time
 */
export function advanceClock(clock, toTime) {
  if (!clock || typeof clock !== "object" || !Number.isSafeInteger(clock.now)) {
    throw new TypeError("clock must be created by createClock");
  }
  requireTime(toTime, "toTime");
  if (toTime < clock.now) {
    throw new RangeError(`clock cannot move backwards: ${toTime} < ${clock.now}`);
  }
  clock.now = toTime;
  return toTime;
}

/**
 * Pure calendar fields for a simulated minute. All indices are zero-based;
 * `dayOfWeek` 0 is Monday.
 * @param {number} time
 */
export function calendarAt(time) {
  requireTime(time, "time");
  const day = Math.floor(time / MINUTES_PER_DAY);
  const week = Math.floor(day / DAYS_PER_WEEK);
  const quarter = Math.floor(week / WEEKS_PER_QUARTER);
  return Object.freeze({
    minute: time,
    minuteOfDay: time - day * MINUTES_PER_DAY,
    day,
    dayOfWeek: day % DAYS_PER_WEEK,
    week,
    quarter,
    quarterOfYear: quarter % QUARTERS_PER_YEAR,
    year: Math.floor(quarter / QUARTERS_PER_YEAR),
  });
}

/**
 * Working-hours window: `{ days: number[] (0=Mon..6=Sun), startMinute, endMinute }` in
 * minutes of the day. `undefined` means the area is always open.
 * @param {{ days: readonly number[], startMinute: number, endMinute: number }|undefined} hours
 * @param {number} time
 */
export function isOpenAt(hours, time) {
  requireTime(time, "time");
  if (hours === undefined) return true;
  const { dayOfWeek, minuteOfDay } = calendarAt(time);
  return (
    hours.days.includes(dayOfWeek) && minuteOfDay >= hours.startMinute && minuteOfDay < hours.endMinute
  );
}

/**
 * Earliest open minute at or after `time`, or `null` if the window never opens.
 * @param {{ days: readonly number[], startMinute: number, endMinute: number }|undefined} hours
 * @param {number} time
 * @returns {number|null}
 */
export function nextOpenAt(hours, time) {
  requireTime(time, "time");
  if (hours === undefined) return time;
  const firstDay = Math.floor(time / MINUTES_PER_DAY);
  for (let offset = 0; offset <= DAYS_PER_WEEK; offset += 1) {
    const day = firstDay + offset;
    if (!hours.days.includes(day % DAYS_PER_WEEK)) continue;
    const start = day * MINUTES_PER_DAY + hours.startMinute;
    const end = day * MINUTES_PER_DAY + hours.endMinute;
    if (time < end) return Math.max(time, start);
  }
  return null;
}
