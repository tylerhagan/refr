/// <reference lib="webworker" />
import { integratedLoudness, truePeak } from './loudness';

export interface LoudnessRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

export type LoudnessResponse =
  | { id: number; type: 'progress'; fraction: number }
  | {
      id: number;
      type: 'done';
      integratedLufs: number;
      truePeakDbtp: number;
      /** Time spent in each measurement, for the debug panel. */
      loudnessMs: number;
      truePeakMs: number;
    };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<LoudnessRequest>) => {
  const { id, channels, sampleRate } = event.data;
  let lastReported = 0;
  const report = (fraction: number) => {
    // Throttle to whole percent steps; the ring does not need more.
    if (fraction - lastReported >= 0.01 || fraction === 1) {
      lastReported = fraction;
      self.postMessage({ id, type: 'progress', fraction } satisfies LoudnessResponse);
    }
  };

  let t = performance.now();
  const integratedLufs = integratedLoudness(channels, sampleRate, (f) => report(f * 0.5));
  const loudnessMs = performance.now() - t;
  t = performance.now();
  const truePeakDbtp = truePeak(channels, (f) => report(0.5 + f * 0.5));
  const truePeakMs = performance.now() - t;

  self.postMessage({
    id,
    type: 'done',
    integratedLufs,
    truePeakDbtp,
    loudnessMs,
    truePeakMs,
  } satisfies LoudnessResponse);
};
