// Main-thread side of loudness analysis. decodeAudioData cannot run in a worker, so the
// caller decodes and hands the AudioBuffer here; the samples are copied out, transferred
// to the worker, and the caller can drop the buffer.
import type { LoudnessResult } from './loudness';
import type { LoudnessRequest, LoudnessResponse } from './loudness.worker';

export interface AnalysisResult extends LoudnessResult {
  /** Time the worker spent measuring, for the debug panel. */
  ms: number;
}

let worker: Worker | null = null;
let nextId = 1;
// Measurements run one at a time: each copy briefly doubles that file's memory.
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  worker ??= new Worker(new URL('./loudness.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export function analyse(
  buffer: AudioBuffer,
  onProgress?: (fraction: number) => void,
): Promise<AnalysisResult> {
  const run = () =>
    new Promise<AnalysisResult>((resolve, reject) => {
      const id = nextId++;
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(buffer.getChannelData(c).slice());
      }
      const w = getWorker();
      const onMessage = (event: MessageEvent<LoudnessResponse>) => {
        const msg = event.data;
        if (msg.id !== id) return;
        if (msg.type === 'progress') {
          onProgress?.(msg.fraction);
          return;
        }
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        resolve({ integratedLufs: msg.integratedLufs, truePeakDbtp: msg.truePeakDbtp, ms: msg.ms });
      };
      const onError = (event: ErrorEvent) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        reject(new Error(event.message || 'Loudness worker failed'));
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      const request: LoudnessRequest = { id, channels, sampleRate: buffer.sampleRate };
      w.postMessage(
        request,
        channels.map((ch) => ch.buffer as ArrayBuffer),
      );
    });

  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
