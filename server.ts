import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Zen Koi keeps nothing on the server: the pond lives in the app, and the only
// preferences (pond hidden, breathing guide, season) stay in the browser.
// bb still requires a server entry.
export default function plugin(_bb: BbPluginApi) {}
