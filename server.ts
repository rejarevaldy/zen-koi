import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ACTIVITIES,
  defaultConfig,
  LILY_AMOUNTS,
  MAX_KOI,
  NAME_MAX,
  POI_GRADES,
  POND_CHANNEL,
  SEASONS,
  SHOW_MODES,
  TIMES,
  VARIETIES,
  WEATHERS,
  type PondConfig,
} from "./config.ts";

const POND_KEY = "pond";
const SCOOPS_KEY = "scoops";

export const pondSchema = z
  .object({
    koi: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]{1,40}$/),
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
      }),
    garden: z
      .object({
        lantern: z.boolean(),
        tree: z.boolean(),
        lilies: z.enum(LILY_AMOUNTS),
        plants: z.boolean(),
      })
      .strict(),
    ambience: z
      .object({
        season: z.enum(["auto", ...SEASONS]),
        time: z.enum(["auto", ...TIMES]),
        weather: z.enum(WEATHERS),
        breathing: z.boolean(),
      })
      .strict(),
    show: z.enum(SHOW_MODES),
    activity: z.enum(ACTIVITIES),
    poi: z.enum(POI_GRADES),
  })
  .strict();

/** How many times each koi has been scooped, by koi id. */
const scoopsSchema = z.record(z.string(), z.number().int().nonnegative());

const pondStateSchema = z.object({ config: pondSchema, scoops: scoopsSchema });

export const rpcContract = defineRpcContract({
  getPond: { input: z.null(), output: pondStateSchema },
  setPond: { input: pondSchema, output: pondStateSchema },
  recordScoop: {
    input: z.object({ koiId: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
    output: z.object({ count: z.number().int() }),
  },
});

/** A stored pond from an older version, or a damaged one, falls back to the default. */
export function readPond(stored: unknown, now: number): PondConfig {
  const parsed = pondSchema.safeParse(stored);
  return parsed.success ? parsed.data : defaultConfig(now);
}

export function readScoops(stored: unknown): Record<string, number> {
  const parsed = scoopsSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

export default function plugin(bb: BbPluginApi) {
  const readState = async () => ({
    config: readPond(await bb.storage.kv.get(POND_KEY), Date.now()),
    scoops: readScoops(await bb.storage.kv.get(SCOOPS_KEY)),
  });
  // Scoops arrive one at a time from any window; serialize the read-modify-write.
  let scoopQueue: Promise<unknown> = Promise.resolve();

  bb.rpc.register(rpcContract, {
    getPond: readState,
    setPond: async (pond) => {
      await bb.storage.kv.set(POND_KEY, pond);
      bb.realtime.publish(POND_CHANNEL, {});
      return readState();
    },
    recordScoop: ({ koiId }) => {
      const next = scoopQueue.then(async () => {
        const scoops = readScoops(await bb.storage.kv.get(SCOOPS_KEY));
        scoops[koiId] = (scoops[koiId] ?? 0) + 1;
        await bb.storage.kv.set(SCOOPS_KEY, scoops);
        bb.realtime.publish(POND_CHANNEL, {});
        return { count: scoops[koiId] };
      });
      scoopQueue = next.catch(() => undefined);
      return next;
    },
  });
}
