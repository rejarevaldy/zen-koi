// What the player keeps: their koi, their garden, and how the pond feels. The
// server validates and stores it; this module holds the shared shape, defaults,
// and display names, with no runtime dependencies, so the app bundle stays small.

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export const TIMES = ["dawn", "day", "dusk", "night"] as const;
export type TimeOfDay = (typeof TIMES)[number];

export const VARIETIES = [
  "kohaku",
  "tancho",
  "sanke",
  "showa",
  "ogon",
  "yamabuki",
  "asagi",
  "chagoi",
  "shiro-utsuri",
  "kumonryu",
] as const;
export type VarietyId = (typeof VARIETIES)[number];

export const VARIETY_INFO: Record<VarietyId, { name: string; blurb: string }> = {
  kohaku: { name: "Kohaku", blurb: "White with red patches." },
  tancho: { name: "Tancho", blurb: "White, with one red circle on the head." },
  sanke: { name: "Sanke", blurb: "White and red, with small black spots." },
  showa: { name: "Showa", blurb: "Black, with red and white." },
  ogon: { name: "Ogon", blurb: "Metallic gold all over." },
  yamabuki: { name: "Yamabuki", blurb: "Soft metallic yellow." },
  asagi: { name: "Asagi", blurb: "Blue-grey scales over orange flanks." },
  chagoi: { name: "Chagoi", blurb: "Bronze, calm, and friendly." },
  "shiro-utsuri": { name: "Shiro Utsuri", blurb: "Black and white." },
  kumonryu: { name: "Kumonryu", blurb: "Black and white swirls, like ink." },
};

export const MAX_KOI = 9;
export const NAME_MAX = 24;

export type KoiEntry = {
  id: string;
  variety: VarietyId;
  name: string;
  /** When the koi joined the pond; koi grow over their first two weeks. */
  addedAt: number;
};

export const LILY_AMOUNTS = ["none", "few", "many"] as const;
export type LilyAmount = (typeof LILY_AMOUNTS)[number];

export const WEATHERS = ["auto", "clear", "rain"] as const;
export type WeatherChoice = (typeof WEATHERS)[number];
export type Weather = Exclude<WeatherChoice, "auto">;

/** What the strip above the chat input shows. */
export const VIEWS = ["catch", "pond"] as const;
export type View = (typeof VIEWS)[number];
export const IDLE_VIEWS = ["pond", "hidden"] as const;
export type IdleView = (typeof IDLE_VIEWS)[number];

/** Poi paper, numbered like a festival stall's: higher is thinner. */
export const POI_GRADES = ["4", "5", "6"] as const;
export type PoiGrade = (typeof POI_GRADES)[number];

export type PondConfig = {
  koi: KoiEntry[];
  garden: { lantern: boolean; tree: boolean; lilies: LilyAmount; plants: boolean };
  /** The pond's shape comes from this seed; `daily` gives it a new one each day. */
  layout: { seed: number; daily: boolean };
  ambience: {
    season: Season | "auto";
    time: TimeOfDay | "auto";
    weather: WeatherChoice;
    breathing: boolean;
  };
  /** What the strip shows while the agent works, and when it is idle. */
  views: { working: View; idle: IdleView };
  poi: PoiGrade;
};

const DAY_MS = 86_400_000;

export function defaultConfig(now: number): PondConfig {
  // Staggered ages, so a new pond already has a big koi and a small one.
  const koi = (id: string, variety: VarietyId, name: string, days: number): KoiEntry => ({
    id,
    variety,
    name,
    addedAt: now - days * DAY_MS,
  });
  return {
    koi: [
      koi("hana", "kohaku", "Hana", 14),
      koi("sora", "tancho", "Sora", 9),
      koi("kin", "ogon", "Kin", 5),
      koi("kage", "showa", "Kage", 2),
    ],
    garden: { lantern: true, tree: true, lilies: "few", plants: true },
    layout: { seed: newSeed(), daily: true },
    ambience: { season: "auto", time: "auto", weather: "auto", breathing: false },
    views: { working: "catch", idle: "pond" },
    poi: "4",
  };
}

/** Body length in pond pixels: 9 when new, 14 after two weeks. */
export function koiLength(addedAt: number, now: number): number {
  const days = Math.max(0, (now - addedAt) / DAY_MS);
  return 9 + Math.min(5, Math.floor(days / 2.8));
}

export function ageLabel(addedAt: number, now: number): string {
  const days = Math.floor(Math.max(0, now - addedAt) / DAY_MS);
  if (days === 0) return "New today";
  if (days === 1) return "1 day in the pond";
  return `${days} days in the pond`;
}

export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

export function timeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 17) return "day";
  if (hour >= 17 && hour < 19) return "dusk";
  return "night";
}

export function resolveSeason(config: PondConfig, date: Date): Season {
  return config.ambience.season === "auto" ? seasonOf(date) : config.ambience.season;
}

export function resolveTime(config: PondConfig, date: Date): TimeOfDay {
  return config.ambience.time === "auto" ? timeOfDay(date) : config.ambience.time;
}

export function newSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/** The seed the pond is drawn from today. */
export function layoutSeed(config: PondConfig, date: Date): number {
  if (!config.layout.daily) return config.layout.seed;
  const day = Math.floor((date.getTime() - date.getTimezoneOffset() * 60_000) / DAY_MS);
  return mixSeed(config.layout.seed, day);
}

/** Auto weather: mostly clear, with a spell of rain now and then, the same in every window. */
export function resolveWeather(config: PondConfig, date: Date): Weather {
  if (config.ambience.weather !== "auto") return config.ambience.weather;
  const spell = Math.floor(date.getTime() / (40 * 60_000));
  return (mixSeed(config.layout.seed, spell) % 100) / 100 < 0.2 ? "rain" : "clear";
}

function mixSeed(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

export const POND_CHANNEL = "pond";
