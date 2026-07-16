import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableInboundStore } from "./inbound-store.ts";
import { buildOpenCodeRuntimeIdentity, OpenCodeIntercomRuntime, selectPendingAsk, type PendingInboundMessage } from "./runtime.ts";

test("Intercom identity does not conflate the OpenCode session namespace", () => {
  const identity = buildOpenCodeRuntimeIdentity({ OPENCODE_INTERCOM_SESSION_ID: "intercom-worker", OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.equal(identity.sessionId, "intercom-worker");
  const fallback = buildOpenCodeRuntimeIdentity({ OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.notEqual(fallback.sessionId, "ses_open_code");
});

test("selectPendingAsk uses oldest/latest without exposing message IDs", () => {
  const from = { id: "sender-1", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
  const pending = (id: string, receivedAt: number): PendingInboundMessage => ({
    from,
    message: { id, timestamp: receivedAt, expectsReply: true, content: { text: id } },
    deliveryId: `delivery-${id}`,
    receivedAt,
    read: false,
  });
  const asks = [pending("ask-1", 10), pending("ask-2", 20)];

  assert.throws(() => selectPendingAsk(asks, "sender"), /specify `which`/);
  assert.equal(selectPendingAsk(asks, "sender", "oldest").message.id, "ask-1");
  assert.equal(selectPendingAsk(asks, "sender", "latest").message.id, "ask-2");
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
