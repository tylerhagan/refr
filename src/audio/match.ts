// Loudness match gains. Every slot is brought to one effective target; if any slot would
// then exceed the true-peak ceiling, the target drops for every slot by the same amount,
// so the slots stay matched. One slot is never clamped on its own.

export const TRUE_PEAK_CEILING_DBTP = -1;

export interface MatchInput {
  integratedLufs: number;
  truePeakDbtp: number;
}

export interface MatchResult {
  /** The target every slot actually sits at, after any lowering. */
  effectiveTargetLufs: number;
  /** Gain to apply per slot, in dB, same order as the input. */
  gainsDb: number[];
  /** Index of the slot that forced the target down, or null if the requested target held. */
  limitedBy: number | null;
}

export function computeMatch(
  slots: MatchInput[],
  targetLufs: number,
  ceilingDbtp = TRUE_PEAK_CEILING_DBTP,
): MatchResult {
  let effectiveTargetLufs = targetLufs;
  let limitedBy: number | null = null;

  slots.forEach((slot, i) => {
    // Silent slots cannot be matched; they keep unity gain and never limit the target.
    if (!Number.isFinite(slot.integratedLufs) || !Number.isFinite(slot.truePeakDbtp)) return;
    const peakAfter = slot.truePeakDbtp + (effectiveTargetLufs - slot.integratedLufs);
    if (peakAfter > ceilingDbtp) {
      effectiveTargetLufs -= peakAfter - ceilingDbtp;
      limitedBy = i;
    }
  });

  const gainsDb = slots.map((slot) =>
    Number.isFinite(slot.integratedLufs) ? effectiveTargetLufs - slot.integratedLufs : 0,
  );
  return { effectiveTargetLufs, gainsDb, limitedBy };
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
