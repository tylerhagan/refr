/// <reference lib="webworker" />
import { measure } from './loudness';

export interface LoudnessRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

export type LoudnessResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'done'; integratedLufs: number; truePeakDbtp: number; ms: number };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<LoudnessRequest>) => {
  const { id, channels, sampleRate } = event.data;
  const started = performance.now();
  let lastReported = 0;
  const result = measure(channels, sampleRate, (fraction) => {
    // Throttle to whole percent steps; the ring does not need more.
    if (fraction - lastReported >= 0.01 || fraction === 1) {
      lastReported = fraction;
      self.postMessage({ id, type: 'progress', fraction } satisfies LoudnessResponse);
    }
  });
  self.postMessage({
    id,
    type: 'done',
    ...result,
    ms: performance.now() - started,
  } satisfies LoudnessResponse);
};
