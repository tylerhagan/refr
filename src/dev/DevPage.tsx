// Throwaway engine test bench for Milestone 1. Plain on purpose: it exists to exercise
// AudioEngine, the AIFF reader, loudness analysis and matching on a real phone.
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analyse } from '../audio/analyse';
import { decodeFile } from '../audio/decode';
import { AudioEngine, type Band } from '../audio/engine';
import { computeMatch } from '../audio/match';
import { computeOverview } from '../audio/overview';

const MAX_SLOTS = 4;
const BANDS: { id: Band; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'low', label: 'Low' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' },
];
const OFFSET_STEPS = [-100, -10, 10, 100];
const BUDGET_MS = 20_000;

interface SlotInfo {
  id: string;
  name: string;
  status: 'decoding' | 'analysing' | 'ready' | 'error';
  progress: number;
  error?: string;
  duration: number;
  sampleRate: number;
  channels: number;
  lufs: number;
  peak: number;
  decodeMs: number;
  analysisMs: number;
  overview?: Float32Array;
  offsetMs: number;
}

const fmtTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const fmtDb = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-inf');
const fmtSigned = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
const fmtSeconds = (ms: number) => (ms / 1000).toFixed(1);

function Button({
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        'min-h-[44px] min-w-[44px] rounded-md border px-3 text-sm select-none disabled:opacity-40',
        active ? 'border-accent bg-accent text-on-accent' : 'border-border bg-raised text-text',
        className,
      )}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-surface border-border space-y-3 rounded-lg border p-3">
      <h2 className="text-muted text-xs tracking-wide uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="readout">{value}</dd>
    </div>
  );
}

