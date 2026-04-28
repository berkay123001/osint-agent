import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BloomFilter } from './bloomFilter.js';

describe('BloomFilter — basic membership', () => {
  it('empty filter returns false for any item', () => {
    const bf = new BloomFilter(100);
    assert.equal(bf.mightContain('https://example.com'), false);
    assert.equal(bf.mightContain(''), false);
  });

  it('added item is always found (no false negatives)', () => {
    const bf = new BloomFilter(100);
    const urls = [
      'https://example.com/page1',
      'https://github.com/torvalds',
      'https://twitter.com/user/status/123',
      'https://linkedin.com/in/someuser',
    ];
    for (const url of urls) bf.add(url);
    for (const url of urls) {
      assert.equal(bf.mightContain(url), true, `Expected "${url}" to be found`);
    }
  });

  it('size increments on each add (including duplicates)', () => {
    const bf = new BloomFilter(100);
    assert.equal(bf.size, 0);
    bf.add('https://a.com');
    assert.equal(bf.size, 1);
    bf.add('https://b.com');
    assert.equal(bf.size, 2);
    bf.add('https://a.com'); // duplicate
    assert.equal(bf.size, 3); // size counts adds, not unique items
  });

  it('item not added returns false for sparse filter', () => {
    const bf = new BloomFilter(10000, 0.01);
    bf.add('https://seen.com');
    // A completely different URL in a very sparse filter should be false
    assert.equal(bf.mightContain('https://definitely-not-added-xyz-123.com/page'), false);
  });
});

describe('BloomFilter — parameter validation', () => {
  it('throws on non-positive expectedItems', () => {
    assert.throws(() => new BloomFilter(0), /expectedItems/);
    assert.throws(() => new BloomFilter(-1), /expectedItems/);
  });

  it('throws on out-of-range false positive rate', () => {
    assert.throws(() => new BloomFilter(100, 0), /falsePositiveRate/);
    assert.throws(() => new BloomFilter(100, 1), /falsePositiveRate/);
    assert.throws(() => new BloomFilter(100, 1.5), /falsePositiveRate/);
  });

  it('bitArraySize and hashFunctionCount are positive integers', () => {
    const bf = new BloomFilter(10000, 0.01);
    assert.ok(bf.bitArraySize > 0);
    assert.ok(bf.hashFunctionCount >= 1);
    assert.ok(Number.isInteger(bf.bitArraySize));
    assert.ok(Number.isInteger(bf.hashFunctionCount));
  });

  it('larger expectedItems produces larger bit array', () => {
    const small = new BloomFilter(100, 0.01);
    const large = new BloomFilter(10000, 0.01);
    assert.ok(large.bitArraySize > small.bitArraySize);
  });

  it('stricter false positive rate produces larger bit array', () => {
    const loose = new BloomFilter(1000, 0.1);
    const tight = new BloomFilter(1000, 0.001);
    assert.ok(tight.bitArraySize > loose.bitArraySize);
  });
});

describe('BloomFilter — false positive rate', () => {
  it('false positive rate stays within 2× of configured rate at stated capacity', () => {
    const targetFPR = 0.01;
    const n = 1000;
    const bf = new BloomFilter(n, targetFPR);

    for (let i = 0; i < n; i++) bf.add(`https://site${i}.osint.test/path`);

    let falsePositives = 0;
    for (let i = n; i < 2 * n; i++) {
      if (bf.mightContain(`https://site${i}.osint.test/path`)) falsePositives++;
    }
    const actualFPR = falsePositives / n;
    assert.ok(
      actualFPR < targetFPR * 2,
      `FPR ${actualFPR.toFixed(4)} exceeds 2× target ${targetFPR}`,
    );
  });

  it('estimatedFalsePositiveRate is in [0, 1] before and after adding items', () => {
    const bf = new BloomFilter(200, 0.01);
    assert.ok(bf.estimatedFalsePositiveRate >= 0);
    assert.ok(bf.estimatedFalsePositiveRate <= 1);

    for (let i = 0; i < 100; i++) bf.add(`item-${i}`);
    assert.ok(bf.estimatedFalsePositiveRate >= 0);
    assert.ok(bf.estimatedFalsePositiveRate <= 1);
  });
});

describe('BloomFilter — serialization', () => {
  it('toState() / fromState() round-trip preserves membership', () => {
    const bf = new BloomFilter(100, 0.01);
    bf.add('https://github.com/torvalds');
    bf.add('https://example.com/profile');

    const restored = BloomFilter.fromState(bf.toState());

    assert.equal(restored.mightContain('https://github.com/torvalds'), true);
    assert.equal(restored.mightContain('https://example.com/profile'), true);
    assert.equal(
      restored.mightContain('https://definitely-not-added-xyz.com'),
      false,
    );
  });

  it('toState() produces a JSON-safe object', () => {
    const bf = new BloomFilter(50);
    bf.add('https://test.com');
    const state = bf.toState();

    const json = JSON.stringify(state); // must not throw
    const parsed = JSON.parse(json);
    assert.equal(typeof parsed.bits, 'string');
    assert.equal(typeof parsed.k, 'number');
    assert.equal(typeof parsed.m, 'number');
    assert.equal(typeof parsed.count, 'number');
  });

  it('fromState() preserves bitArraySize, hashFunctionCount, and size', () => {
    const bf = new BloomFilter(200, 0.05);
    bf.add('a');
    bf.add('b');
    bf.add('c');
    const restored = BloomFilter.fromState(bf.toState());

    assert.equal(restored.bitArraySize, bf.bitArraySize);
    assert.equal(restored.hashFunctionCount, bf.hashFunctionCount);
    assert.equal(restored.size, bf.size);
  });
});

describe('BloomFilter — URL deduplication (paper scenario)', () => {
  it('handles 10 000 URLs with no false negatives and sub-100 ms lookups', () => {
    const bf = new BloomFilter(10_000, 0.01);

    // Add 5 000 "seen" URLs
    for (let i = 0; i < 5_000; i++) {
      bf.add(`https://domain${i % 500}.example.com/page${i}`);
    }

    // All added URLs must be found (no false negatives)
    let missed = 0;
    for (let i = 0; i < 5_000; i++) {
      if (!bf.mightContain(`https://domain${i % 500}.example.com/page${i}`)) missed++;
    }
    assert.equal(missed, 0, 'No false negatives allowed');

    // 10 000 lookups should complete well within 100 ms
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bf.mightContain(`https://query${i}.example.com`);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `10 000 lookups took ${elapsed.toFixed(1)} ms (expected < 100 ms)`);
  });

  it('memory footprint for 10 000 URLs at 1% FPR is < 20 KB', () => {
    const bf = new BloomFilter(10_000, 0.01);
    const state = bf.toState();
    const serializedBytes = Buffer.from(state.bits, 'base64').length;
    assert.ok(
      serializedBytes < 20_000,
      `Bit array is ${serializedBytes} bytes — expected < 20 000`,
    );
  });
});
