// The playback engine: one AudioContext, every slot playing in parallel on one clock.
//
//   source ─► slot gain ─┐                       ┌─► full ──────────────────► gain ─┐
//   source ─► slot gain ─┼─► bus ─► (all four) ──┼─► lowpass 120 ───────────► gain ─┼─► bands ─┬─► stereo gain ─┬─► transport ─► out
//   source ─► slot gain ─┘                       ├─► hp 120 ─► lp 5k ───────► gain ─┤          └─► mono ─► gain ─┘
//                                                └─► highpass 5k ───────────► gain ─┘
//
// The flip, band and mono changes are all 10 ms linear crossfades between paths that are
// always running, so nothing is ever retuned or reconnected while you listen. Everything
// after the bus is shared, so it is applied equally to every slot. Only the per-slot match
// gain and offset differ.
//
// Time is measured on Mine's timeline. A slot's file position is `mineTime + offsetSeconds`,
// so a positive offset skips into the slot and a negative one delays its start.
import { dbToGain } from './match';

export type Band = 'full' | 'low' | 'mid' | 'high';

export interface EngineSlot {
  id: string;
  buffer: AudioBuffer;
  /** Seconds; slot file position = Mine time + offset. Mine's offset is 0. */
  offsetSeconds: number;
  /** Match gain from computeMatch. */
  gainDb: number;
}

export type TransportState = 'stopped' | 'playing' | 'paused';

const FADE = 0.01; // 10 ms for flip, band and mono crossfades
const SEEK_FADE = 0.005; // short dip around restarts so seeks never click
const LEAD = 0.03; // scheduling headroom so every source starts on the same frame
const LOW_HZ = 120;
const HIGH_HZ = 5000;
const BUTTERWORTH_Q = Math.SQRT1_2;

interface AudioSessionNavigator {
  audioSession?: { type: string };
}

interface PlayingSlot {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private bandGains!: Record<Band, GainNode>;
  private stereoGain!: GainNode;
  private monoGain!: GainNode;
  private transport!: GainNode;

  private slots: EngineSlot[] = [];
  private slotGains = new Map<string, GainNode>();
  private playing: PlayingSlot[] = [];
  private generation = 0;

  private activeId: string | null = null;
  private band: Band = 'full';
  private mono = false;
  private loop: { start: number; end: number } | null = null;
  private loopEnabled = false;
  private stopAtShortest = false;

  private state: TransportState = 'stopped';
  /** Mine time at the moment playback (re)started, and the context time it started at. */
  private anchorMineTime = 0;
  private anchorCtxTime = 0;
  private pausedAt = 0;

  /** Called when playback reaches the end on its own. */
  onEnded: (() => void) | null = null;

  /**
   * The context, created on first use. Creating it outside a gesture is allowed; it just
   * starts suspended until `unlock()` runs inside one.
   */
  get context(): AudioContext {
    if (!this.ctx) this.build();
    return this.ctx!;
  }

  /** Call from a tap handler (the play button). Resumes the context on iOS. */
  async unlock(): Promise<void> {
    const ctx = this.context;
    if (ctx.state !== 'running') await ctx.resume();
  }

