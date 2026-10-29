import { describe, expect, it } from 'vitest';
import { computeMatch } from './match';

describe('computeMatch', () => {
  it('brings every slot to the target when nothing would exceed the ceiling', () => {
    const r = computeMatch(
      [
        { integratedLufs: -9, truePeakDbtp: 0.5 },
        { integratedLufs: -12, truePeakDbtp: -1.5 },
      ],
      -14,
    );
    expect(r.effectiveTargetLufs).toBe(-14);
    expect(r.gainsDb).toEqual([-5, -2]);
    expect(r.limitedBy).toBeNull();
  });

  it('lowers the target for every slot when one would pass -1 dBTP', () => {
    // A quiet pre-master: +6 dB of gain would put its peak at +2 dBTP.
    const r = computeMatch(
      [
        { integratedLufs: -8, truePeakDbtp: 0.8 },
        { integratedLufs: -20, truePeakDbtp: -4 },
      ],
      -14,
    );
    expect(r.effectiveTargetLufs).toBe(-17);
    expect(r.gainsDb).toEqual([-9, 3]);
    expect(r.limitedBy).toBe(1);
  });

  it('names the slot that forced the lowest target', () => {
    const r = computeMatch(
      [
        { integratedLufs: -18, truePeakDbtp: -3 }, // allows -16
        { integratedLufs: -22, truePeakDbtp: -2 }, // allows -21
        { integratedLufs: -16, truePeakDbtp: -2 }, // allows -15
      ],
      -14,
    );
    expect(r.effectiveTargetLufs).toBe(-21);
    expect(r.limitedBy).toBe(1);
  });

  it('leaves silent slots at unity and ignores them for the ceiling', () => {
    const r = computeMatch(
      [
        { integratedLufs: -14, truePeakDbtp: -2 },
        { integratedLufs: -Infinity, truePeakDbtp: -Infinity },
      ],
      -14,
    );
    expect(r.gainsDb).toEqual([0, 0]);
    expect(r.limitedBy).toBeNull();
  });
});
