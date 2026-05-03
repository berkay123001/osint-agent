/**
 * Bloom Filter — probabilistic set membership structure.
 *
 * Inspired by Yurtalan & Arslan (2025) "Multi-Agent OSINT with Graph RAG +
 * Hierarchical Bloom-Filter Deduplication" — used here for O(1) URL deduplication
 * across agent search sessions.
 *
 * Properties:
 *   - No false negatives: if item was added, mightContain() always returns true
 *   - Tunable false positive rate (default 1%)
 *   - Memory efficient: bit array only — stores no URL strings
 *   - Serializable: toState() / BloomFilter.fromState() for session persistence
 *
 * Optimal parameters (from information theory):
 *   m = -n · ln(p) / (ln 2)²   — bit array size
 *   k =  (m/n) · ln 2           — number of hash functions
 *
 * False positive probability:
 *   Pr[fp] ≈ (1 - e^{-kn/m})^k
 */

export interface BloomFilterState {
  /** Bit array encoded as base64 string for JSON serializability. */
  bits: string;
  /** Number of hash functions (k). */
  k: number;
  /** Bit array size in bits (m). */
  m: number;
  /** Approximate number of items added. */
  count: number;
}

export class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly k: number;
  private readonly m: number;
  private count = 0;

  /**
   * Create a new BloomFilter sized for the given expected item count and FPR.
   *
   * @param expectedItems  Upper bound on items to be inserted (n)
   * @param falsePositiveRate  Target false positive probability, e.g. 0.01 = 1%
   */
  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    if (expectedItems <= 0) throw new RangeError('expectedItems must be > 0');
    if (falsePositiveRate <= 0 || falsePositiveRate >= 1)
      throw new RangeError('falsePositiveRate must be in (0, 1)');

    // m = -n·ln(p) / (ln2)²
    this.m = Math.ceil(
      (-expectedItems * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2),
    );
    // k = (m/n)·ln2, at least 1
    this.k = Math.max(1, Math.round((this.m / expectedItems) * Math.LN2));
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }

  // ── Hash functions ────────────────────────────────────────────────────────

  /** FNV-1a 32-bit hash (first independent hash). */
  private static fnv1a(str: string): number {
    let hash = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  /** djb2 variant (second independent hash). */
  private static djb2(str: string): number {
    let hash = 5381 >>> 0;
    for (let i = 0; i < str.length; i++) {
      hash = (Math.imul(hash, 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  /**
   * Generate k bit positions via double hashing:
   *   pos_i = (h1 + i·h2) mod m
   */
  private positions(item: string): number[] {
    const h1 = BloomFilter.fnv1a(item);
    const h2 = BloomFilter.djb2(item) | 1; // ensure h2 is odd (coprime to m for full coverage)
    const result: number[] = [];
    for (let i = 0; i < this.k; i++) {
      result.push(((h1 + i * h2) >>> 0) % this.m);
    }
    return result;
  }

  private setBit(pos: number): void {
    this.bits[Math.floor(pos / 8)] |= 1 << pos % 8;
  }

  private getBit(pos: number): boolean {
    return (this.bits[Math.floor(pos / 8)] & (1 << pos % 8)) !== 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Add an item to the filter. */
  add(item: string): void {
    for (const pos of this.positions(item)) {
      this.setBit(pos);
    }
    this.count++;
  }

  /**
   * Test if an item might be in the set.
   *
   * - `false` → item **definitely** not in set (no false negatives guaranteed)
   * - `true`  → item **probably** in set (false positive rate ≈ configured rate)
   */
  mightContain(item: string): boolean {
    return this.positions(item).every(pos => this.getBit(pos));
  }

  /** Number of times `add()` was called (counts duplicates). */
  get size(): number {
    return this.count;
  }

  /** Bit array size in bits (m). */
  get bitArraySize(): number {
    return this.m;
  }

  /** Number of hash functions (k). */
  get hashFunctionCount(): number {
    return this.k;
  }

  /**
   * Estimated false positive probability based on current bit fill.
   * Pr[fp] ≈ (bitsSet / m)^k
   */
  get estimatedFalsePositiveRate(): number {
    let bitsSet = 0;
    for (const byte of this.bits) {
      let n = byte;
      while (n) {
        bitsSet += n & 1;
        n >>>= 1;
      }
    }
    return Math.pow(bitsSet / this.m, this.k);
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /** Serialize to a JSON-safe state object (for session persistence). */
  toState(): BloomFilterState {
    return {
      bits: Buffer.from(this.bits).toString('base64'),
      k: this.k,
      m: this.m,
      count: this.count,
    };
  }

  /** Restore a BloomFilter from a previously serialized state. */
  static fromState(state: BloomFilterState): BloomFilter {
    const bits = new Uint8Array(Buffer.from(state.bits, 'base64'));
    const bf = Object.create(BloomFilter.prototype) as BloomFilter;
    (bf as any).m = state.m;
    (bf as any).k = state.k;
    (bf as any).bits = bits;
    (bf as any).count = state.count;
    return bf;
  }
}
