import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableInboundStore } from "./inbound-store.ts";

function entry(id: string, expectsReply = false) {
  return {
    from: { id: "sender", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
    message: { id, content: { text: `message ${id}` }, timestamp: 1, ...(expectsReply ? { expectsReply: true } : {}) },
    deliveryId: `delivery-${id}`,
    receivedAt: 1,
    read: false,
  };
}

test("durable inbound store replays pending injection after reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-intercom-inbound-"));
  try {
    const path = join(dir, "inbound.json");
    const first = new DurableInboundStore(path);
    assert.equal(first.enqueue(entry("message-1")), "new");
    const second = new DurableInboundStore(path);
    assert.deepEqual(second.pendingInjection().map((item) => item.message.id), ["message-1"]);
    second.markInjected("message-1");
    const third = new DurableInboundStore(path);
    assert.deepEqual(third.pendingInjection(), []);
    assert.equal(third.enqueue(entry("message-1")), "delivered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable inbound store retains injected asks until a reply is sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-intercom-ask-"));
  try {
    const path = join(dir, "inbound.json");
    const first = new DurableInboundStore(path);
    first.enqueue(entry("ask-1", true));
    first.markInjected("ask-1");
    const second = new DurableInboundStore(path);
    assert.deepEqual(second.pendingInjection(), []);
    assert.deepEqual(second.unresolvedAsks().map((item) => item.message.id), ["ask-1"]);
    second.markReplied("ask-1");
    const third = new DurableInboundStore(path);
    assert.deepEqual(third.unresolvedAsks(), []);
    assert.equal(third.enqueue(entry("ask-1", true)), "delivered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
