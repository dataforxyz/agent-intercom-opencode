import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeOpenCodeSessionStatus, OpenCodePeerHealthReporter } from "./health.ts";

test("OpenCode session status accepts the SDK object shape", () => {
  assert.equal(normalizeOpenCodeSessionStatus({ type: "busy" }), "busy");
  assert.equal(normalizeOpenCodeSessionStatus({ type: "idle" }), "idle");
  assert.equal(normalizeOpenCodeSessionStatus("retry"), "retry");
});

test("OpenCode peer health becomes ready only after Intercom and session readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-peer-health-"));
  try {
    const path = join(dir, "health.json");
    const reporter = new OpenCodePeerHealthReporter({
      path,
      runId: "run-1",
      workerId: "worker-1",
      intercomSessionId: "worker-1",
      serverUrl: "http://127.0.0.1:4096",
      directory: "/repo",
      pid: 42,
    });
    assert.equal(reporter.snapshot().ready, false);
    reporter.update({ connected: true });
    assert.equal(reporter.snapshot().ready, false);
    reporter.update({ openCodeSessionId: "ses_123", status: "idle" });
    assert.equal(reporter.snapshot().ready, true);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.runId, "run-1");
    assert.equal(persisted.openCodeSessionId, "ses_123");
    assert.equal(persisted.ready, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
