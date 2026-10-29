import { isAiff, parseAiff, toAudioBuffer } from './aiff';

/** Decode a file to an AudioBuffer. AIFF goes through our own reader, the rest through the browser. */
export async function decodeFile(ctx: BaseAudioContext, file: Blob): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  if (isAiff(bytes)) return toAudioBuffer(ctx, parseAiff(bytes));
  return ctx.decodeAudioData(bytes);
}
