const UINT32_RANGE = 0x1_0000_0000;

/**
 * @typedef {(() => number) & {
 *   nextUint32: () => number,
 *   uniform: () => number,
 *   int: (min: number, max: number) => number,
 *   exponential: (rate: number) => number,
 *   lognormal: (mean: number, cv: number) => number
 * }} Rng
 */

/**
 * @typedef {number|string} Seed
 */

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function normalizeSeed(seed) {
  if (typeof seed === "string") return hashString(seed);
  if (typeof seed !== "number" || !Number.isSafeInteger(seed)) {
    throw new TypeError("seed must be a string or safe integer");
  }
  return seed >>> 0;
}

function mix32(value) {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function requireRng(rng) {
  if (!rng || typeof rng.nextUint32 !== "function") {
    throw new TypeError("rng must be created by createRng");
  }
}

/**
 * Create an independent Mulberry32 stream. String seeds are hashed with FNV-1a;
 * numeric seeds are reduced to their unsigned 32-bit representation.
 * @param {Seed} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let state = normalizeSeed(seed);

  function nextUint32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  const rng = () => uniform(rng);
  Object.assign(rng, {
    nextUint32,
    uniform: () => uniform(rng),
    int: (min, max) => int(rng, min, max),
    exponential: (rate) => exponential(rng, rate),
    lognormal: (mean, cv) => lognormal(rng, mean, cv),
  });

  return Object.freeze(rng);
}

/**
 * Derive a mutable stream whose sequence is independent of every other name.
 * @param {Seed} seed
 * @param {string} name
 * @returns {Rng}
 */
export function substream(seed, name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("stream name must be a non-empty string");
  }
  return createRng(mix32(normalizeSeed(seed) ^ hashString(name)));
}

/**
 * Derive a fresh stream for a stable integer index or string identity.
 * @param {Seed} seed
 * @param {string} name
 * @param {number|string} index
 * @returns {Rng}
 */
export function indexedStream(seed, name, index) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("stream name must be a non-empty string");
  }
  let indexHash;
  if (typeof index === "string" && index.length > 0) {
    indexHash = hashString(`s:${index}`);
  } else if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) {
    indexHash = hashString(`n:${index}`);
  } else {
    throw new TypeError("index must be a non-negative safe integer or non-empty string");
  }
  const namedSeed = mix32(normalizeSeed(seed) ^ hashString(name));
  return createRng(mix32(namedSeed ^ indexHash));
}

/**
 * @param {Rng} rng
 * @returns {number} A value in [0, 1).
 */
export function uniform(rng) {
  requireRng(rng);
  return rng.nextUint32() / UINT32_RANGE;
}

/**
 * @param {Rng} rng
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {number}
 */
export function int(rng, min, max) {
  requireRng(rng);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
    throw new RangeError("min and max must be safe integers with max >= min");
  }
  const range = max - min + 1;
  if (range > UINT32_RANGE) throw new RangeError("integer range must not exceed 2^32");
  const limit = Math.floor(UINT32_RANGE / range) * range;
  let value;
  do {
    value = rng.nextUint32();
  } while (value >= limit);
  return min + (value % range);
}

/**
 * @param {Rng} rng
 * @param {number} rate Positive events per unit.
 * @returns {number}
 */
export function exponential(rng, rate) {
  requireRng(rng);
  if (!(rate > 0) || !Number.isFinite(rate)) {
    throw new RangeError("rate must be a positive finite number");
  }
  return -Math.log1p(-uniform(rng)) / rate;
}

/**
 * Sample a lognormal value parameterized by arithmetic mean and coefficient
 * of variation, using a Box-Muller standard-normal draw.
 * @param {Rng} rng
 * @param {number} mean Positive arithmetic mean.
 * @param {number} cv Non-negative coefficient of variation.
 * @returns {number}
 */
export function lognormal(rng, mean, cv) {
  requireRng(rng);
  if (!(mean > 0) || !Number.isFinite(mean)) {
    throw new RangeError("mean must be a positive finite number");
  }
  if (!(cv >= 0) || !Number.isFinite(cv)) {
    throw new RangeError("cv must be a non-negative finite number");
  }
  if (cv === 0) return mean;
  const sigmaSquared =
    cv > Math.sqrt(Number.MAX_VALUE) ? 2 * Math.log(cv) : Math.log1p(cv * cv);
  const sigma = Math.sqrt(sigmaSquared);
  const mu = Math.log(mean) - sigmaSquared / 2;
  const standardNormal =
    Math.sqrt(-2 * Math.log1p(-uniform(rng))) * Math.cos(2 * Math.PI * uniform(rng));
  return Math.exp(mu + sigma * standardNormal);
}