export default function DevPage() {
  const [engine] = useState(() => new AudioEngine());
  const buffers = useRef(new Map<string, AudioBuffer>());
  const nextId = useRef(1);
  const slotCount = useRef(0);
  const loadQueue = useRef<Promise<void>>(Promise.resolve());
  const lastSetKey = useRef('');
  const lastGains = useRef(new Map<string, number>());

  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [targetText, setTargetText] = useState('-14');
  const [flipped, setFlipped] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [, setTick] = useState(0);
  const [band, setBand] = useState<Band>('full');
  const [mono, setMono] = useState(false);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [shortest, setShortest] = useState(false);
  const [batchWallMs, setBatchWallMs] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const target = Number.isFinite(parseFloat(targetText)) ? parseFloat(targetText) : -14;
  const ready = useMemo(() => slots.filter((s) => s.status === 'ready'), [slots]);
  const match = useMemo(
    () =>
      ready.length
        ? computeMatch(
            ready.map((s) => ({ integratedLufs: s.lufs, truePeakDbtp: s.peak })),
            target,
          )
        : null,
    [ready, target],
  );
  const gainFor = (id: string) => {
    const i = ready.findIndex((s) => s.id === id);
    return match && i >= 0 ? match.gainsDb[i] : 0;
  };
  const activeId =
    flipped && ready.some((s) => s.id === flipped) ? flipped : (ready[0]?.id ?? null);
  const activeSlot = ready.find((s) => s.id === activeId);

  // Latest values for effects and the animation loop, which must not re-subscribe on change.
  const latest = useRef({ ready, match, activeSlot });
  useEffect(() => {
    latest.current = { ready, match, activeSlot };
  });

  // ── Engine sync ──────────────────────────────────────────────────────────
  // setSlots restarts sources, so it only runs when the set of ready slots changes.
  const readyKey = ready.map((s) => s.id).join(',');
  useEffect(() => {
    if (readyKey === lastSetKey.current) return;
    lastSetKey.current = readyKey;
    const { ready: now, match: m } = latest.current;
    lastGains.current.clear();
    engine.setSlots(
      now.map((s, i) => {
        const gainDb = m?.gainsDb[i] ?? 0;
        lastGains.current.set(s.id, gainDb);
        return {
          id: s.id,
          buffer: buffers.current.get(s.id)!,
          offsetSeconds: s.offsetMs / 1000,
          gainDb,
        };
      }),
    );
  }, [engine, readyKey]);

  // Gain-only changes (a new target) go through updateSlot.
  const gainsKey = match ? match.gainsDb.join(',') : '';
  useEffect(() => {
    const { ready: now, match: m } = latest.current;
    if (!m) return;
    now.forEach((s, i) => {
      const gainDb = m.gainsDb[i];
      if (lastGains.current.get(s.id) === gainDb) return;
      lastGains.current.set(s.id, gainDb);
      engine.updateSlot(s.id, { gainDb });
    });
  }, [engine, gainsKey]);

  useEffect(() => {
    // The engine is a long-lived external object, not React state.
    // eslint-disable-next-line react-hooks/immutability
    engine.onEnded = () => setPlaying(false);
    return () => {
      engine.onEnded = null;
      engine.pause();
    };
  }, [engine]);

  // ── Loading ──────────────────────────────────────────────────────────────
  const patch = useCallback((id: string, p: Partial<SlotInfo>) => {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }, []);

  const loadOne = useCallback(
    async (id: string, file: File) => {
      try {
        const t0 = performance.now();
        const buffer = await decodeFile(engine.context, file);
        const decodeMs = performance.now() - t0;
        patch(id, {
          status: 'analysing',
          decodeMs,
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
        });
        const result = await analyse(buffer, (progress) => patch(id, { progress }));
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
          buffer.getChannelData(c),
        );
        const overview = computeOverview(channels);
        buffers.current.set(id, buffer);
        patch(id, {
          status: 'ready',
          progress: 1,
          lufs: result.integratedLufs,
          peak: result.truePeakDbtp,
          analysisMs: result.ms,
          overview,
        });
      } catch (err) {
        patch(id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    },
    [engine, patch],
  );

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    const accepted = Array.from(files).slice(0, MAX_SLOTS - slotCount.current);
    if (accepted.length === 0) return;
    const fresh: SlotInfo[] = accepted.map((file) => ({
      id: `s${nextId.current++}`,
      name: file.name,
      status: 'decoding',
      progress: 0,
      duration: 0,
      sampleRate: 0,
      channels: 0,
      lufs: 0,
      peak: 0,
      decodeMs: 0,
      analysisMs: 0,
      offsetMs: 0,
    }));
    slotCount.current += fresh.length;
    setSlots((prev) => [...prev, ...fresh]);
    // One file at a time: decoding several long files at once multiplies peak memory.
    loadQueue.current = loadQueue.current.then(async () => {
      const t0 = performance.now();
      for (let i = 0; i < fresh.length; i++) await loadOne(fresh[i].id, accepted[i]);
      setBatchWallMs(performance.now() - t0);
    });
  };

  const clearAll = () => {
    engine.stop();
    engine.setSlots([]);
    engine.clearLoop();
    buffers.current.clear();
    lastGains.current.clear();
    lastSetKey.current = '';
    slotCount.current = 0;
    setSlots([]);
    setFlipped(null);
    setPlaying(false);
    setPos(0);
    setLoopA(null);
    setLoopB(null);
  };

  // ── Transport and flip ───────────────────────────────────────────────────
  // play() is called straight from the event handler: iOS only lets audio start inside a gesture.
  const togglePlay = useCallback(() => {
    if (engine.transportState === 'playing') {
      engine.pause();
      setPlaying(false);
    } else {
      void engine.play().then(() => setPlaying(engine.transportState === 'playing'));
    }
  }, [engine]);

  const flipTo = useCallback(
    (id: string) => {
      engine.flip(id);
      setFlipped(id);
    },
    [engine],
  );

  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.closest('input, textarea, select') !== null || t.isContentEditable);
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const ids = latest.current.ready.map((s) => s.id);
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) togglePlay();
      } else if (e.key >= '1' && e.key <= '4') {
        const id = ids[Number(e.key) - 1];
        if (id) flipTo(id);
      } else if ((e.key === 'f' || e.key === 'F') && ids.length > 0 && !e.repeat) {
        const i = ids.indexOf(engine.activeSlotId ?? '');
        flipTo(ids[(i + 1) % ids.length]);
      }
    };
    // A focused button would also "click" on Space keyup.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [engine, togglePlay, flipTo]);

  // ── Position + overview canvas ───────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const p = engine.position;
      setPos((prev) => (prev === p ? prev : p));
      drawOverview(canvasRef.current, latest.current.activeSlot, p, engine.loopRegion);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // Debug panel values (context state, latencies) change without any React state.
    const interval = setInterval(() => setTick((t) => t + 1), 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
    };
  }, [engine]);

  // ── Loop, offsets ────────────────────────────────────────────────────────
  const setA = () => {
    const a = engine.position;
    setLoopA(a);
    if (loopB !== null) engine.setLoop(a, loopB);
  };
  const setB = () => {
    const b = engine.position;
    setLoopB(b);
    if (loopA !== null) engine.setLoop(loopA, b);
  };
  const clearLoop = () => {
    engine.clearLoop();
    setLoopA(null);
    setLoopB(null);
  };
  const nudge = (id: string, deltaMs: number) => {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    const offsetMs = slot.offsetMs + deltaMs;
    patch(id, { offsetMs });
    engine.updateSlot(id, { offsetSeconds: offsetMs / 1000 });
  };

  const loop = engine.loopRegion;
  const range = engine.loopableRange;
  const debug = engine.debugInfo;
  const totalMs = ready.reduce((n, s) => n + s.decodeMs + s.analysisMs, 0);
  const roleOf = (id: string) => {
    const i = slots.filter((s) => s.status !== 'error').findIndex((s) => s.id === id);
    return i <= 0 ? 'Mine' : `Ref ${i}`;
  };
  const end = engine.endTime;

  return (
    <main className="mx-auto max-w-2xl space-y-3 p-3 pb-12">
      <h1 className="text-lg font-semibold">Refr engine bench</h1>

      <Section title="Load">
        <input
          type="file"
          multiple
          accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a"
          disabled={slots.length >= MAX_SLOTS}
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
          className="text-sm"
          aria-label="Load audio files"
        />
        <p className="text-muted text-xs">
          {slots.length}/{MAX_SLOTS} slots. First file is Mine, the rest are references.
        </p>
        {slots.map((s) => (
          <div key={s.id} className="border-border space-y-1 rounded-md border p-2 text-sm">
            <div className="flex justify-between gap-2">
              <span className="truncate font-semibold">
                {roleOf(s.id)}: {s.name}
              </span>
              <span className="readout text-muted shrink-0">
                {s.status === 'ready' && 'ready'}
                {s.status === 'decoding' && 'decoding...'}
                {s.status === 'analysing' && `analysing ${Math.round(s.progress * 100)}%`}
                {s.status === 'error' && 'error'}
              </span>
            </div>
            {s.status === 'error' && <p className="text-warning">{s.error}</p>}
            {(s.status === 'analysing' || s.status === 'ready') && (
              <dl className="grid grid-cols-2 gap-x-4 text-xs">
                <Stat label="Duration" value={fmtTime(s.duration)} />
                <Stat label="Sample rate" value={`${s.sampleRate} Hz`} />
                <Stat label="Channels" value={String(s.channels)} />
                <Stat label="Decode" value={`${Math.round(s.decodeMs)} ms`} />
                {s.status === 'ready' && (
                  <>
                    <Stat label="Integrated" value={`${fmtDb(s.lufs)} LUFS`} />
                    <Stat label="True peak" value={`${fmtDb(s.peak)} dBTP`} />
                    <Stat label="Gain" value={`${fmtSigned(gainFor(s.id))} dB`} />
                    <Stat label="Analysis" value={`${Math.round(s.analysisMs)} ms`} />
                  </>
                )}
              </dl>
            )}
          </div>
        ))}
        {slots.length > 0 && <Button onClick={clearAll}>Clear all</Button>}
      </Section>

      <Section title="Match">
        <label className="flex items-center gap-3 text-sm">
          <span className="text-muted">Target LUFS</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            value={targetText}
            onChange={(e) => setTargetText(e.target.value)}
            className="readout bg-raised border-border min-h-[44px] w-24 rounded-md border px-2"
          />
        </label>
        {match && (
          <p className="readout text-sm">
            Effective target {fmtDb(match.effectiveTargetLufs)} LUFS
            {match.limitedBy !== null && (
              <span className="text-warning"> (lowered by {ready[match.limitedBy].name})</span>
            )}
          </p>
        )}
      </Section>

      <Section title="Transport">
        <div className="flex items-center gap-3">
          <Button onClick={togglePlay} disabled={ready.length === 0} className="w-28">
            {playing ? 'Pause' : 'Play'}
          </Button>
          <span className="readout text-lg">{fmtTime(pos)}</span>
          <span className="readout text-muted text-xs">/ {fmtTime(end)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={end}
          step="any"
          value={Math.min(pos, end)}
          disabled={ready.length === 0}
          onChange={(e) => {
            const t = Number(e.target.value);
            engine.seek(t);
            setPos(t);
          }}
          className="accent-accent h-11 w-full"
          aria-label="Seek"
        />
        <label className="flex min-h-[44px] items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shortest}
            onChange={(e) => {
              setShortest(e.target.checked);
              engine.setStopAtShortest(e.target.checked);
            }}
            className="accent-accent h-5 w-5"
          />
          Blind test: stop at shortest slot
        </label>
      </Section>

      <Section title="Flip (keys 1-4, F next, Space play/pause)">
        <div className="grid grid-cols-2 gap-2">
          {ready.map((s, i) => (
            <Button
              key={s.id}
              active={s.id === activeId}
              onClick={() => flipTo(s.id)}
              className="min-h-[72px] truncate text-base"
            >
              {i + 1} {roleOf(s.id)}
            </Button>
          ))}
        </div>
        {ready.length === 0 && <p className="text-muted text-sm">Load a file first.</p>}
      </Section>

      <Section title="Bands and mono">
        <div className="flex flex-wrap gap-2">
          {BANDS.map((b) => (
            <Button
              key={b.id}
              active={band === b.id}
              onClick={() => {
                setBand(b.id);
                engine.setBand(b.id);
              }}
              className="rounded-full"
            >
              {b.label}
            </Button>
          ))}
          <Button
            active={mono}
            onClick={() => {
              setMono(!mono);
              engine.setMono(!mono);
            }}
          >
            Mono
          </Button>
        </div>
      </Section>

      <Section title="Overview">
        <canvas ref={canvasRef} className="bg-raised h-24 w-full rounded-md" />
        <p className="text-muted text-xs">
          {activeSlot ? `${roleOf(activeSlot.id)} peaks, playhead on this file's timeline` : '-'}
        </p>
      </Section>

      <Section title="Loop">
        <div className="flex flex-wrap gap-2">
          <Button onClick={setA} disabled={ready.length === 0}>
            Set A
          </Button>
          <Button onClick={setB} disabled={ready.length === 0}>
            Set B
          </Button>
          <Button
            active={loopOn}
            onClick={() => {
              setLoopOn(!loopOn);
              engine.setLoopEnabled(!loopOn);
            }}
          >
            Loop {loopOn ? 'on' : 'off'}
          </Button>
          <Button onClick={clearLoop}>Clear</Button>
        </div>
        <dl className="text-sm">
          <Stat
            label="A / B"
            value={`${loopA === null ? '-' : fmtTime(loopA)} / ${loopB === null ? '-' : fmtTime(loopB)}`}
          />
          <Stat
            label="Region"
            value={loop ? `${fmtTime(loop.start)} - ${fmtTime(loop.end)}` : 'none'}
          />
          <Stat label="Loopable" value={`${fmtTime(range.start)} - ${fmtTime(range.end)}`} />
        </dl>
      </Section>

      <Section title="Offsets">
        {ready.length < 2 && <p className="text-muted text-sm">Needs a reference slot.</p>}
        {ready.slice(1).map((s) => (
          <div key={s.id} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="truncate">{roleOf(s.id)}</span>
              <span className="readout">
                {s.offsetMs > 0 ? '+' : ''}
                {s.offsetMs} ms
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {OFFSET_STEPS.map((d) => (
                <Button key={d} onClick={() => nudge(s.id, d)} className="readout px-1">
                  {d > 0 ? `+${d}` : d}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Debug / M1 check">
        <div className="space-y-1">
          <p className="readout text-readout">{fmtSeconds(totalMs)} s</p>
          <p className="text-sm">
            decode + analysis, {ready.length} file{ready.length === 1 ? '' : 's'} (wall{' '}
            <span className="readout">{fmtSeconds(batchWallMs)} s</span>)
          </p>
          {ready.length >= 3 && (
            <p
              className={clsx(
                'readout text-lg',
                totalMs < BUDGET_MS ? 'text-accent' : 'text-warning',
              )}
            >
              {totalMs < BUDGET_MS ? 'PASS' : 'FAIL'}: budget is {BUDGET_MS / 1000} s for three
              4-min files
            </p>
          )}
          <p className="readout text-lg">
            {slots.filter((s) => s.status === 'ready').length}/{MAX_SLOTS} loaded,{' '}
            {debug.decodedMegabytes.toFixed(0)} MB decoded
          </p>
        </div>
        <dl className="text-xs">
          <Stat label="Context" value={debug.contextState} />
          <Stat label="Sample rate" value={`${debug.sampleRate} Hz`} />
          <Stat label="Base latency" value={`${(debug.baseLatency * 1000).toFixed(1)} ms`} />
          <Stat label="Output latency" value={`${(debug.outputLatency * 1000).toFixed(1)} ms`} />
          <Stat label="audioSession" value={debug.audioSession} />
          <Stat label="Engine slots" value={String(debug.slots)} />
        </dl>
        <p className="text-muted font-mono text-xs break-words">{navigator.userAgent}</p>
      </Section>
    </main>
  );
}

function drawOverview(
  canvas: HTMLCanvasElement | null,
  slot: SlotInfo | undefined,
  mineTime: number,
  loop: { start: number; end: number } | null,
) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === 0 || h === 0) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  if (!slot?.overview || slot.duration <= 0) return;

  const css = getComputedStyle(document.documentElement);
  const colour = (name: string) => css.getPropertyValue(name).trim();
  const x = (fileTime: number) => (fileTime / slot.duration) * w;
  const offset = slot.offsetMs / 1000;

  if (loop) {
    g.fillStyle = colour('--rf-warning');
    g.globalAlpha = 0.25;
    const x0 = x(loop.start + offset);
    g.fillRect(x0, 0, x(loop.end + offset) - x0, h);
    g.globalAlpha = 1;
  }

  g.fillStyle = colour('--rf-accent');
  const peaks = slot.overview;
  const mid = h / 2;
  for (let px = 0; px < w; px++) {
    const peak = peaks[Math.min(peaks.length - 1, Math.floor((px / w) * peaks.length))];
    const half = Math.max(1, peak * mid);
    g.fillRect(px, mid - half, 1, half * 2);
  }

  g.fillStyle = colour('--rf-text');
  g.fillRect(Math.round(x(mineTime + offset)), 0, Math.max(1, Math.round(dpr)), h);
}
