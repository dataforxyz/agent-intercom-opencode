import { build } from "esbuild";
import { externalizeCorePlugin } from "./core-external.mjs";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  plugins: [externalizeCorePlugin],
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["opencode/plugin.ts"],
    outfile: "dist/plugin.mjs",
    external: ["@opencode-ai/plugin"],
  }),
  build({
    ...common,
    entryPoints: ["opencode/tui.ts"],
    outfile: "dist/tui.mjs",
    external: ["@opencode-ai/plugin/tui"],
  }),
  build({
    ...common,
    entryPoints: ["broker/broker.ts"],
    outfile: "dist/broker.mjs",
  }),
]);
