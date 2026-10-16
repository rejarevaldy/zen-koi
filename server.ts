import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  defaultConfig,
  IDLE_VIEWS,
  LILY_AMOUNTS,
  MAX_KOI,
  NAME_MAX,
  POI_GRADES,
  STYLES,
  POND_CHANNEL,
  SEASONS,
  TIMES,
  VARIETIES,
  VIEWS,
  WEATHERS,
  type PondConfig,
} from "./config.ts";

const POND_KEY = "pond";
const SCOOPS_KEY = "scoops";
const koiId = z.string().regex(/^[a-z0-9-]{1,40}$/);

const koiListSchema = z
  .array(
    z
      .object({
        id: koiId,
        variety: z.enum(VARIETIES),
        name: z.string().trim().min(1).max(NAME_MAX),
        addedAt: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_KOI)
  .refine((koi) => new Set(koi.map((entry) => entry.id)).size === koi.length, {
    message: "koi ids must be unique",
  });

const gardenSchema = z
  .object({
    lantern: z.boolean(),
    tree: z.boolean(),
    lilies: z.enum(LILY_AMOUNTS),
    plants: z.boolean(),
  })
  .strict();

const layoutSchema = z
  .object({ seed: z.number().int().nonnegative().max(2 ** 32), daily: z.boolean() })
  .strict();

const ambienceSchema = z
  .object({
    season: z.enum(["auto", ...SEASONS]),
    time: z.enum(["auto", ...TIMES]),
    weather: z.enum(WEATHERS),
    breathing: z.boolean(),
  })
  .strict();

const viewsSchema = z.object({ working: z.enum(VIEWS), idle: z.enum(IDLE_VIEWS) }).strict();

export const pondSchema = z
  .object({
    koi: koiListSchema,
    garden: gardenSchema,
    layout: layoutSchema,
    ambience: ambienceSchema,
    views: viewsSchema,
    poi: z.enum(POI_GRADES),
    style: z.enum(STYLES).optional(),
  })
  .strict();

/** How many times each koi has been scooped, by koi id. */
const scoopsSchema = z.record(z.string(), z.number().int().nonnegative());

const pondStateSchema = z.object({ config: pondSchema, scoops: scoopsSchema });

export const rpcContract = defineRpcContract({
  getPond: { input: z.null(), output: pondStateSchema },
  setPond: { input: pondSchema, output: pondStateSchema },
  recordScoop: {
    input: z.object({ koiId }).strict(),
    output: z.object({ count: z.number().int() }),
  },
});

/**
 * Reads a stored pond. A pond saved by an older version keeps every part that
 * is still valid (above all, the player's koi); the rest falls back to defaults.
 */
export function readPond(stored: unknown, now: number): PondConfig {
  const parsed = pondSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  const fallback = defaultConfig(now);
  if (typeof stored !== "object" || stored === null) return fallback;
  const old = stored as Record<string, unknown>;
  const part = <T,>(schema: z.ZodType<T>, value: unknown, otherwise: T): T => {
    const result = schema.safeParse(value);
    return result.success ? result.data : otherwise;
  };
  const oldAmbience = typeof old.ambience === "object" && old.ambience !== null ? old.ambience : {};
  return {
    koi: part(koiListSchema, old.koi, fallback.koi),
    garden: part(gardenSchema, old.garden, fallback.garden),
    layout: part(layoutSchema, old.layout, fallback.layout),
    ambience: part(ambienceSchema, { ...fallback.ambience, ...oldAmbience }, fallback.ambience),
    views: part(viewsSchema, old.views, fallback.views),
    poi: part(z.enum(POI_GRADES), old.poi, fallback.poi),
    style: part(z.enum(STYLES), old.style, "pixel"),
  };
}

export function readScoops(stored: unknown): Record<string, number> {
  const parsed = scoopsSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

export default function plugin(bb: BbPluginApi) {
  const readState = async () => {
    const stored = await bb.storage.kv.get(POND_KEY);
    const config = readPond(stored, Date.now());
    // Keep what was read (a migrated pond, or a new seed) so every window agrees.
    if (!pondSchema.safeParse(stored).success) await bb.storage.kv.set(POND_KEY, config);
    return { config, scoops: readScoops(await bb.storage.kv.get(SCOOPS_KEY)) };
  };
  // Scoops arrive one at a time from any window; serialize the read-modify-write.
  let scoopQueue: Promise<unknown> = Promise.resolve();

  bb.rpc.register(rpcContract, {
    getPond: readState,
    setPond: async (pond) => {
      await bb.storage.kv.set(POND_KEY, pond);
      bb.realtime.publish(POND_CHANNEL, {});
      return readState();
    },
    recordScoop: ({ koiId: id }) => {
      const next = scoopQueue.then(async () => {
        const scoops = readScoops(await bb.storage.kv.get(SCOOPS_KEY));
        scoops[id] = (scoops[id] ?? 0) + 1;
        await bb.storage.kv.set(SCOOPS_KEY, scoops);
        bb.realtime.publish(POND_CHANNEL, {});
        return { count: scoops[id] };
      });
      scoopQueue = next.catch(() => undefined);
      return next;
    },
  });
}
