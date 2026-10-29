// ITU-R BS.1770-4 integrated loudness (gated) and 4x oversampled true peak.
// Pure functions with no DOM or Web Audio dependency, so the same code runs in the
// analysis worker and in Vitest.

export interface LoudnessResult {
  /** Integrated loudness in LUFS. -Infinity when every block is below the absolute gate. */
  integratedLufs: number;
  /** True peak in dBTP (4x oversampled, per BS.1770-4 Annex 2). -Infinity for digital silence. */
  truePeakDbtp: number;
}

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages for any sample rate, derived from the analogue prototype
 * (the same derivation libebur128 uses). At 48 kHz this reproduces the coefficient
 * table in BS.1770-4.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, about +4 dB above ~1.7 kHz (head effects).
  let f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };

  // Stage 2: RLB high-pass at ~38 Hz.
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };

  return [shelf, highpass];
}

/** Per-channel weights G_i from BS.1770-4 for the channel orders Web Audio uses. */
function channelWeights(channelCount: number): number[] {
  if (channelCount === 1) {
    // A mono file plays from both speakers, so measure it as dual mono. That keeps it
    // fair against stereo files: it is heard 3 dB louder than a single channel.
    return [2];
  }
  if (channelCount === 6) {
    // 5.1 in Web Audio order: L, R, C, LFE, SL, SR. The LFE is excluded.
    return [1, 1, 1, 0, 1.41, 1.41];
  }
  return new Array<number>(channelCount).fill(1);
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

const toLufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/**
 * Integrated loudness over the whole signal. Blocks are 400 ms with 75% overlap, built
 * from 100 ms segments of K-weighted energy; a trailing partial block is dropped.
 * `onProgress` receives 0..1 for the analysis progress ring.
 */
export function integratedLoudness(
  channels: Float32Array[],
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): number {
  const length = channels[0]?.length ?? 0;
  const hop = Math.round(sampleRate * 0.1);
  const segmentCount = Math.floor(length / hop);
  if (segmentCount < 4) return -Infinity;

  const weights = channelWeights(channels.length);
  const [s, h] = kWeightingFilters(sampleRate);
  // Weighted K-filtered energy per 100 ms segment, summed over channels.
  const segmentEnergy = new Float64Array(segmentCount);

  // Coefficients as locals: property loads in the inner loop are costly when the JIT is off.
  const { b0: sb0, b1: sb1, b2: sb2, a1: sa1, a2: sa2 } = s;
  const { a1: ha1, a2: ha2 } = h;

  for (let c = 0; c < channels.length; c++) {
    const weight = weights[c];
    if (weight === 0) continue;
    const x = channels[c];
    // Direct form I state for both stages.
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0,
      z1 = 0,
      z2 = 0;
    for (let seg = 0; seg < segmentCount; seg++) {
      let sum = 0;
      const end = (seg + 1) * hop;
      for (let i = seg * hop; i < end; i++) {
        const x0 = x[i];
        const y0 = sb0 * x0 + sb1 * x1 + sb2 * x2 - sa1 * y1 - sa2 * y2;
        x2 = x1;
        x1 = x0;
        const zOut = y0 - 2 * y1 + y2 - ha1 * z1 - ha2 * z2;
        y2 = y1;
        y1 = y0;
        z2 = z1;
        z1 = zOut;
        sum += zOut * zOut;
      }
      segmentEnergy[seg] += weight * sum;
    }
    onProgress?.((c + 1) / channels.length);
  }

  const blockCount = segmentCount - 3;
  const blockLen = hop * 4;
  const blocks = new Float64Array(blockCount);
  for (let j = 0; j < blockCount; j++) {
    blocks[j] =
      (segmentEnergy[j] + segmentEnergy[j + 1] + segmentEnergy[j + 2] + segmentEnergy[j + 3]) /
      blockLen;
  }

  const absoluteThreshold = Math.pow(10, (ABSOLUTE_GATE_LUFS + 0.691) / 10);
  let sum = 0;
  let count = 0;
  for (const z of blocks) {
    if (z > absoluteThreshold) {
      sum += z;
      count++;
    }
  }
  if (count === 0) return -Infinity;

  const relativeThreshold = (sum / count) * Math.pow(10, RELATIVE_GATE_LU / 10);
  sum = 0;
  count = 0;
  for (const z of blocks) {
    if (z > absoluteThreshold && z > relativeThreshold) {
      sum += z;
      count++;
    }
  }
  return count === 0 ? -Infinity : toLufs(sum / count);
}

// BS.1770-4 Annex 2: 48-tap interpolation filter, four phases of 12 taps.
const TRUE_PEAK_PHASES: readonly (readonly number[])[] = [
  [
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875,
    0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125,
    0.014892578125, -0.00830078125,
  ],
  [
    -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  ],
  [
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
  ],
  [
    -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125,
    0.001708984375,
  ],
];
const TAPS = 12;
const CHUNK = 64;

/**
 * No interpolated value can exceed the largest input in its window by more than the
 * largest sum of |coefficients| over the phases (about 2.02). Chunks whose inputs are all
 * that far below the peak found so far cannot raise it, so they are skipped.
 */
const INTERPOLATION_BOUND = Math.max(
  ...TRUE_PEAK_PHASES.map((phase) => phase.reduce((sum, h) => sum + Math.abs(h), 0)),
);

/** Highest absolute value of the 4x oversampled signal across channels, in dBTP. */
export function truePeak(
  channels: Float32Array[],
  onProgress?: (fraction: number) => void,
): number {
  let peak = 0;
  // The sample peak counts too, so the result is never below it. Finding it first also
  // gives the chunk skip a high bar from the start.
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
    }
  }

  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    const n = x.length;
    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK);
      let windowMax = 0;
      for (let i = Math.max(0, start - TAPS + 1); i < end; i++) {
        const a = Math.abs(x[i]);
        if (a > windowMax) windowMax = a;
      }
      if (windowMax * INTERPOLATION_BOUND <= peak) continue;
      const chunkPeak = interpolatedPeak(x, start, end);
      if (chunkPeak > peak) peak = chunkPeak;
    }
    onProgress?.((c + 1) / channels.length);
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

