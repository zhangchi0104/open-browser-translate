import { Context, Effect, Layer } from "effect";
import type { AISettings } from "./model";

/** The current AI settings. Read on every use, so a change on the options page applies to the next request. */
export class Settings extends Context.Service<Settings, {
  readonly get: Effect.Effect<AISettings>;
}>()("open-browser-translate/Settings") {
  /** Always the given settings, for tests. */
  static readonly fixed = (settings: AISettings) => Layer.succeed(Settings, { get: Effect.sync(() => settings) });
}
