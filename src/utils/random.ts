export type Seed = string | number;

export interface RandomSource {
  next(): number;
}

export interface SeededRandomSource extends RandomSource {
  reset(seed: Seed): void;
}

function hashSeed(seed: Seed): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) {
      throw new Error('Seed must be finite');
    }
    // Numeric seeds use their truncated uint32 representation. This is part of
    // the public mulberry32-v1 seed contract.
    return Math.trunc(seed) >>> 0;
  }

  // FNV-1a 32-bit is part of the seed format for mulberry32-v1.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable, non-cryptographic PRNG. The algorithm and seed hashing are versioned
 * by this module's mulberry32-v1 contract so changing either changes replay results.
 */
export function createSeededRandom(seed: Seed): SeededRandomSource {
  let state = hashSeed(seed);

  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    },
    reset(nextSeed: Seed): void {
      state = hashSeed(nextSeed);
    },
  };
}

export function createRandomSeed(): number {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject) {
    try {
      const values = new Uint32Array(2);
      cryptoObject.getRandomValues(values);
      return (values[0] ^ values[1]) >>> 0;
    } catch {
      // Fall through when the host exposes crypto but blocks entropy access.
    }
  }

  // Seed generation is outside the simulation stream; this fallback only
  // chooses an initial seed when Web Crypto is unavailable.
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}
