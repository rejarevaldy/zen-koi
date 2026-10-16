import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_usePluginId,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import {
  addRipple,
  breathAt,
  dropFood,
  newPond,
  resizePond,
  SEASONS,
  seasonOf,
  stepPond,
  timeOfDay,
  type BreathPhase,
  type Pond,
  type Season,
} from "./koi.ts";
import { PIXEL_SCALE, PondScene, SCENE_HEIGHT, WATER_TOP } from "./scene.ts";
import { insertComposerSlot, squareComposerTop } from "./composer-dom.ts";
import { flood } from "./underwater.ts";

// Declared in package.json under bb.branding.experimental_icons.
const KOI_ICON = "zen-koi/koi";
const BREATH_ICON = "zen-koi/breath";

const FRAME_MS = 33;
/** Under reduced motion the koi hold still; the pond only redraws for resizes. */
const STILL_FRAME_MS = 500;
/** Hidden or off-screen ponds rest instead of swimming unseen. */
const IDLE_CHECK_MS = 500;
/** How often the breathing dot moves while the pond itself is hidden. */
const BREATH_TICK_MS = 100;
const MAX_STEP_MS = 100;
/**
 * `isRunning` dips to false for a moment at turn boundaries (a message sent
 * mid-turn, a queued message starting). Only a stop that lasts closes the pond.
 */
const STOP_GRACE_MS = 3_000;
const PHRASE_MS = 24_000;

const PHRASES = [
  "Your agent is working. You can rest here.",
  "Nothing to do but watch the water.",
  "Tap the water to feed the koi.",
  "Let your shoulders drop.",
  "Unclench your jaw. Soften your eyes.",
  "The work is moving. So is the water.",
];

const BREATH_LABEL: Record<BreathPhase, string> = {
  in: "Breathe in",
  hold: "Hold",
  out: "Breathe out",
};

type SeasonChoice = Season | "auto";
const SEASON_CHOICES: readonly SeasonChoice[] = ["auto", ...SEASONS];
const SEASON_NAME: Record<Season, string> = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  winter: "Winter",
};

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

/** A small preference kept in this browser. */
function useStored<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return allowed.includes(stored as T) ? (stored as T) : fallback;
    } catch {
      // Storage can be unavailable (private browsing, blocked cookies).
      return fallback;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Best effort only.
      }
    },
    [key],
  );
  return [value, update];
}

