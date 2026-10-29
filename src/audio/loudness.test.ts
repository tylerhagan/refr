import { describe, expect, it } from 'vitest';
import { integratedLoudness, kWeightingFilters, measure, truePeak } from './loudness';

const FS = 48000;

/** Sine segments, each [dBFS peak, seconds], concatenated with continuous phase. */
function sine(segments: [number, number][], freq = 1000, fs = FS, phase = 0): Float32Array {
  const total = segments.reduce((n, [, secs]) => n + Math.round(secs * fs), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const [db, secs] of segments) {
    const amp = Math.pow(10, db / 20);
    const n = Math.round(secs * fs);
    for (let k = 0; k < n; k++, i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  }
  return out;
}

const stereo = (x: Float32Array) => [x, x.slice()];

describe('K-weighting', () => {
  it('matches the BS.1770-4 coefficient table at 48 kHz', () => {
    const [shelf, hp] = kWeightingFilters(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 10);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 10);
  });
});

// EBU Tech 3341 minimum requirements, cases 1-5 (stereo 1 kHz sine), tolerance ±0.1 LU.
describe('integrated loudness (EBU Tech 3341)', () => {
  it('case 1: -23 dBFS for 20 s reads -23 LUFS', () => {
    expect(integratedLoudness(stereo(sine([[-23, 20]])), FS)).toBeCloseTo(-23, 1);
  });

  it('case 2: -33 dBFS for 20 s reads -33 LUFS', () => {
    expect(integratedLoudness(stereo(sine([[-33, 20]])), FS)).toBeCloseTo(-33, 1);
  });

  it('case 3: relative gate removes the quiet ends', () => {
    const x = sine([[-36, 10], [-23, 60], [-36, 10]]);
    expect(integratedLoudness(stereo(x), FS)).toBeCloseTo(-23, 1);
  });

  it('case 4: absolute and relative gates together', () => {
    const x = sine([[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]]);
    expect(integratedLoudness(stereo(x), FS)).toBeCloseTo(-23, 1);
  });

  it('case 5: -26 / -20 / -26 dBFS averages to -23 LUFS', () => {
    const x = sine([[-26, 20], [-20, 20.1], [-26, 20]]);
    expect(integratedLoudness(stereo(x), FS)).toBeCloseTo(-23, 1);
  });

  it('works at 44.1 kHz', () => {
    const x = sine([[-23, 20]], 1000, 44100);
    expect(integratedLoudness(stereo(x), 44100)).toBeCloseTo(-23, 1);
  });

  it('measures mono as dual mono, so it matches the same signal in stereo', () => {
    const x = sine([[-23, 20]]);
    expect(integratedLoudness([x], FS)).toBeCloseTo(integratedLoudness(stereo(x), FS), 6);
  });

  it('returns -Infinity for silence and for clips under 400 ms', () => {
    expect(integratedLoudness(stereo(new Float32Array(FS * 5)), FS)).toBe(-Infinity);
    expect(integratedLoudness(stereo(sine([[-23, 0.3]])), FS)).toBe(-Infinity);
  });
});

describe('true peak', () => {
  it('finds the inter-sample peak of a quarter-rate sine sampled off its crest', () => {
    // fs/4 with a 45° phase: every sample lands at ±0.707 of the real peak (-3 dB).
    const x = sine([[-6.0206, 1]], FS / 4, FS, Math.PI / 4);
    const samplePeakDb = 20 * Math.log10(Math.max(...x.map(Math.abs)));
    expect(samplePeakDb).toBeCloseTo(-9.03, 1);
    const tp = truePeak([x]);
    // EBU Tech 3341 allows +0.2 / -0.4 dB.
    expect(tp).toBeGreaterThan(-6.0206 - 0.4);
    expect(tp).toBeLessThan(-6.0206 + 0.2);
  });

  it('is never below the sample peak', () => {
    const x = sine([[-1, 1]], 997);
    expect(truePeak([x])).toBeGreaterThanOrEqual(-1 - 1e-6);
  });

  it('returns -Infinity for digital silence', () => {
    expect(truePeak([new Float32Array(1000)])).toBe(-Infinity);
  });
});

describe('measure', () => {
  it('reports progress from 0 to 1', () => {
    const seen: number[] = [];
    measure(stereo(sine([[-23, 2]])), FS, (f) => seen.push(f));
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((f, i) => i === 0 || f >= seen[i - 1])).toBe(true);
  });
});
