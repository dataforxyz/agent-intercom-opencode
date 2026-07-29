import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CORE_PACKAGE,
  isCoreImport,
} from "../scripts/core-external.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundles = ["plugin.mjs", "tui.mjs", "broker.mjs"] as const;
const exactCoreDevGit = "git+https://github.com/dataforxyz/agent-intercom-core.git#8316cbab548f422ad11c78ed887fabeef94817c1";

test("Core source matcher covers the package root and every subpath only", () => {
  assert.equal(isCoreImport(CORE_PACKAGE), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}/boss`), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}/boss/policy`), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}/future/nested/export`), true);
  assert.equal(isCoreImport(`${CORE_PACKAGE}-lookalike`), false);
  assert.equal(isCoreImport("@dataforxyz/agent-intercom"), false);

  const buildSource = readFileSync(join(root, "scripts/build.mjs"), "utf8");
  assert.match(buildSource, /plugins: \[externalizeCorePlugin\]/);
  assert.match(buildSource, /external: \["@opencode-ai\/plugin"\]/);
  assert.match(buildSource, /external: \["@opencode-ai\/plugin\/tui"\]/);
});

test("every dist bundle retains Core imports without embedding a second copy", () => {
  for (const bundle of bundles) {
    const source = readFileSync(join(root, "dist", bundle), "utf8");
    const coreSpecifiers = Array.from(
      source.matchAll(/from\s+["'](@dataforxyz\/agent-intercom-core(?:\/[^"']*)?)["']/g),
      match => match[1],
    );
    assert.ok(coreSpecifiers.length > 0, `${bundle} must retain at least one external Core import`);
    assert.ok(coreSpecifiers.every(isCoreImport), `${bundle} contains an invalid Core import`);
    assert.doesNotMatch(
      source,
      /node_modules\/@dataforxyz\/agent-intercom-core\//,
      `${bundle} must not embed Core implementation modules`,
    );
  }
});

test("package manifest requires one exact Core runtime peer and keeps Git as dev provenance", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as Record<string, any>;

  assert.equal(manifest.peerDependencies?.[CORE_PACKAGE], "0.1.0");
  assert.equal(manifest.dependencies?.[CORE_PACKAGE], undefined);
  assert.equal(manifest.devDependencies?.[CORE_PACKAGE], exactCoreDevGit);
  assert.equal(lock.packages?.[""]?.peerDependencies?.[CORE_PACKAGE], "0.1.0");
  assert.equal(lock.packages?.[""]?.dependencies?.[CORE_PACKAGE], undefined);
  assert.equal(lock.packages?.[""]?.devDependencies?.[CORE_PACKAGE], exactCoreDevGit);
  assert.ok(manifest.files?.includes("dist/**/*"));
  assert.ok(manifest.files?.includes("opencode/**/*.ts"));
  assert.ok(manifest.files?.includes("broker/**/*.ts"));
});

test("shipped TUI resolves against an explicitly supplied Core package offline", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-intercom-offline-core-"));
  try {
    const modules = join(fixture, "node_modules");
    const adapterDir = join(modules, "@dataforxyz", "agent-intercom-opencode");
    const coreDir = join(modules, "@dataforxyz", "agent-intercom-core");
    mkdirSync(adapterDir, { recursive: true });
    cpSync(join(root, "package.json"), join(adapterDir, "package.json"));
    cpSync(join(root, "dist"), join(adapterDir, "dist"), { recursive: true });
    cpSync(join(root, "node_modules", ...CORE_PACKAGE.split("/")), coreDir, { recursive: true });

    const entrypoint = pathToFileURL(join(adapterDir, "dist", "tui.mjs")).href;
    const loaded = await import(`${entrypoint}?offline-explicit-core=${Date.now()}`);
    assert.equal(loaded.default?.id, "opencode-intercom");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
