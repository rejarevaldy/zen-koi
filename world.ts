// One pond world as the app runs it: the koi, the painter that draws them,
// and the poi while the view is "catch". The strip and the pond page each own one.

import { layoutSeed, resolveSeason, resolveTime, resolveWeather, type PondConfig, type View } from "./config.ts";
import { newPond, resizePond, stepPond, syncKoi, type Pond } from "./koi.ts";
import { PondPainter, SHORE_ROWS, STRIP_ROWS, type Environment } from "./scene.ts";
import { TextPainter } from "./text.ts";
import { fitSukui, newSukui, releaseAll, stepSukui, type Sukui, type SukuiEvent } from "./sukui.ts";

export type World = { pond: Pond; painter: PondPainter; text: TextPainter; sukui: Sukui | null };

export function createWorld(): World {
  return {
    pond: newPond(80, STRIP_ROWS, SHORE_ROWS),
    painter: new PondPainter(),
    text: new TextPainter(),
    sukui: null,
  };
}

export function environmentFor(config: PondConfig, date: Date): Environment {
  return {
    seed: layoutSeed(config, date),
    season: resolveSeason(config, date),
    time: resolveTime(config, date),
    weather: resolveWeather(config, date),
    garden: config.garden,
  };
}

export type WorldSize = { width: number; height: number; focusBottom: number };

/** Fits the world to its canvases and the player's choices, then moves it on by `dtMs`. */
export function advanceWorld(
  world: World,
  size: WorldSize,
  config: PondConfig,
  env: Environment,
  dtMs: number,
  still: boolean,
  view: View,
): SukuiEvent[] {
  const { pond, painter } = world;
  const events: SukuiEvent[] = [];
  resizePond(pond, size.width, size.height, size.focusBottom, Math.random);
  painter.layout(size.width, size.height, size.focusBottom, env);
  pond.canopy = painter.canopy;
  syncKoi(pond, config.koi, Date.now(), Math.random);

  if (view === "catch") {
    world.sukui ??= newSukui(config.poi, pond, size.focusBottom);
    world.sukui.grade = config.poi;
    fitSukui(world.sukui, pond, size.focusBottom);
  } else if (world.sukui) {
    events.push(...releaseAll(world.sukui, pond, Math.random));
    world.sukui = null;
  }

  if (!still) {
    stepPond(pond, dtMs, {
      rng: Math.random,
      season: env.season,
      timeOfDay: env.time,
      weather: env.weather,
    });
    if (world.sukui) events.push(...stepSukui(world.sukui, pond, dtMs, Math.random));
  }
  return events;
}
