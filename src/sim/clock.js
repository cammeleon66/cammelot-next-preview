/**
 * @typedef {{ time: number }} SimClock
 */

/** @param {number} startAt */
export function createClock(startAt = 0) {
  throw new Error('NotImplemented: createClock');
}

/** @param {SimClock} clock @param {number} toTime */
export function advanceClock(clock, toTime) {
  throw new Error('NotImplemented: advanceClock');
}

/** @param {number} time */
export function calendarAt(time) {
  throw new Error('NotImplemented: calendarAt');
}
