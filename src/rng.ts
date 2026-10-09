// Deterministic RNG so a seed always produces the same house.

export class Rng {
  private s: number;

  constructor(seed: string) {
    // FNV-1a hash of the seed string.
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    this.s = h >>> 0;
  }

  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.next() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1]![0];
  }

  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  }
}

export function randomSeed(): string {
  const words = ["oak", "maple", "elm", "birch", "cedar", "pine", "ash", "willow", "alder", "hazel"];
  const streets = ["lane", "row", "court", "close", "street", "drive", "way", "place"];
  const n = Math.floor(Math.random() * 900) + 100;
  const w = words[Math.floor(Math.random() * words.length)];
  const s = streets[Math.floor(Math.random() * streets.length)];
  return `${n}-${w}-${s}`;
}
