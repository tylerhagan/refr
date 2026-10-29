// A small AIFF / AIFF-C reader. Chrome's decodeAudioData cannot read AIFF, so this is used
// on every platform and results are identical everywhere.
//
// Supported: big-endian PCM at 8, 16, 24 and 32 bits; AIFF-C 'NONE' and 'twos' (big-endian
// PCM), 'sowt' (little-endian PCM) and 'fl32' / 'FL32' (big-endian float32).

export interface ParsedAiff {
  sampleRate: number;
  channels: Float32Array[];
}

const fourCC = (view: DataView, offset: number) =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );

export function isAiff(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes);
  const kind = fourCC(view, 8);
  return fourCC(view, 0) === 'FORM' && (kind === 'AIFF' || kind === 'AIFC');
}

/** Decode the 80-bit IEEE 754 extended-precision float used for the sample rate. */
function readExtended(view: DataView, offset: number): number {
  const se = view.getUint16(offset);
  const sign = se & 0x8000 ? -1 : 1;
  const exponent = se & 0x7fff;
  const hi = view.getUint32(offset + 2);
  const lo = view.getUint32(offset + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  if (exponent === 0x7fff) return sign * Infinity;
  // The mantissa has an explicit leading integer bit: value = mantissa * 2^(exp - 16383 - 63).
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

export function parseAiff(bytes: ArrayBuffer): ParsedAiff {
  if (!isAiff(bytes)) throw new Error('Not an AIFF file');
  const view = new DataView(bytes);
  const isAifc = fourCC(view, 8) === 'AIFC';

  let numChannels = 0;
  let numFrames = 0;
  let bitDepth = 0;
  let sampleRate = 0;
  let compression = 'NONE';
  let haveComm = false;
  let dataStart = -1;
  let dataEnd = -1;

  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = fourCC(view, pos);
    const size = view.getUint32(pos + 4);
    const body = pos + 8;
    if (id === 'COMM') {
      if (size < 18 || body + 18 > bytes.byteLength) throw new Error('AIFF: COMM chunk too short');
      numChannels = view.getUint16(body);
      numFrames = view.getUint32(body + 2);
      bitDepth = view.getUint16(body + 6);
      sampleRate = readExtended(view, body + 8);
      if (isAifc) {
        if (size < 22 || body + 22 > bytes.byteLength) {
          throw new Error('AIFF-C: COMM chunk missing compression type');
        }
        compression = fourCC(view, body + 18);
      }
      haveComm = true;
    } else if (id === 'SSND' && dataStart < 0) {
      if (size < 8 || body + 8 > bytes.byteLength) throw new Error('AIFF: SSND chunk too short');
      const offset = view.getUint32(body); // blockSize at body + 4 is irrelevant to reading
      dataStart = body + 8 + offset;
      // Tolerate a size that runs past the end of a truncated file.
      dataEnd = Math.min(body + size, bytes.byteLength);
    }
    pos = body + size + (size & 1); // chunks are padded to an even length
  }

  if (!haveComm) throw new Error('AIFF: missing COMM chunk');
  if (dataStart < 0) throw new Error('AIFF: missing SSND chunk');
  if (numChannels < 1) throw new Error('AIFF: no channels');
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('AIFF: bad sample rate');

  let littleEndian = false;
  let float = false;
  switch (compression) {
    case 'NONE':
    case 'twos':
      break;
    case 'sowt':
      littleEndian = true;
      break;
    case 'fl32':
    case 'FL32':
      float = true;
      break;
    default:
      throw new Error(`AIFF-C: unsupported compression type '${compression}'`);
  }
  if (float) {
    if (bitDepth !== 32) throw new Error('AIFF-C: float32 data must be 32 bits');
  } else if (![8, 16, 24, 32].includes(bitDepth)) {
    throw new Error(`AIFF: unsupported bit depth ${bitDepth}`);
  }

  const bytesPerSample = bitDepth / 8;
  const frameSize = bytesPerSample * numChannels;
  const available = Math.max(0, Math.floor((dataEnd - dataStart) / frameSize));
  const frames = Math.min(numFrames, available);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    let p = dataStart + f * frameSize;
    for (let c = 0; c < numChannels; c++, p += bytesPerSample) {
      let v: number;
      if (float) v = view.getFloat32(p, false);
      else if (bitDepth === 8) v = view.getInt8(p) / 128;
      else if (bitDepth === 16) v = view.getInt16(p, littleEndian) / 32768;
      else if (bitDepth === 24) {
        const raw = littleEndian
          ? view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16)
          : (view.getUint8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2);
        v = ((raw << 8) >> 8) / 8388608; // sign-extend 24 bits
      } else v = view.getInt32(p, littleEndian) / 2147483648;
      channels[c][f] = v;
    }
  }
  return { sampleRate, channels };
}

export function toAudioBuffer(ctx: BaseAudioContext, parsed: ParsedAiff): AudioBuffer {
  const length = parsed.channels[0]?.length ?? 0;
  if (length === 0) throw new Error('AIFF: file contains no audio');
  const buffer = ctx.createBuffer(parsed.channels.length, length, parsed.sampleRate);
  parsed.channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
  return buffer;
}
