import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IntercomClient } from "../broker/client.ts";
import { DurableInboundStore } from "./inbound-store.ts";
import { buildOpenCodeRuntimeIdentity, formatSessionDisplay, formatSessionList, OpenCodeIntercomRuntime, selectPendingAsk, type PendingInboundMessage } from "./runtime.ts";

class FakeIntercomClient extends EventEmitter {
  connected = false;
  connectCount = 0;
  sessionId: string | null = null;

  isConnected(): boolean { return this.connected; }
  async connect(_registration: unknown, sessionId?: string): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
    this.sessionId = sessionId ?? "fake-session";
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionId = null;
  }
  acknowledgeMessage(): void {}
  drop(): void {
    this.connected = false;
    this.sessionId = null;
    this.emit("disconnected", new Error("broker restarted"));
  }
}

test("Intercom identity does not conflate the OpenCode session namespace", () => {
  const identity = buildOpenCodeRuntimeIdentity({ OPENCODE_INTERCOM_SESSION_ID: "intercom-worker", OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.equal(identity.sessionId, "intercom-worker");
  const fallback = buildOpenCodeRuntimeIdentity({ OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.notEqual(fallback.sessionId, "ses_open_code");
});

test("remote session provenance is visible in model-facing labels", () => {
  const remote = { id: "remote", name: "worker", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1, origin: "remote" as const, remoteHostId: "ika-dev-v3" };
  assert.equal(formatSessionDisplay(remote), "worker [remote:ika-dev-v3]");
  assert.match(formatSessionList([remote], null, "/other"), /worker \[remote:ika-dev-v3\]/);
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

test("runtime reconnects automatically and reports connection state after the broker drops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-intercom-reconnect-"));
  try {
    const first = new FakeIntercomClient();
    const second = new FakeIntercomClient();
    const clients = [first, second];
    const runtime = new OpenCodeIntercomRuntime(
      { sessionId: "reconnect-opencode", name: "reconnect-opencode", cwd: "/repo", model: "test", startedAt: Date.now() },
      "/repo",
      undefined,
      new DurableInboundStore(join(dir, "inbound.json")),
      {
        clientFactory: () => clients.shift() as unknown as IntercomClient,
        prepareConnection: async () => {},
        reconnectDelays: [1],
      },
    );
    const states: boolean[] = [];
    runtime.setConnectionStateHandler((connected) => states.push(connected));

    await runtime.connect();
    first.drop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.connectCount, 1);
    assert.equal(second.sessionId, "reconnect-opencode");
    assert.deepEqual(states, [true, false, true]);
    await runtime.disconnect();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