// Coefficients as locals: phases 2 and 3 are phases 1 and 0 reversed.
const [
  [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11],
  [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11],
] = TRUE_PEAK_PHASES as number[][];

/**
 * Peak of the four interpolated phases for outputs start..end-1. Output m uses inputs
 * m-11..m (s0 is the newest); the 12 inputs are kept in a shift register of locals, which
 * JITs far better than indexing into the coefficient arrays.
 */
// prettier-ignore
function interpolatedPeak(x: Float32Array, start: number, end: number): number {
  const at = (i: number) => (i >= 0 ? x[i] : 0);
  let s1 = at(start - 1), s2 = at(start - 2), s3 = at(start - 3), s4 = at(start - 4);
  let s5 = at(start - 5), s6 = at(start - 6), s7 = at(start - 7), s8 = at(start - 8);
  let s9 = at(start - 9), s10 = at(start - 10), s11 = at(start - 11);
  let peak = 0;
  for (let m = start; m < end; m++) {
    const s0 = x[m];
    const v0 =
      a0 * s0 + a1 * s1 + a2 * s2 + a3 * s3 + a4 * s4 + a5 * s5 +
      a6 * s6 + a7 * s7 + a8 * s8 + a9 * s9 + a10 * s10 + a11 * s11;
    const v1 =
      b0 * s0 + b1 * s1 + b2 * s2 + b3 * s3 + b4 * s4 + b5 * s5 +
      b6 * s6 + b7 * s7 + b8 * s8 + b9 * s9 + b10 * s10 + b11 * s11;
    const v2 =
      b11 * s0 + b10 * s1 + b9 * s2 + b8 * s3 + b7 * s4 + b6 * s5 +
      b5 * s6 + b4 * s7 + b3 * s8 + b2 * s9 + b1 * s10 + b0 * s11;
    const v3 =
      a11 * s0 + a10 * s1 + a9 * s2 + a8 * s3 + a7 * s4 + a6 * s5 +
      a5 * s6 + a4 * s7 + a3 * s8 + a2 * s9 + a1 * s10 + a0 * s11;
    const a = Math.max(Math.abs(v0), Math.abs(v1), Math.abs(v2), Math.abs(v3));
    if (a > peak) peak = a;
    s11 = s10; s10 = s9; s9 = s8; s8 = s7; s7 = s6; s6 = s5;
    s5 = s4; s4 = s3; s3 = s2; s2 = s1; s1 = s0;
  }
  return peak;
}

export function measure(
  channels: Float32Array[],
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): LoudnessResult {
  const integratedLufs = integratedLoudness(channels, sampleRate, (f) => onProgress?.(f * 0.5));
  const truePeakDbtp = truePeak(channels, (f) => onProgress?.(0.5 + f * 0.5));
  return { integratedLufs, truePeakDbtp };
}
