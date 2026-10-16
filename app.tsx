import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import {
  ageLabel,
  defaultConfig,
  koiLength,
  MAX_KOI,
  NAME_MAX,
  newSeed,
  POND_CHANNEL,
  resolveSeason,
  resolveTime,
  resolveWeather,
  SEASONS,
  TIMES,
  VARIETIES,
  VARIETY_INFO,
  type IdleView,
  type KoiEntry,
  type LilyAmount,
  type PoiGrade,
  type PondConfig,
  type VarietyId,
  type View,
  type WeatherChoice,
} from "./config.ts";
import { addRipple, attend, breathAt, dropFood, portraitKoi, type BreathPhase } from "./koi.ts";
import { drawKoiPortrait, PIXEL_SCALE, SHORE_ROWS, STRIP_ROWS, type Scrim } from "./scene.ts";
import { isAuto, tap, tapAt, type Sukui, type SukuiEvent } from "./sukui.ts";
import { advanceWorld, createWorld, environmentFor, type World } from "./world.ts";
import { composerBorderColor, insertComposerSlot, squareComposerTop } from "./composer-dom.ts";
import { attachComposerWater, type ComposerWater } from "./composer-water.ts";
import { ambience } from "./sound.ts";

type PondState = PluginRpcResult<(typeof rpcContract)["getPond"]>;

// Declared in package.json under bb.branding.experimental_icons.
const KOI_ICON = "zen-koi/koi";
const SOUND_ICON = "zen-koi/sound";
const PAGE_PATH = "pond";
const SETTINGS_ACTION = "pond-settings";

const FRAME_MS = 33;
/** Under reduced motion nothing moves; the pond only redraws for changes. */
const STILL_FRAME_MS = 500;
/** Hidden or off-screen ponds rest instead of swimming unseen. */
const IDLE_CHECK_MS = 500;
const MAX_STEP_MS = 100;
/** The pond page's height, in pond pixels. */
const PAGE_ROWS = 104;
/** How long a catch, a miss, or a tear stays in the status line. */
const NEWS_MS = 2_600;
/**
 * `isRunning` dips to false for a moment at turn boundaries (a message sent
 * mid-turn, a queued message starting). Only a stop that lasts counts.
 */
const STOP_GRACE_MS = 3_000;

const BREATH_LABEL: Record<BreathPhase, string> = {
  in: "Breathe in",
  hold: "Hold",
  out: "Breathe out",
};


const KOI_NAMES = [
  "Hana", "Sora", "Kin", "Kage", "Yuki", "Momo", "Aki", "Ume", "Tora", "Mizu",
  "Kumo", "Hoshi", "Ren", "Nami", "Kaze", "Tsuki", "Hotaru", "Koharu", "Mochi", "Sumi",
];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- shared state

// One pond for the whole window, so a change on the pond page reaches every
// strip in the same frame.
let sharedState: PondState | null = null;
const stateListeners = new Set<() => void>();
const FALLBACK_CONFIG = defaultConfig(Date.now());

function setSharedState(next: PondState) {
  sharedState = next;
  for (const listener of stateListeners) listener();
}

function subscribeState(listener: () => void) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Bumped by every load and save; only the latest answer may land. */
let stateRequest = 0;

// Signals are not replayed, so catch up after the socket reconnects.
function useResyncOnReconnect(refresh: () => void) {
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) refresh();
    connectedBefore.current = true;
  }, [connection, refresh]);
}

function usePondState() {
  const rpc = useRpc<typeof rpcContract>();
  const state = useSyncExternalStore(subscribeState, () => sharedState);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const request = ++stateRequest;
    try {
      const next = await rpc.call("getPond");
      if (request === stateRequest) setSharedState(next);
      setError(null);
    } catch (cause) {
      if (request === stateRequest) setError(errorMessage(cause));
    }
  }, [rpc]);
  const refresh = useCallback(() => void load(), [load]);
  useEffect(refresh, [refresh]);
  useRealtime(POND_CHANNEL, refresh);
  useResyncOnReconnect(refresh);

  const save = useCallback(
    async (config: PondConfig) => {
      const request = ++stateRequest;
      setSharedState({ config, scoops: sharedState?.scoops ?? {} });
      try {
        const saved = await rpc.call("setPond", config);
        if (request === stateRequest) setSharedState(saved);
        setError(null);
      } catch (cause) {
        // Put the saved pond back, then say why the change did not stick.
        await load();
        setError(errorMessage(cause));
      }
    },
    [load, rpc],
  );
  const recordScoop = useCallback(
    (koiId: string) => {
      rpc.call("recordScoop", { koiId }).catch((cause) => {
        console.warn(`[zen-koi] Could not save a scoop: ${errorMessage(cause)}`);
      });
    },
    [rpc],
  );
  return {
    config: state?.config ?? FALLBACK_CONFIG,
    scoops: state?.scoops ?? {},
    error,
    save,
    recordScoop,
  };
}

