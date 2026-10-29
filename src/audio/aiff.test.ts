import { describe, expect, it } from 'vitest';
import { isAiff, parseAiff } from './aiff';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];

/** 80-bit extended float for a positive integer. */
function extended(rate: number): number[] {
  const exp = Math.floor(Math.log2(rate));
  const mant = BigInt(rate) << BigInt(63 - exp);
  const out = [...u16(16383 + exp)];
  for (let i = 7; i >= 0; i--) out.push(Number((mant >> BigInt(i * 8)) & 255n));
  return out;
}

function chunk(id: string, body: number[]): number[] {
  return [...ascii(id), ...u32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
}

interface Opts {
  kind?: 'AIFF' | 'AIFC';
  channels: number;
  frames: number;
  bits: number;
  rate: number;
  data: number[];
  compression?: string;
  before?: number[];
}

function build(o: Opts): ArrayBuffer {
  const comm = [...u16(o.channels), ...u32(o.frames), ...u16(o.bits), ...extended(o.rate)];
  if (o.kind === 'AIFC') comm.push(...ascii(o.compression ?? 'NONE'), 0, 0); // empty pstring
  const body = [
    ...ascii(o.kind ?? 'AIFF'),
    ...chunk('COMM', comm),
    ...(o.before ?? []),
    ...chunk('SSND', [...u32(0), ...u32(0), ...o.data]),
  ];
  return new Uint8Array([...ascii('FORM'), ...u32(body.length), ...body]).buffer;
}

describe('parseAiff', () => {
  it('reads 16-bit stereo exactly', () => {
    const data = [...u16(0x4000), ...u16(0xc000), ...u16(0x7fff), ...u16(0x8000)];
    const file = build({ channels: 2, frames: 2, bits: 16, rate: 44100, data });
    expect(isAiff(file)).toBe(true);
    const { sampleRate, channels } = parseAiff(file);
    expect(sampleRate).toBe(44100);
    expect(channels).toHaveLength(2);
    expect([...channels[0]]).toEqual([0.5, 32767 / 32768]);
    expect([...channels[1]]).toEqual([-0.5, -1]);
  });

  it('reads 24-bit mono exactly at 48 kHz', () => {
    const data = [0x40, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x7f, 0xff, 0xff, 0x80, 0x00, 0x00];
    const { sampleRate, channels } = parseAiff(
      build({ channels: 1, frames: 4, bits: 24, rate: 48000, data }),
    );
    expect(sampleRate).toBe(48000);
    expect([...channels[0]]).toEqual([0.5, -0.5, 8388607 / 8388608, -1]);
  });

  it('reads 8-bit and 32-bit PCM', () => {
    const eight = parseAiff(
      build({ channels: 1, frames: 2, bits: 8, rate: 44100, data: [64, 0x80] }),
    );
    expect([...eight.channels[0]]).toEqual([0.5, -1]);
    const data = [0x40, 0, 0, 0, 0xc0, 0, 0, 0];
    const thirtyTwo = parseAiff(build({ channels: 1, frames: 2, bits: 32, rate: 44100, data }));
    expect([...thirtyTwo.channels[0]]).toEqual([0.5, -0.5]);
  });

  it('reads AIFC sowt as little-endian', () => {
    const data = [0x00, 0x40, 0x00, 0xc0]; // 0x4000, 0xc000 little-endian
    const file = build({
      kind: 'AIFC',
      compression: 'sowt',
      channels: 1,
      frames: 2,
      bits: 16,
      rate: 44100,
      data,
    });
    expect(isAiff(file)).toBe(true);
    expect([...parseAiff(file).channels[0]]).toEqual([0.5, -0.5]);
  });

  it('reads AIFC fl32 as big-endian float', () => {
    const data = [0x3f, 0x00, 0x00, 0x00, 0xbe, 0x80, 0x00, 0x00]; // 0.5, -0.25
    const file = build({
      kind: 'AIFC',
      compression: 'fl32',
      channels: 1,
      frames: 2,
      bits: 32,
      rate: 44100,
      data,
    });
    expect([...parseAiff(file).channels[0]]).toEqual([0.5, -0.25]);
  });

  it('skips unknown chunks, including odd-sized ones with padding', () => {
    const before = [...chunk('JUNK', [1, 2, 3]), ...chunk('ANNO', ascii('hello!'))];
    const data = [...u16(0x2000), ...u16(0x1000)];
    const file = build({ channels: 1, frames: 2, bits: 16, rate: 44100, data, before });
    expect([...parseAiff(file).channels[0]]).toEqual([0.25, 0.125]);
  });

  it('rejects unsupported compression', () => {
    const file = build({
      kind: 'AIFC',
      compression: 'ima4',
      channels: 1,
      frames: 1,
      bits: 16,
      rate: 44100,
      data: [0, 0],
    });
    expect(() => parseAiff(file)).toThrow(/unsupported compression type 'ima4'/);
  });

  it('rejects non-AIFF data', () => {
    const junk = new Uint8Array(32).buffer;
    expect(isAiff(junk)).toBe(false);
    expect(() => parseAiff(junk)).toThrow(/Not an AIFF/);
  });
});
