import { describe, expect, it } from 'vitest';
import { computeOverview } from './overview';

describe('computeOverview', () => {
  it('takes the max absolute value per bucket across channels', () => {
    const l = new Float32Array([0.5, -0.5, 0.25, 0.25, 0, 0, 0.125, 0]);
    const r = new Float32Array([0, 0, 0, -0.75, 0, 0, 0, 0]);
    expect([...computeOverview([l, r], 4)]).toEqual([0.5, 0.75, 0, 0.125]);
  });

  it('puts bucket boundaries at floor(i * length / points)', () => {
    const ch = new Float32Array(10);
    ch[3] = 1; // 10 samples, 3 buckets: [0,3) [3,6) [6,10)
    ch[6] = 0.5;
    expect([...computeOverview([ch], 3)]).toEqual([0, 1, 0.5]);
    const edge = new Float32Array(10);
    edge[2] = 1; // last sample of bucket 0
    edge[5] = 1; // last sample of bucket 1
    expect([...computeOverview([edge], 3)]).toEqual([1, 1, 0]);
  });

  it('repeats samples when the buffer is shorter than points', () => {
    const out = computeOverview([new Float32Array([0.25, -0.75])], 6);
    expect([...out]).toEqual([0.25, 0.25, 0.25, 0.75, 0.75, 0.75]);
  });

  it('returns zeros for silence and empty input', () => {
    expect([...computeOverview([new Float32Array(500)], 10)]).toEqual(new Array(10).fill(0));
    expect([...computeOverview([], 5)]).toEqual(new Array(5).fill(0));
  });

  it('defaults to 1000 points', () => {
    expect(computeOverview([new Float32Array(10)])).toHaveLength(1000);
  });
});
