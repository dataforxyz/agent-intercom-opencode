import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableInboundStore } from "./inbound-store.ts";
import { buildOpenCodeRuntimeIdentity, OpenCodeIntercomRuntime } from "./runtime.ts";

test("Intercom identity does not conflate the OpenCode session namespace", () => {
  const identity = buildOpenCodeRuntimeIdentity({ OPENCODE_INTERCOM_SESSION_ID: "intercom-worker", OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.equal(identity.sessionId, "intercom-worker");
  const fallback = buildOpenCodeRuntimeIdentity({ OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.notEqual(fallback.sessionId, "ses_open_code");
});

test("inbound delivery is durably queued and acknowledged before model injection completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-intercom-runtime-"));
  try {
    let finishInjection!: () => void;
    const injection = new Promise<void>((resolve) => { finishInjection = resolve; });
    const store = new DurableInboundStore(join(dir, "inbound.json"));
    const runtime = new OpenCodeIntercomRuntime(
      { sessionId: "receiver", name: "receiver", cwd: "/repo", model: "test", startedAt: 1 },
      "/repo",
      async () => injection,
      store,
    );
    const acknowledgements: string[] = [];
    (runtime as any).client = {
      acknowledgeMessage(deliveryId: string) {
        acknowledgements.push(deliveryId);
        return true;
      },
    };

    (runtime as any).handleIncomingMessage(
      { id: "sender", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
      { id: "message-1", content: { text: "hello" }, timestamp: 1 },
      "delivery-1",
    );

    assert.deepEqual(acknowledgements, ["delivery-1"]);
    assert.deepEqual(new DurableInboundStore(store.path).pendingInjection().map((entry) => entry.message.id), ["message-1"]);
    finishInjection();
    await injection;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
