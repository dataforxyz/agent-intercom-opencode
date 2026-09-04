import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url);

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as Record<string, any>;
}

test("published package contains exactly the intended protected-provider source and artifact", () => {
  const packageManifest = manifest();
  const providerRules = packageManifest.files.filter((path: string) => path.replace(/^!/, "").startsWith("provider/"));

  assert.deepEqual(providerRules, [
    "provider/protected-service.ts",
    "provider/provider.mjs",
    "!provider/entry.ts",
  ]);
  assert.ok(packageManifest.files.includes("!scripts/build-protected-provider.mjs"));
  assert.equal(providerRules.some((path: string) => path.includes("*")), false);
  assert.ok(existsSync(new URL("provider/protected-service.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/provider.mjs", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/entry.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/protected-service.test.ts", repositoryRoot)));

});

test("protected provider is neither an export, plugin, executable, nor ordinary build entry", () => {
  const packageManifest = manifest();
  const ordinaryBuild = readFileSync(new URL("scripts/build.mjs", repositoryRoot), "utf8");

  assert.equal(packageManifest.main, "dist/index.mjs");
  assert.deepEqual(packageManifest.exports, {
    ".": "./dist/index.mjs",
    "./tui": "./dist/tui.mjs",
  });
  assert.equal(packageManifest.bin, undefined);
  assert.equal(Object.values(packageManifest.exports).includes("./provider/provider.mjs"), false);
  assert.doesNotMatch(ordinaryBuild, /protected-provider|provider\/provider\.mjs|provider\/entry\.ts/);
  assert.deepEqual(Array.from(ordinaryBuild.matchAll(/entryPoints: \["([^"]+)"\]/g), (match) => match[1]), [
    "opencode/plugin.ts",
    "opencode/public.ts",
    "opencode/tui.ts",
    "broker/broker.ts",
  ]);
  assert.equal(packageManifest.scripts.build, "node scripts/build.mjs");
  assert.equal(packageManifest.scripts.prepare, "npm run build");
  assert.equal(packageManifest.scripts.prepack, "npm run build:protected-provider");
});

test("ordinary builds retain the shared Core externalizer and exactly four dist bundles", () => {
  const ordinaryBuild = readFileSync(new URL("scripts/build.mjs", repositoryRoot), "utf8");
  const coreExternalizer = readFileSync(new URL("scripts/core-external.mjs", repositoryRoot), "utf8");

  assert.match(ordinaryBuild, /import \{ externalizeCorePlugin \} from "\.\/core-external\.mjs"/);
  assert.match(ordinaryBuild, /plugins: \[externalizeCorePlugin\]/);
  assert.deepEqual(Array.from(ordinaryBuild.matchAll(/outfile: "dist\/([^"]+)"/g), (match) => match[1]), [
    "plugin.mjs",
    "index.mjs",
    "tui.mjs",
    "broker.mjs",
  ]);
  assert.match(coreExternalizer, /export const CORE_PACKAGE = "@dataforxyz\/agent-intercom-core"/);
  assert.match(coreExternalizer, /\^@dataforxyz\\\/agent-intercom-core\(\?:\\\/\.\*\)\?\$/);
  assert.match(coreExternalizer, /external: true/);
  assert.doesNotMatch(coreExternalizer, /protected-provider|provider\/provider\.mjs|provider\/entry\.ts/);
});