// Sound is a per-device choice, kept in this browser and shared by every pond.
type SoundPrefs = { enabled: boolean; volume: number };
const SOUND_KEY = "zen-koi.sound";
let soundPrefs: SoundPrefs = readSoundPrefs();
const soundListeners = new Set<() => void>();

function readSoundPrefs(): SoundPrefs {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(SOUND_KEY) ?? "null",
    ) as Partial<SoundPrefs> | null;
    return {
      enabled: stored?.enabled === true,
      volume: typeof stored?.volume === "number" ? Math.max(0, Math.min(1, stored.volume)) : 0.5,
    };
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies).
    return { enabled: false, volume: 0.5 };
  }
}

/** Call from a click or key press, so the browser lets the audio start. */
function setSoundPrefs(next: SoundPrefs) {
  soundPrefs = next;
  ambience.configure(next.enabled, next.volume);
  try {
    window.localStorage.setItem(SOUND_KEY, JSON.stringify(next));
  } catch {
    // Best effort only.
  }
  for (const listener of soundListeners) listener();
}

function useSoundPrefs(): SoundPrefs {
  return useSyncExternalStore(
    (listener) => {
      soundListeners.add(listener);
      return () => soundListeners.delete(listener);
    },
    () => soundPrefs,
  );
}

ambience.configure(soundPrefs.enabled, soundPrefs.volume);

// One catch log per thread: the koi scooped during the agent's current (or
// last) turn. Module-level so it survives the banner remounting on navigation.
type Session = { scooped: string[]; ended: boolean; dismissed: boolean };
const sessions = new Map<string, Session>();
const sessionListeners = new Set<() => void>();
const viewOverrides = new Map<string, View>();
const viewListeners = new Set<() => void>();

function setViewOverride(threadId: string, view: View | null) {
  if (view === null) viewOverrides.delete(threadId);
  else viewOverrides.set(threadId, view);
  for (const listener of viewListeners) listener();
}

function useViewOverride(threadId: string): View | null {
  return useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    () => viewOverrides.get(threadId) ?? null,
  );
}

function setSession(threadId: string, session: Session) {
  sessions.set(threadId, session);
  for (const listener of sessionListeners) listener();
}

function useSession(threadId: string): Session | undefined {
  return useSyncExternalStore(
    (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    () => sessions.get(threadId),
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Best effort only.
      }
    },
    [key],
  );
  return [value, update];
}

function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

// ---------------------------------------------------------------- the running pond

type Hud = {
  breath: BreathPhase | null;
  /** What the poi is doing, in catch view. */
  status: string | null;
  /** Paper left, in tenths, or null outside catch view. */
  paper: number | null;
  bite: boolean;
  auto: boolean;
  inBowl: number;
};

const EMPTY_HUD: Hud = { breath: null, status: null, paper: null, bite: false, auto: false, inBowl: 0 };

function sameHud(a: Hud, b: Hud): boolean {
  return (
    a.breath === b.breath &&
    a.status === b.status &&
    a.paper === b.paper &&
    a.bite === b.bite &&
    a.auto === b.auto &&
    a.inBowl === b.inBowl
  );
}

type News = { text: string; until: number };

function koiName(config: PondConfig, id: string): string {
  return config.koi.find((entry) => entry.id === id)?.name ?? "a koi";
}

/** Plays each event's sound and returns the news worth a moment in the status line. */
function playEvents(
  events: readonly SukuiEvent[],
  config: PondConfig,
  onScoop: (koiId: string) => void,
): News | null {
  let news: News | null = null;
  const until = performance.now() + NEWS_MS;
  for (const event of events) {
    switch (event.type) {
      case "dip":
        ambience.dip();
        break;
      case "bite":
        ambience.plop();
        break;
      case "scooped":
        ambience.splash();
        onScoop(event.koiId);
        news = { text: `Scooped ${koiName(config, event.koiId)}!`, until };
        break;
      case "missed":
        news = { text: `${koiName(config, event.koiId)} swam off`, until };
        break;
      case "torn":
        ambience.tear();
        news = { text: "The paper tore. A fresh poi is coming", until };
        break;
      case "released":
        ambience.plop();
        break;
    }
  }
  return news;
}

function catchStatus(sukui: Sukui, news: News | null, now: number): string {
  if (news && now < news.until) return news.text;
  const auto = isAuto(sukui);
  switch (sukui.phase.kind) {
    case "bite":
      return auto ? "A koi is over the poi…" : "Now! Tap to scoop";
    case "moving":
      return auto ? "Finding a quiet spot" : "Moving the poi";
    case "waiting":
      return "Waiting for a koi";
    case "cooldown":
      return sukui.torn ? "A fresh poi is coming" : "Into the bowl";
  }
}

type LoopOptions = {
  active: boolean;
  world: World;
  config: PondConfig;
  view: View;
  /** Pond rows in the canvas: the strip, or the whole pond page. */
  rows: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The chat input's water below the strip, if any. */
  waterRef?: RefObject<ComposerWater | null>;
  /** Koi keep to the canvas rows (strip), or roam everywhere (page, compact). */
  focusCanvas: boolean;
  reducedMotion: boolean;
  onScoop: (koiId: string) => void;
  breathDotRef: RefObject<HTMLSpanElement | null>;
  newsRef: RefObject<News | null>;
};

