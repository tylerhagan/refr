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
        const y0 = s.b0 * x0 + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1;
        x1 = x0;
        const zOut = y0 - 2 * y1 + y2 - h.a1 * z1 - h.a2 * z2;
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

/** Highest absolute value of the 4x oversampled signal across channels, in dBTP. */
export function truePeak(
  channels: Float32Array[],
  onProgress?: (fraction: number) => void,
): number {
  let peak = 0;
  const [p0, p1, p2, p3] = TRUE_PEAK_PHASES;
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    const n = x.length;
    // The sample peak counts too, so the result is never below it.
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
    }
    // Interpolated values: output m uses inputs m-11..m, newest first.
    for (let m = 0; m < n; m++) {
      let v0 = 0,
        v1 = 0,
        v2 = 0,
        v3 = 0;
      const first = m - TAPS + 1;
      if (first >= 0) {
        for (let t = 0; t < TAPS; t++) {
          const s = x[m - t];
          v0 += p0[t] * s;
          v1 += p1[t] * s;
          v2 += p2[t] * s;
          v3 += p3[t] * s;
        }
      } else {
        for (let t = 0; t <= m; t++) {
          const s = x[m - t];
          v0 += p0[t] * s;
          v1 += p1[t] * s;
          v2 += p2[t] * s;
          v3 += p3[t] * s;
        }
      }
      const a = Math.max(Math.abs(v0), Math.abs(v1), Math.abs(v2), Math.abs(v3));
      if (a > peak) peak = a;
    }
    onProgress?.((c + 1) / channels.length);
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
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
