/** Peak envelope for the waveform: max |sample| over all channels in each of `points` buckets. */
export function computeOverview(channels: Float32Array[], points = 1000): Float32Array {
  const out = new Float32Array(points);
  const length = channels[0]?.length ?? 0;
  if (length === 0 || points <= 0) return out;
  for (let i = 0; i < points; i++) {
    const start = Math.floor((i * length) / points);
    // Always cover at least one sample, so a short buffer still fills every bucket.
    const end = Math.max(start + 1, Math.floor(((i + 1) * length) / points));
    let peak = 0;
    for (const ch of channels) {
      for (let s = start; s < end; s++) {
        const v = Math.abs(ch[s]);
        if (v > peak) peak = v;
      }
    }
    out[i] = peak;
  }
  return out;
}