/**
 * One loop per pond: steps the world, paints the canvas and the chat input's
 * water, and keeps the HUD current. It rests while nothing is in view.
 */
function usePondLoop(options: LoopOptions): Hud {
  const [hud, setHud] = useState<Hud>(EMPTY_HUD);
  const latest = useLatest(options);
  const onScreenRef = useRef(true);
  const { active, canvasRef } = options;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas) return;
    const observer = new IntersectionObserver(([entry]) => {
      onScreenRef.current = entry?.isIntersecting ?? true;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  });

  useEffect(() => {
    if (!active) return;
    let release: (() => void) | null = null;
    const syncSound = () => {
      const visible = document.visibilityState === "visible";
      if (visible && !release) release = ambience.hold();
      if (!visible && release) {
        release();
        release = null;
      }
    };
    syncSound();
    document.addEventListener("visibilitychange", syncSound);
    return () => {
      document.removeEventListener("visibilitychange", syncSound);
      release?.();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = performance.now();
    let lastBreath: BreathPhase | null = null;
    let hudNow = EMPTY_HUD;

    const tick = () => {
      if (disposed) return;
      const {
        world,
        config,
        view,
        rows,
        waterRef,
        focusCanvas,
        reducedMotion,
        onScoop,
        breathDotRef,
        newsRef,
      } = latest.current;
      const now = performance.now();
      const dt = Math.min(MAX_STEP_MS, now - last);
      last = now;
      const visible = document.visibilityState === "visible";
      const canvas = canvasRef.current;
      const water = waterRef?.current ?? null;
      const showCanvas = canvas !== null && canvas.isConnected && onScreenRef.current && visible;
      const showWater = water !== null && water.connected && visible;

      const breathing = config.ambience.breathing && view === "pond";
      const breath = breathAt(Date.now());
      breathDotRef.current?.style.setProperty(
        "transform",
        `scale(${(0.45 + breath.fullness * 0.55).toFixed(3)})`,
      );
      const breathTurned = breath.phase !== lastBreath;
      lastBreath = breath.phase;

      if (!showCanvas && !showWater) {
        timer = setTimeout(tick, breathing && visible ? 100 : IDLE_CHECK_MS);
        return;
      }

      const waterSize = showWater ? water.size() : null;
      const box = canvas?.parentElement;
      const width = showCanvas && box
        ? Math.max(40, Math.ceil(box.clientWidth / PIXEL_SCALE))
        : waterSize!.width;
      const below = waterSize?.height ?? 0;
      const height = rows + below;
      const focusBottom = focusCanvas && showCanvas ? rows : height;
      const env = environmentFor(config, new Date());
      const events = advanceWorld(
        world,
        { width, height, focusBottom },
        config,
        env,
        dt,
        reducedMotion,
        view,
      );
      const news = playEvents(events, config, onScoop);
      if (news) newsRef.current = news;
      ambience.setRain(env.weather === "rain");
      if (breathing && breathTurned && breath.phase === "in" && !reducedMotion) {
        // Each in-breath sends one slow ring across the pond.
        addRipple(world.pond, width / 2, (SHORE_ROWS + focusBottom) / 2 + 2, 16, 3);
      }

      let scrim: Scrim | null = null;
      if (showWater) {
        const look = water.look(now);
        scrim = { color: look.background, alpha: look.dark ? 0.4 : 0.55, start: rows - 12, full: rows };
      }
      if (showCanvas) {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== rows) canvas.height = rows;
        // Whole pond pixels, so the strip and the chat input line up exactly.
        canvas.style.width = `${width * PIXEL_SCALE}px`;
        canvas.style.height = `${rows * PIXEL_SCALE}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) world.painter.paint(ctx, world.pond, env, now, { y0: 0, rows, scrim }, world.sukui);
      }
      if (showWater && waterSize) {
        const target = water.canvas;
        if (target.width !== width) target.width = width;
        if (target.height !== below) target.height = below;
        const ctx = target.getContext("2d");
        if (ctx) {
          world.painter.paint(ctx, world.pond, env, now, { y0: rows, rows: below, scrim }, world.sukui);
        }
      }

      const sukui = world.sukui;
      const next: Hud = {
        breath: breathing ? breath.phase : null,
        status: sukui ? catchStatus(sukui, newsRef.current, now) : null,
        paper: sukui ? Math.max(0, Math.ceil(sukui.paper * 10)) : null,
        bite: sukui?.phase.kind === "bite",
        auto: sukui ? isAuto(sukui) : false,
        inBowl: sukui?.bowl.length ?? 0,
      };
      if (!sameHud(next, hudNow)) {
        hudNow = next;
        setHud(next);
      }
      const delay = reducedMotion ? STILL_FRAME_MS : FRAME_MS;
      timer = setTimeout(tick, Math.max(0, delay - (performance.now() - now)));
    };
    tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, canvasRef, latest]);

  return hud;
}

/** Pointer and keyboard play: feed and watch the pond, or tap to catch. */
function usePondControls(
  world: World,
  view: View,
  config: PondConfig,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  onScoop: (koiId: string) => void,
  newsRef: RefObject<News | null>,
) {
  const toPond = (event: PointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
  };
  const play = (events: SukuiEvent[]) => {
    const news = playEvents(events, config, onScoop);
    if (news) newsRef.current = news;
  };
  const feed = (x: number, y: number) => {
    dropFood(world.pond, x, y, Math.random);
    ambience.plop();
  };
  return {
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const point = toPond(event);
      if (point && view === "pond") attend(world.pond, point.x, point.y);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const point = toPond(event);
      if (!point) return;
      if (view === "catch" && world.sukui) {
        play(tapAt(world.sukui, world.pond, point.x, point.y, Math.random));
      } else {
        feed(point.x, point.y);
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (event.repeat) return;
      const pond = world.pond;
      if (view === "catch" && world.sukui) {
        play(tap(world.sukui, pond, Math.random));
      } else {
        const x = pond.width * (0.2 + Math.random() * 0.6);
        const y = SHORE_ROWS + 4 + Math.random() * Math.max(2, pond.focusBottom - SHORE_ROWS - 8);
        feed(x, y);
      }
    },
  };
}

// ---------------------------------------------------------------- small UI

function IconButton({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-md transition-colors hover:bg-white/15 hover:text-white ${
        pressed ? "text-white" : "text-white/70"
      }`}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

/** Small glassy label over the pond art, readable on any water. */
function Glass({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-md bg-black/40 px-2 py-0.5 text-[11px] text-white/90 shadow-sm backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

function BreathGuide({
  phase,
  dotRef,
}: {
  phase: BreathPhase;
  dotRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <Glass className="flex items-center gap-1.5">
      <span className="flex size-2.5 items-center justify-center" aria-hidden>
        <span
          ref={dotRef}
          className="block size-2.5 rounded-full bg-white/80 transition-transform duration-100 ease-linear motion-reduce:transition-none"
        />
      </span>
      <span aria-live="polite">{BREATH_LABEL[phase]}</span>
    </Glass>
  );
}

function CatchHud({ hud, grade }: { hud: Hud; grade: PoiGrade }) {
  if (hud.status === null || hud.paper === null) return null;
  return (
    <Glass className={`flex items-center gap-2 ${hud.bite && !hud.auto ? "bg-amber-500/80 text-black" : ""}`}>
      <span className="opacity-70">No.{grade}</span>
      <span
        className="flex h-1.5 w-10 overflow-hidden rounded-full bg-white/25"
        aria-label={`Paper ${hud.paper * 10}%`}
      >
        <span className="block h-full bg-white/90" style={{ width: `${hud.paper * 10}%` }} />
      </span>
      <span aria-live="polite">{hud.status}</span>
      {hud.inBowl > 0 ? <span className="opacity-70">· {hud.inBowl} in the bowl</span> : null}
      {hud.auto && !hud.bite ? <span className="opacity-60">· tap the water to play</span> : null}
    </Glass>
  );
}

/** What the player scooped while the agent worked, until dismissed or the next turn. */
function CatchSummary({
  session,
  config,
  onDismiss,
}: {
  session: Session;
  config: PondConfig;
  onDismiss: () => void;
}) {
  const counts = new Map<string, number>();
  for (const id of session.scooped) counts.set(id, (counts.get(id) ?? 0) + 1);
  const names = [...counts]
    .map(([id, count]) => (count > 1 ? `${koiName(config, id)} ×${count}` : koiName(config, id)))
    .join(", ");
  const total = session.scooped.length;
  return (
    <Glass className="pointer-events-auto flex items-center gap-2">
      <span>
        While your agent worked: {total === 1 ? "1 koi" : `${total} koi`} scooped
        <span className="opacity-70"> · {names}</span>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="rounded px-1 text-white/70 hover:bg-white/15 hover:text-white"
      >
        ×
      </button>
    </Glass>
  );
}

// ---------------------------------------------------------------- strip

/**
 * A slot right above the chat input. Banners render at the top of bb's card
 * stack, so the pond portals here to sit next to the chat input instead. Null
 * when bb's markup is not recognized; the pond then stays in the banner.
 */
function useComposerSlot(
  markerRef: RefObject<HTMLElement | null>,
  pluginId: string,
): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const created = marker ? insertComposerSlot(marker, pluginId) : null;
    if (!created) return;
    setSlot(created);
    return () => created.remove();
  }, [markerRef, pluginId]);
  return slot;
}

function PondBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  return (
    <ThreadPond
      threadId={composer.scope.threadId}
      isRunning={composer.isRunning}
      compact={composer.layout === "compact"}
    />
  );
}

function ThreadPond({
  threadId,
  isRunning,
  compact,
}: {
  threadId: string;
  isRunning: boolean;
  compact: boolean;
}) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const reducedMotion = useReducedMotion();
  const { config, recordScoop } = usePondState();
  const sound = useSoundPrefs();
  const session = useSession(threadId);
  const [hidden, setHidden] = useStoredFlag(`${pluginId}.hidden`);
  const [running, setRunning] = useState(isRunning);
  const override = useViewOverride(threadId);
  const world = useMemo(createWorld, []);
  const newsRef = useRef<News | null>(null);

  useEffect(() => {
    if (isRunning) {
      setRunning(true);
      return;
    }
    const timer = setTimeout(() => setRunning(false), STOP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isRunning]);

  // A new turn starts a fresh catch log; the end of one keeps it for the summary.
  // Each change of state also goes back to that state's own view.
  useEffect(() => {
    setViewOverride(threadId, null);
    const current = sessions.get(threadId);
    if (running) {
      if (!current || current.ended) setSession(threadId, { scooped: [], ended: false, dismissed: false });
    } else if (current && !current.ended) {
      setSession(threadId, { ...current, ended: true });
    }
  }, [running, threadId]);

  const defaultView: View | null = running
    ? config.views.working
    : config.views.idle === "pond"
      ? "pond"
      : null;
  const view = override ?? defaultView;
  const open = view !== null;
  const showPond = open && !hidden && !compact;
  const flooded = open && !hidden;

  // Stays in the banner slot, so it can find the composer even while the pond
  // renders elsewhere.
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const slot = useComposerSlot(markerRef, pluginId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const breathDotRef = useRef<HTMLSpanElement | null>(null);
  const waterRef = useRef<ComposerWater | null>(null);
  const [borderColor, setBorderColor] = useState<string | null>(null);

  // While the pond is open, it runs on into the chat input below.
  useEffect(() => {
    const marker = markerRef.current;
    if (!flooded || !marker) return;
    const water = attachComposerWater(marker);
    waterRef.current = water;
    setBorderColor(composerBorderColor(marker));
    return () => {
      water?.remove();
      if (waterRef.current === water) waterRef.current = null;
    };
  }, [flooded, slot]);

  const onScoop = useCallback(
    (koiId: string) => {
      recordScoop(koiId);
      const current = sessions.get(threadId);
      if (current && !current.ended) {
        setSession(threadId, { ...current, scooped: [...current.scooped, koiId] });
      }
    },
    [recordScoop, threadId],
  );
  const hud = usePondLoop({
    active: flooded,
    world,
    config,
    view: view ?? "pond",
    rows: STRIP_ROWS,
    canvasRef,
    waterRef,
    focusCanvas: true,
    reducedMotion,
    onScoop,
    breathDotRef,
    newsRef,
  });
  const controls = usePondControls(world, view ?? "pond", config, canvasRef, onScoop, newsRef);
  const openSettings = () => navigate.openThreadPanel({ actionId: SETTINGS_ACTION, title: "Zen Pond" });
  // In the slot, the pond and the chat input below it read as one box.
  const frame = slot ? "rounded-t-xl border-b-0" : "rounded-xl";
  const summary =
    !running && session?.ended && !session.dismissed && session.scooped.length > 0
      ? session
      : null;
  const dismissSummary = () => {
    if (session) setSession(threadId, { ...session, dismissed: true });
  };

  let content: ReactNode = null;
  if (open && !showPond) {
    content = (
      <section
        aria-label="Zen Koi"
        className={`flex h-8 items-center gap-2 border border-border bg-card pr-1 pl-3 text-xs ${frame}`}
        style={borderColor ? { borderColor } : undefined}
      >
        <Icon name={KOI_ICON} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {hud.status ?? (hud.breath ? BREATH_LABEL[hud.breath] : "Your koi are in the pond")}
        </span>
        <button
          type="button"
          onClick={openSettings}
          className="rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Zen Pond
        </button>
        {compact ? null : (
          <button
            type="button"
            aria-label="Show the pond"
            title="Show the pond"
            onClick={() => setHidden(false)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon name="ChevronUp" className="size-3.5" aria-hidden />
          </button>
        )}
      </section>
    );
  } else if (showPond) {
    content = (
      <section
        aria-label="Zen Koi"
        className={`group relative overflow-hidden border border-border bg-card ${frame}`}
        style={borderColor ? { borderColor } : undefined}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={
            view === "catch"
              ? "Koi pond. Tap the water to move the poi; tap when a koi is over it to scoop."
              : "Koi pond. Click to scatter a little food."
          }
          className="block w-full cursor-pointer touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ height: STRIP_ROWS * PIXEL_SCALE }}
          // Keep the caret in the composer: clicking the pond must not steal focus.
          onMouseDown={(event) => event.preventDefault()}
          {...controls}
        >
          <canvas ref={canvasRef} className="block" style={{ imageRendering: "pixelated" }} aria-hidden />
        </div>
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          <div className="rounded-lg bg-black/40 shadow-sm backdrop-blur-sm">
            <IconButton label="Open pond settings" icon="Settings2" onClick={openSettings} />
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-black/40 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-300 group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton
              label={sound.enabled ? "Mute the pond" : "Play the pond's sounds"}
              icon={SOUND_ICON}
              pressed={sound.enabled}
              onClick={() => setSoundPrefs({ ...sound, enabled: !sound.enabled })}
            />
            <IconButton label="Hide the pond" icon="ChevronDown" onClick={() => setHidden(true)} />
          </div>
        </div>
        <div className="pointer-events-none absolute right-1.5 bottom-1.5 left-1.5 flex items-end justify-between gap-2">
          {hud.breath ? <BreathGuide phase={hud.breath} dotRef={breathDotRef} /> : null}
          <div className="ml-auto min-w-0">
            {view === "catch" ? (
              <CatchHud hud={hud} grade={config.poi} />
            ) : summary ? (
              <CatchSummary session={summary} config={config} onDismiss={dismissSummary} />
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const hasContent = content !== null;
  useLayoutEffect(() => {
    if (!slot) return;
    slot.hidden = !hasContent;
    const marker = markerRef.current;
    if (!hasContent || !marker) return;
    return squareComposerTop(marker) ?? undefined;
  }, [slot, hasContent]);

  return (
    <>
      <span ref={markerRef} hidden />
      {slot && hasContent ? createPortal(content, slot) : content}
    </>
  );
}

// ---------------------------------------------------------------- the pond page

function Section({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col gap-3 rounded-xl border border-border bg-card p-4 ${className}`}>
      <div>
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-xs text-foreground">{label}</div>
        {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            option.value === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow transition-transform ${
          checked ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}

function KoiPortrait({ id, variety, length }: { id: string; variety: VarietyId; length: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawKoiPortrait(canvas, portraitKoi(id, variety, length));
  }, [id, variety, length]);
  return (
    <canvas
      ref={ref}
      width={26}
      height={12}
      aria-hidden
      className="h-9 w-[78px] shrink-0 rounded-md"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

function newKoiId(): string {
  return `koi-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function KoiCard({
  entry,
  scoops,
  canRelease,
  onChange,
  onRelease,
}: {
  entry: KoiEntry;
  scoops: number;
  canRelease: boolean;
  onChange: (entry: KoiEntry) => void;
  onRelease: () => void;
}) {
  const [name, setName] = useState(entry.name);
  useEffect(() => setName(entry.name), [entry.name]);
  const commit = () => {
    const trimmed = name.trim().slice(0, NAME_MAX);
    if (trimmed && trimmed !== entry.name) onChange({ ...entry, name: trimmed });
    else setName(entry.name);
  };
  const now = Date.now();
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border/60 p-2">
      <KoiPortrait id={entry.id} variety={entry.variety} length={koiLength(entry.addedAt, now)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          value={name}
          maxLength={NAME_MAX}
          aria-label="Name"
          onChange={(event) => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-full rounded bg-transparent px-1 text-sm text-foreground outline-none hover:bg-muted focus:bg-muted"
        />
        <div className="truncate px-1 text-[11px] text-muted-foreground">
          {VARIETY_INFO[entry.variety].name} · {ageLabel(entry.addedAt, now)}
          {scoops > 0 ? ` · scooped ${scoops}×` : ""}
        </div>
      </div>
      <button
        type="button"
        disabled={!canRelease}
        onClick={onRelease}
        title={canRelease ? `Release ${entry.name}` : "The pond needs at least one koi"}
        className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Release
      </button>
    </li>
  );
}

function AddKoi({ config, onAdd }: { config: PondConfig; onAdd: (entry: KoiEntry) => void }) {
  const [id, setId] = useState(newKoiId);
  const [variety, setVariety] = useState<VarietyId>("kohaku");
  const taken = new Set(config.koi.map((entry) => entry.name));
  const suggestion = KOI_NAMES.find((candidate) => !taken.has(candidate)) ?? "Koi";
  const [name, setName] = useState("");
  const full = config.koi.length >= MAX_KOI;
  const add = () => {
    onAdd({ id, variety, name: (name.trim() || suggestion).slice(0, NAME_MAX), addedAt: Date.now() });
    setId(newKoiId());
    setName("");
  };
  const surprise = () => {
    setId(newKoiId());
    setVariety(VARIETIES[Math.floor(Math.random() * VARIETIES.length)]!);
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {full
            ? `The pond is full at ${MAX_KOI} koi. Release one to make room.`
            : "Every koi's pattern is its own. This is how yours will look."}
        </span>
        <button
          type="button"
          disabled={full}
          onClick={surprise}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          New patterns
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5">
        {VARIETIES.map((option) => (
          <button
            key={option}
            type="button"
            disabled={full}
            aria-pressed={option === variety}
            title={VARIETY_INFO[option].blurb}
            onClick={() => setVariety(option)}
            className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px] transition-colors disabled:opacity-40 ${
              option === variety
                ? "border-primary bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-background"
            }`}
          >
            <KoiPortrait id={id} variety={option} length={9} />
            {VARIETY_INFO[option].name}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={name}
          disabled={full}
          maxLength={NAME_MAX}
          placeholder={suggestion}
          aria-label="New koi's name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !full) add();
          }}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
        />
        <button
          type="button"
          disabled={full}
          onClick={add}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Add to the pond
        </button>
      </div>
    </div>
  );
}

function ZenPondPage({ threadId }: { threadId?: string } = {}) {
  const reducedMotion = useReducedMotion();
  const { config, scoops, error, save, recordScoop } = usePondState();
  const sound = useSoundPrefs();
  const [pageView, setPageView] = useState<View>("pond");
  const session = useSession(threadId ?? "");
  const override = useViewOverride(threadId ?? "");
  const view = threadId ? override ?? (session && !session.ended ? config.views.working : "pond") : pageView;
  const setView = (next: View) => {
    if (threadId) setViewOverride(threadId, next);
    else setPageView(next);
  };
  const world = useMemo(createWorld, []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const breathDotRef = useRef<HTMLSpanElement | null>(null);
  const newsRef = useRef<News | null>(null);
  const hud = usePondLoop({
    active: true,
    world,
    config,
    view,
    rows: PAGE_ROWS,
    canvasRef,
    focusCanvas: false,
    reducedMotion,
    onScoop: recordScoop,
    breathDotRef,
    newsRef,
  });
  const controls = usePondControls(world, view, config, canvasRef, recordScoop, newsRef);
  const update = (patch: Partial<PondConfig>) => void save({ ...config, ...patch });
  const garden = (patch: Partial<PondConfig["garden"]>) =>
    update({ garden: { ...config.garden, ...patch } });
  const ambienceSet = (patch: Partial<PondConfig["ambience"]>) =>
    update({ ambience: { ...config.ambience, ...patch } });
  const now = new Date();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-medium text-foreground">Zen Pond</h1>
            <p className="text-xs text-muted-foreground">
              {capitalize(resolveSeason(config, now))} · {resolveTime(config, now)} ·{" "}
              {resolveWeather(config, now) === "rain" ? "rain" : "clear"} ·{" "}
              {config.koi.length === 1 ? "1 koi" : `${config.koi.length} koi`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<View>
              label="What the pond shows"
              value={view}
              onChange={setView}
              options={[
                { value: "pond", label: "Pond" },
                { value: "catch", label: "Catch" },
              ]}
            />
            <button
              type="button"
              aria-pressed={sound.enabled}
              onClick={() => setSoundPrefs({ ...sound, enabled: !sound.enabled })}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                sound.enabled
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon name={SOUND_ICON} className="size-3.5" aria-hidden />
              {sound.enabled ? "Sound on" : "Sound off"}
            </button>
          </div>
        </header>
        {error ? <p className="text-xs text-destructive">Could not save the pond: {error}</p> : null}

        <div className="relative overflow-hidden rounded-xl border border-border bg-card">
          <div
            role="button"
            tabIndex={0}
            aria-label={
              view === "catch"
                ? "Koi pond. Tap the water to move the poi; tap when a koi is over it to scoop."
                : "Koi pond. Click to scatter a little food."
            }
            className="block w-full cursor-pointer touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{ height: PAGE_ROWS * PIXEL_SCALE }}
            {...controls}
          >
            <canvas ref={canvasRef} className="block" style={{ imageRendering: "pixelated" }} aria-hidden />
          </div>
          <div className="pointer-events-none absolute right-2 bottom-2 left-2 flex items-end justify-between gap-2">
            <div className="min-w-0">{view === "catch" ? <CatchHud hud={hud} grade={config.poi} /> : null}</div>
            {hud.breath ? <BreathGuide phase={hud.breath} dotRef={breathDotRef} /> : null}
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
          <Section
            title="Your koi"
            description="Koi grow over their first two weeks. Released koi swim off for good."
            className="col-span-full"
          >
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
              {config.koi.map((entry) => (
                <KoiCard
                  key={entry.id}
                  entry={entry}
                  scoops={scoops[entry.id] ?? 0}
                  canRelease={config.koi.length > 1}
                  onChange={(next) =>
                    update({ koi: config.koi.map((koi) => (koi.id === next.id ? next : koi)) })
                  }
                  onRelease={() => update({ koi: config.koi.filter((koi) => koi.id !== entry.id) })}
                />
              ))}
            </ul>
            <AddKoi config={config} onAdd={(entry) => update({ koi: [...config.koi, entry] })} />
          </Section>

          <Section title="Above the chat input" description="What a thread's pond shows, and when.">
            <Row label="While the agent works" hint="Catch koi with a paper poi, or just watch.">
              <Segmented<View>
                label="While the agent works"
                value={config.views.working}
                onChange={(working) => update({ views: { ...config.views, working } })}
                options={[
                  { value: "catch", label: "Catch" },
                  { value: "pond", label: "Pond" },
                ]}
              />
            </Row>
            <Row label="When the agent is idle">
              <Segmented<IdleView>
                label="When the agent is idle"
                value={config.views.idle}
                onChange={(idle) => update({ views: { ...config.views, idle } })}
                options={[
                  { value: "pond", label: "Pond" },
                  { value: "hidden", label: "Hidden" },
                ]}
              />
            </Row>
            <p className="text-[11px] text-muted-foreground">
              The Pond and Catch switch on the pond changes the view until the agent starts or stops.
            </p>
          </Section>

          <Section
            title="Catching koi"
            description="Koi-sukui, the festival game with a paper poi, made simple."
          >
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              <li>Tap the water to move the poi there. It waits, and koi gather under a still poi.</li>
              <li>When a “!” shows over the poi, tap to scoop. Wait too long and the koi swims off.</li>
              <li>Wet paper weakens and big koi strain it. When it tears, a fresh poi comes.</li>
              <li>Scooped koi rest in the bowl, then go back. Leave it alone and it plays by itself.</li>
            </ul>
            <Row label="Poi paper" hint="Higher numbers are thinner, like at a real stall.">
              <Segmented<PoiGrade>
                label="Poi paper"
                value={config.poi}
                onChange={(poi) => update({ poi })}
                options={[
                  { value: "4", label: "No.4 thick" },
                  { value: "5", label: "No.5" },
                  { value: "6", label: "No.6 thin" },
                ]}
              />
            </Row>
          </Section>

          <Section title="Garden" description="What grows around the water.">
            <Row label="Pond layout" hint="Shoreline, stones, pads, and which side the tree stands on.">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => update({ layout: { ...config.layout, seed: newSeed() } })}
                  className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  New layout
                </button>
              </div>
            </Row>
            <Row label="New layout every day">
              <Switch
                label="New layout every day"
                checked={config.layout.daily}
                onChange={(daily) => update({ layout: { ...config.layout, daily } })}
              />
            </Row>
            <Row label="Stone lantern" hint="Lit from dusk to dawn, and in the rain.">
              <Switch label="Stone lantern" checked={config.garden.lantern} onChange={(lantern) => garden({ lantern })} />
            </Row>
            <Row label="Overhanging tree" hint="Sakura, summer green, maple red, or bare with snow.">
              <Switch label="Overhanging tree" checked={config.garden.tree} onChange={(tree) => garden({ tree })} />
            </Row>
            <Row label="Water plants">
              <Switch label="Water plants" checked={config.garden.plants} onChange={(plants) => garden({ plants })} />
            </Row>
            <Row label="Lily pads" hint="Lotus flowers bloom in spring and summer.">
              <Segmented<LilyAmount>
                label="Lily pads"
                value={config.garden.lilies}
                onChange={(lilies) => garden({ lilies })}
                options={[
                  { value: "none", label: "None" },
                  { value: "few", label: "Few" },
                  { value: "many", label: "Many" },
                ]}
              />
            </Row>
          </Section>

          <Section title="Ambience" description="Auto follows your calendar and clock, with rain now and then.">
            <Row label="Season">
              <Segmented
                label="Season"
                value={config.ambience.season}
                onChange={(season) => ambienceSet({ season })}
                options={[
                  { value: "auto", label: "Auto" },
                  ...SEASONS.map((value) => ({ value, label: capitalize(value) })),
                ]}
              />
            </Row>
            <Row label="Time of day">
              <Segmented
                label="Time of day"
                value={config.ambience.time}
                onChange={(time) => ambienceSet({ time })}
                options={[
                  { value: "auto", label: "Auto" },
                  ...TIMES.map((value) => ({ value, label: capitalize(value) })),
                ]}
              />
            </Row>
            <Row label="Weather">
              <Segmented<WeatherChoice>
                label="Weather"
                value={config.ambience.weather}
                onChange={(weather) => ambienceSet({ weather })}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "clear", label: "Clear" },
                  { value: "rain", label: "Rain" },
                ]}
              />
            </Row>
            <Row label="Sound" hint="Water, a wind chime, a shishi-odoshi. This device only.">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(sound.volume * 100)}
                  aria-label="Volume"
                  disabled={!sound.enabled}
                  onChange={(event) =>
                    setSoundPrefs({ ...sound, volume: Number(event.target.value) / 100 })
                  }
                  className="w-24 accent-primary disabled:opacity-40"
                />
                <Switch
                  label="Sound"
                  checked={sound.enabled}
                  onChange={(enabled) => setSoundPrefs({ ...sound, enabled })}
                />
              </div>
            </Row>
            <Row label="Breathing guide" hint="In for 4, hold for 2, out for 6, in the pond view.">
              <Switch
                label="Breathing guide"
                checked={config.ambience.breathing}
                onChange={(breathing) => ambienceSet({ breathing })}
              />
            </Row>
          </Section>
        </div>
      </div>
    </div>
  );
}

function ZenPondSettingsPanel({ threadId }: PluginThreadPanelProps) {
  return <ZenPondPage threadId={threadId} />;
}

function ZenPondNavPage() {
  return <ZenPondPage />;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "pond",
    scopes: ["thread"],
    banners: [{ id: "pond", chrome: "bare", component: PondBanner }],
  });
  app.slots.navPanel({
    id: "pond",
    title: "Zen Pond",
    icon: KOI_ICON,
    path: PAGE_PATH,
    component: ZenPondNavPage,
  });
  app.slots.threadPanelAction({
    id: SETTINGS_ACTION,
    title: "Zen Pond",
    icon: KOI_ICON,
    component: ZenPondSettingsPanel,
  });
});