  private build() {
    // Without this the iPhone silent switch mutes Web Audio. It must be set before the
    // context exists. Safari only; other browsers ignore it.
    const nav = navigator as Navigator & AudioSessionNavigator;
    if (nav.audioSession) nav.audioSession.type = 'playback';

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.bus = ctx.createGain();

    const filter = (type: BiquadFilterType, frequency: number) =>
      new BiquadFilterNode(ctx, { type, frequency, Q: BUTTERWORTH_Q });
    const bands = ctx.createGain();
    const make = (band: Band, chain: AudioNode[]) => {
      const g = new GainNode(ctx, { gain: band === this.band ? 1 : 0 });
      let prev: AudioNode = this.bus;
      for (const node of chain) {
        prev.connect(node);
        prev = node;
      }
      prev.connect(g);
      g.connect(bands);
      return g;
    };
    this.bandGains = {
      full: make('full', []),
      low: make('low', [filter('lowpass', LOW_HZ)]),
      mid: make('mid', [filter('highpass', LOW_HZ), filter('lowpass', HIGH_HZ)]),
      high: make('high', [filter('highpass', HIGH_HZ)]),
    };

    // Mono: forcing one channel with 'speakers' interpretation downmixes to (L+R)/2, and
    // the stereo destination copies it to both ears, so centred material keeps its level.
    const monoSum = new GainNode(ctx, {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.stereoGain = new GainNode(ctx, { gain: this.mono ? 0 : 1 });
    this.monoGain = new GainNode(ctx, { gain: this.mono ? 1 : 0 });
    this.transport = new GainNode(ctx, { gain: 1 });
    bands.connect(this.stereoGain).connect(this.transport);
    bands.connect(monoSum).connect(this.monoGain).connect(this.transport);
    this.transport.connect(ctx.destination);
  }

  // ── Slots ────────────────────────────────────────────────────────────────

  /** Replace the session's slots. Keeps playing from the same position if it was. */
  setSlots(slots: EngineSlot[]) {
    const ctx = this.context;
    const wasPlaying = this.state === 'playing';
    const position = this.position;
    if (wasPlaying) this.fadeOutAndStop();

    for (const g of this.slotGains.values()) g.disconnect();
    this.slotGains.clear();
    this.slots = slots;
    for (const slot of slots) {
      const g = new GainNode(ctx, { gain: 0 });
      g.connect(this.bus);
      this.slotGains.set(slot.id, g);
    }
    if (!slots.some((s) => s.id === this.activeId)) this.activeId = slots[0]?.id ?? null;
    this.applySlotGains(0);

    if (wasPlaying) this.startSources(Math.min(position, this.endTime), SEEK_FADE);
    else this.pausedAt = Math.min(position, this.endTime);
  }

  /** Update one slot's match gain or offset without rebuilding the session. */
  updateSlot(id: string, patch: Partial<Pick<EngineSlot, 'gainDb' | 'offsetSeconds'>>) {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) return;
    const offsetChanged =
      patch.offsetSeconds !== undefined && patch.offsetSeconds !== slot.offsetSeconds;
    Object.assign(slot, patch);
    if (offsetChanged && this.state === 'playing') this.restart(this.position);
    else this.applySlotGains(FADE);
  }

  // ── The flip ─────────────────────────────────────────────────────────────

  get activeSlotId(): string | null {
    return this.activeId;
  }

  /** Make one slot audible. Never restarts playback or moves the playhead. */
  flip(id: string) {
    if (id === this.activeId || !this.slotGains.has(id)) return;
    this.activeId = id;
    this.applySlotGains(FADE);
  }

  private applySlotGains(fade: number) {
    for (const slot of this.slots) {
      const g = this.slotGains.get(slot.id)!;
      ramp(g.gain, slot.id === this.activeId ? dbToGain(slot.gainDb) : 0, this.context, fade);
    }
  }

  // ── Shared processing ────────────────────────────────────────────────────

  setBand(band: Band) {
    if (band === this.band) return;
    this.band = band;
    if (!this.ctx) return;
    for (const [b, g] of Object.entries(this.bandGains) as [Band, GainNode][]) {
      ramp(g.gain, b === band ? 1 : 0, this.ctx, FADE);
    }
  }

  setMono(mono: boolean) {
    if (mono === this.mono) return;
    this.mono = mono;
    if (!this.ctx) return;
    ramp(this.stereoGain.gain, mono ? 0 : 1, this.ctx, FADE);
    ramp(this.monoGain.gain, mono ? 1 : 0, this.ctx, FADE);
  }

  // ── Loop ─────────────────────────────────────────────────────────────────

  /**
   * The part of Mine's timeline where every slot has audio. A loop must sit inside it:
   * a native loop region that ran off one slot's file would loop a different length and
   * drift out of time.
   */
  get loopableRange(): { start: number; end: number } {
    let start = 0;
    let end = Infinity;
    for (const s of this.slots) {
      start = Math.max(start, -s.offsetSeconds);
      end = Math.min(end, s.buffer.duration - s.offsetSeconds);
    }
    return { start, end: Number.isFinite(end) ? Math.max(start, end) : start };
  }

  /** Set the loop region on Mine's timeline; it is clamped to `loopableRange`. */
  setLoop(start: number, end: number) {
    const range = this.loopableRange;
    const s = clamp(Math.min(start, end), range.start, range.end);
    const e = clamp(Math.max(start, end), range.start, range.end);
    this.loop = e - s >= 0.05 ? { start: s, end: e } : null;
    this.relaunchForLoopChange();
  }

  clearLoop() {
    this.loop = null;
    this.relaunchForLoopChange();
  }

  setLoopEnabled(enabled: boolean) {
    if (enabled === this.loopEnabled) return;
    this.loopEnabled = enabled;
    this.relaunchForLoopChange();
  }

  get loopRegion(): { start: number; end: number } | null {
    return this.loop;
  }

  private get looping(): boolean {
    return this.loopEnabled && this.loop !== null;
  }

  private relaunchForLoopChange() {
    if (this.state !== 'playing') return;
    // Restart rather than retarget running sources: browsers differ on what a running
    // source does when its loop points move past its playhead. Jump into the loop if the
    // playhead is outside it.
    let t = this.position;
    if (this.looping && (t < this.loop!.start || t >= this.loop!.end)) t = this.loop!.start;
    this.restart(t);
  }

  // ── Transport ────────────────────────────────────────────────────────────

  get transportState(): TransportState {
    return this.state;
  }

  /** In blind mode playback ends with the shortest slot, so no slot goes silent early. */
  setStopAtShortest(value: boolean) {
    if (value === this.stopAtShortest) return;
    this.stopAtShortest = value;
    if (this.state === 'playing') this.restart(this.position);
  }

  /** Where playback ends, on Mine's timeline. */
  get endTime(): number {
    if (this.slots.length === 0) return 0;
    const ends = this.slots.map((s) => s.buffer.duration - s.offsetSeconds);
    return Math.max(0, this.stopAtShortest ? Math.min(...ends) : Math.max(...ends));
  }

  /** Current playhead on Mine's timeline, in seconds. */
  get position(): number {
    if (this.state !== 'playing' || !this.ctx) return this.pausedAt;
    const elapsed = Math.max(0, this.ctx.currentTime - this.anchorCtxTime);
    const t = this.anchorMineTime + elapsed;
    if (this.looping) {
      const { start, end } = this.loop!;
      if (t >= end && this.anchorMineTime < end) {
        return start + ((t - start) % (end - start));
      }
    }
    return Math.min(t, this.endTime);
  }

  /** Must be called from a tap handler the first time, so iOS lets audio start. */
  async play(): Promise<void> {
    await this.unlock();
    if (this.state === 'playing' || this.slots.length === 0) return;
    let t = this.pausedAt >= this.endTime ? 0 : this.pausedAt;
    if (this.looping && (t < this.loop!.start || t >= this.loop!.end)) t = this.loop!.start;
    this.startSources(t);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.pausedAt = this.position;
    this.fadeOutAndStop();
    this.state = 'paused';
  }

  stop() {
    this.fadeOutAndStop();
    this.pausedAt = 0;
    this.state = 'stopped';
  }

  /** Move the playhead. Keeps playing if it was. */
  seek(mineTime: number) {
    const t = clamp(mineTime, 0, this.endTime);
    if (this.state === 'playing') this.restart(t);
    else this.pausedAt = t;
  }

  private restart(mineTime: number) {
    this.fadeOutAndStop();
    this.startSources(mineTime, SEEK_FADE);
  }

  private startSources(mineTime: number, fadeIn = 0) {
    const ctx = this.context;
    const generation = ++this.generation;
    // Start after any fade-out still running from a restart.
    const when = ctx.currentTime + LEAD + fadeIn;
    const endTime = this.endTime;
    const loop = this.looping ? this.loop! : null;

    const transport = this.transport.gain;
    transport.cancelScheduledValues(when);
    transport.setValueAtTime(fadeIn > 0 ? 0 : 1, when);
    if (fadeIn > 0) transport.linearRampToValueAtTime(1, when + fadeIn);

    let remaining = 0;
    for (const slot of this.slots) {
      const pos = mineTime + slot.offsetSeconds;
      const duration = slot.buffer.duration;
      if (pos >= duration) continue;

      const source = new AudioBufferSourceNode(ctx, { buffer: slot.buffer });
      if (loop) {
        source.loop = true;
        source.loopStart = loop.start + slot.offsetSeconds;
        source.loopEnd = loop.end + slot.offsetSeconds;
      }
      source.connect(this.slotGains.get(slot.id)!);
      // A negative position means this slot has not started yet at this Mine time.
      const startAt = pos >= 0 ? when : when - pos;
      source.start(startAt, Math.max(0, pos));
      if (!loop) source.stop(when + Math.max(0, endTime - mineTime));

      remaining++;
      source.onended = () => {
        if (generation !== this.generation) return;
        if (--remaining === 0) {
          this.state = 'stopped';
          this.pausedAt = 0;
          this.playing = [];
          this.onEnded?.();
        }
      };
      this.playing.push({ source, gain: this.slotGains.get(slot.id)! });
    }

    this.anchorMineTime = mineTime;
    this.anchorCtxTime = when;
    this.state = 'playing';
  }

  private fadeOutAndStop() {
    if (!this.ctx) return;
    this.generation++; // ignore onended from the sources being stopped
    const now = this.ctx.currentTime;
    const transport = this.transport.gain;
    holdAt(transport, now);
    transport.linearRampToValueAtTime(0, now + SEEK_FADE);
    for (const { source } of this.playing) {
      try {
        source.stop(now + SEEK_FADE);
      } catch {
        // already stopped
      }
    }
    this.playing = [];
  }

  // ── Debug ────────────────────────────────────────────────────────────────

  /** Facts for the in-app debug panel. */
  get debugInfo() {
    const ctx = this.ctx;
    const decodedBytes = this.slots.reduce(
      (n, s) => n + s.buffer.length * s.buffer.numberOfChannels * 4,
      0,
    );
    return {
      contextState: ctx?.state ?? 'not created',
      sampleRate: ctx?.sampleRate ?? 0,
      baseLatency: ctx?.baseLatency ?? 0,
      outputLatency: ctx?.outputLatency ?? 0,
      audioSession: (navigator as Navigator & AudioSessionNavigator).audioSession?.type ?? 'n/a',
      slots: this.slots.length,
      decodedMegabytes: decodedBytes / (1024 * 1024),
    };
  }

  async close() {
    this.fadeOutAndStop();
    await this.ctx?.close();
    this.ctx = null;
  }
}

/** Linear ramp from wherever the param is now to `target`, starting immediately. */
function ramp(param: AudioParam, target: number, ctx: BaseAudioContext, seconds: number) {
  const now = ctx.currentTime;
  holdAt(param, now);
  if (seconds <= 0) param.setValueAtTime(target, now);
  else param.linearRampToValueAtTime(target, now + seconds);
}

/** Freeze a param at its current value, cancelling anything scheduled after `time`. */
function holdAt(param: AudioParam, time: number) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time);
  } else {
    // Firefox: cancel then pin the last computed value.
    const value = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