const ON_OFF = ["on", "off"] as const;

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
      className={`flex size-6 items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground ${
        pressed ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

function PondBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  return <ThreadPond isRunning={composer.isRunning} compact={composer.layout === "compact"} />;
}

function ThreadPond({ isRunning, compact }: { isRunning: boolean; compact: boolean }) {
  const pluginId = experimental_usePluginId();
  const reducedMotion = useReducedMotion();
  const [hidden, setHidden] = useStored(`${pluginId}.hidden`, "off", ON_OFF);
  const [breathing, setBreathing] = useStored(`${pluginId}.breathing`, "on", ON_OFF);
  const [seasonChoice, setSeasonChoice] = useStored<SeasonChoice>(
    `${pluginId}.season`,
    "auto",
    SEASON_CHOICES,
  );
  const [open, setOpen] = useState(isRunning);
  const [breath, setBreath] = useState<BreathPhase>("in");
  const [phrase, setPhrase] = useState(0);

  const pondRef = useRef<Pond | null>(null);
  const sceneRef = useRef<PondScene | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const breathDotRef = useRef<HTMLSpanElement | null>(null);
  const onScreenRef = useRef(true);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const breathingRef = useRef(breathing === "on");
  breathingRef.current = breathing === "on";
  const seasonRef = useRef(seasonChoice);
  seasonRef.current = seasonChoice;

  const showPond = open && hidden === "off" && !compact;
  const flooded = open && hidden === "off";
  // Stays in the banner slot, so it can find the composer even while the pond
  // renders elsewhere.
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const slot = useComposerSlot(markerRef, pluginId);
  // In the slot, the pond and the chat input below it read as one box.
  const frame = slot ? "rounded-t-xl border-b-0" : "rounded-lg";

  useEffect(() => {
    if (isRunning) {
      setOpen(true);
      return;
    }
    const timer = setTimeout(() => setOpen(false), STOP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isRunning]);

  // While the pond is open, water rises into the chat input below it.
  useEffect(() => {
    const marker = markerRef.current;
    if (!flooded || !marker) return;
    return flood(marker, { isReducedMotion: () => reducedMotionRef.current }) ?? undefined;
  }, [flooded]);

  useEffect(() => {
    if (!open || breathing === "on") return;
    const timer = setInterval(() => setPhrase((index) => (index + 1) % PHRASES.length), PHRASE_MS);
    return () => clearInterval(timer);
  }, [open, breathing]);

  // One loop per open pond. It restarts when the pond moves into the slot,
  // which remounts its canvas.
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = performance.now();
    let lastBreath: BreathPhase | null = null;
    const canvas = canvasRef.current;
    const scene = canvas ? new PondScene(canvas) : null;
    sceneRef.current = scene;

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(MAX_STEP_MS, now - last);
      last = now;
      const date = new Date();
      const choice = seasonRef.current;
      const season = choice === "auto" ? seasonOf(date) : choice;
      const time = timeOfDay(date);

      const breathNow = breathAt(Date.now());
      const breathTurned = breathNow.phase !== lastBreath;
      if (breathTurned) {
        lastBreath = breathNow.phase;
        setBreath(breathNow.phase);
      }
      breathDotRef.current?.style.setProperty(
        "transform",
        `scale(${(0.45 + breathNow.fullness * 0.55).toFixed(3)})`,
      );

      const visible =
        scene !== null &&
        canvas !== null &&
        canvas.isConnected &&
        onScreenRef.current &&
        document.visibilityState === "visible";
      if (!visible) {
        // The one-line guide still breathes; otherwise the pond just waits.
        const guiding = breathingRef.current && document.visibilityState === "visible";
        timer = setTimeout(tick, guiding ? BREATH_TICK_MS : IDLE_CHECK_MS);
        return;
      }

      const width = scene.resize(canvas.clientWidth);
      let pond = pondRef.current;
      if (!pond) {
        pond = newPond(width, SCENE_HEIGHT, WATER_TOP, Math.random);
        pondRef.current = pond;
      }
      resizePond(pond, width, Math.random);
      if (!reducedMotionRef.current) {
        // Each in-breath sends one slow ring out from the middle of the pond.
        if (breathingRef.current && breathTurned && breathNow.phase === "in") {
          addRipple(pond, width / 2, (WATER_TOP + SCENE_HEIGHT) / 2, 14, 3);
        }
        stepPond(pond, dt, { rng: Math.random, season, timeOfDay: time });
      }
      scene.draw({ pond, season, timeOfDay: time, now });

      const delay = reducedMotionRef.current ? STILL_FRAME_MS : FRAME_MS;
      timer = setTimeout(tick, Math.max(0, delay - (performance.now() - now)));
    };
    tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [open, showPond, slot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!showPond || !canvas) return;
    const observer = new IntersectionObserver(([entry]) => {
      onScreenRef.current = entry?.isIntersecting ?? true;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [showPond, slot]);

  const feedAt = (x: number, y: number) => {
    const pond = pondRef.current;
    if (pond) dropFood(pond, x, y, Math.random);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !sceneRef.current) return;
    const point = sceneRef.current.toPond(event.clientX, event.clientY);
    feedAt(point.x, point.y);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    const pond = pondRef.current;
    if (!pond || event.repeat) return;
    feedAt(
      pond.width * (0.2 + Math.random() * 0.6),
      WATER_TOP + 4 + Math.random() * (SCENE_HEIGHT - WATER_TOP - 8),
    );
  };
  const nextSeason = () => {
    const index = SEASON_CHOICES.indexOf(seasonChoice);
    setSeasonChoice(SEASON_CHOICES[(index + 1) % SEASON_CHOICES.length]!);
  };

  const seasonLabel =
    seasonChoice === "auto" ? `${SEASON_NAME[seasonOf(new Date())]} · auto` : SEASON_NAME[seasonChoice];
  const guide =
    breathing === "on" ? (
      <span className="flex min-w-0 items-center gap-2">
        <span className="relative flex size-3 shrink-0 items-center justify-center" aria-hidden>
          <span
            ref={breathDotRef}
            className="block size-3 rounded-full bg-primary/50 transition-transform duration-100 ease-linear motion-reduce:transition-none"
          />
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{BREATH_LABEL[breath]}</span>
      </span>
    ) : (
      <span className="min-w-0 truncate text-muted-foreground">{PHRASES[phrase]}</span>
    );

  let content: ReactNode = null;
  if (open && !showPond) {
    content = (
      <section
        aria-label="Zen Koi"
        className={`flex h-8 items-center gap-2 border border-border bg-card pr-1 pl-3 text-xs ${frame}`}
      >
        <Icon name={KOI_ICON} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-1">{guide}</span>
        {compact ? null : (
          <IconButton label="Show the pond" icon="ChevronUp" onClick={() => setHidden("off")} />
        )}
      </section>
    );
  } else if (showPond) {
    content = (
      <section
        aria-label="Zen Koi"
        className={`relative overflow-hidden border border-border bg-card ${frame}`}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label="Koi pond. Click or press Enter to scatter a little food."
          className="block w-full cursor-pointer touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ height: SCENE_HEIGHT * PIXEL_SCALE }}
          // Keep the caret in the composer: clicking the pond must not steal focus.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        >
          <canvas
            ref={canvasRef}
            className="block size-full"
            style={{ imageRendering: "pixelated" }}
            aria-hidden
          />
        </div>
        <div className="absolute top-1 right-1.5 flex items-center gap-0.5 rounded-md bg-background/80 p-0.5 shadow-sm backdrop-blur-sm">
          <button
            type="button"
            title="Change the season"
            onClick={nextSeason}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {seasonLabel}
          </button>
          <IconButton
            label={breathing === "on" ? "Turn off the breathing guide" : "Turn on the breathing guide"}
            icon={BREATH_ICON}
            pressed={breathing === "on"}
            onClick={() => setBreathing(breathing === "on" ? "off" : "on")}
          />
          <IconButton label="Hide the pond" icon="ChevronDown" onClick={() => setHidden("on")} />
        </div>
        <div className="pointer-events-none absolute right-1.5 bottom-1.5 flex max-w-[60%] items-center rounded-md bg-background/80 px-2 py-0.5 text-xs shadow-sm backdrop-blur-sm">
          {guide}
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

export default definePluginApp((app) => {
  app.composer.customize({
    id: "pond",
    scopes: ["thread"],
    banners: [{ id: "pond", chrome: "bare", component: PondBanner }],
  });
});
