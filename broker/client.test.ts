import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE_CONTRACT,
} from "@dataforxyz/agent-intercom-core/boss";
import { brokerGeneration, participantBindingEpoch } from "@dataforxyz/agent-intercom-core/canonical";
import type { SessionInfo } from "../types.ts";

function bossSender(role: "manager" | "worker" = "worker"): SessionInfo {
  const bindingEpoch = participantBindingEpoch(2);
  const participantId = `${role}-a`;
  const sessionId = `${role}-session`;
  const worker = role === "worker";
  return {
    id: sessionId,
    name: sessionId,
    cwd: "/repo",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    origin: "local",
    boss: {
      registration: {
        principalId: sessionId,
        principalClass: "boss-bound",
        state: "active",
        bossRunId: "run-a",
        participantId,
        bindingEpoch,
        featureContract: BOSS_RUN_FEATURE_CONTRACT,
        policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
        capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
        brokerIdentityVerified: true,
      },
      principal: {
        version: BOSS_POLICY_PRINCIPAL_VERSION,
        principalId: sessionId,
        principalClass: "boss-private",
        state: "active",
        bossRunId: "run-a",
        participantId,
        role,
        bindingEpoch,
        ...(worker
          ? { assignedManagerParticipantId: "manager-a" }
          : { assignedParticipantIds: ["worker-a"] }),
      },
      binding: {
        version: BOSS_PARTICIPANT_BINDING_VERSION,
        bossRunId: "run-a",
        participantId,
        role,
        communicationProfile: role,
        bindingEpoch,
        sessionId,
        brokerGeneration: brokerGeneration(3),
        brokerBootInstance: "boot-a",
        state: "active",
        ...(worker ? { assignedManagerParticipantId: "manager-a" } : {}),
        authorityTransitionId: "transition-a",
      },
    },
  };
}

function workerControlEnvelope() {
  return {
    type: "boss.assignment.submitted" as const,
    version: 1 as const,
    messageId: "control-delivery-1",
    bossRunId: "run-a",
    participantId: "worker-a",
    bindingEpoch: participantBindingEpoch(2),
    idempotencyKey: "assignment-a:submission:delivery",
    payload: { assignmentId: "assignment-a" },
  };
}

test("cancelAsk resolves false after synchronous socket write failures", async () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.equal(await client.cancelAsk("ask-1"), false);
});

test("Boss typed control uses a distinct broker frame and stable message correlation", async () => {
  const frames: Buffer[] = [];
  const client = new IntercomClient();
  (client as any)._sessionId = "worker-session";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(frame: Buffer) {
      frames.push(frame);
      return true;
    },
  };
  const envelope = {
    type: "boss.assignment.submitted" as const,
    version: 1 as const,
    messageId: "control-message-1",
    bossRunId: "run-a",
    participantId: "worker-a",
    bindingEpoch: participantBindingEpoch(1),
    causationId: "assignment-a",
    replyTo: "control-message-0",
    idempotencyKey: "assignment-a:submission:1",
    payload: { assignmentId: "assignment-a" },
  };
  const pending = client.sendBossControl("manager-session", envelope);
  const written = JSON.parse(frames[0]!.subarray(4).toString("utf8"));
  assert.deepEqual(written, { type: "boss_control_send", to: "manager-session", envelope });
  assert.notEqual(written.type, "send");

  (client as any).handleBrokerMessage({
    type: "boss_control_accepted",
    messageId: envelope.messageId,
    deliveryId: "delivery-1",
  });
  (client as any).handleBrokerMessage({
    type: "boss_control_delivered",
    messageId: envelope.messageId,
    deliveryId: "delivery-1",
  });
  assert.deepEqual(await pending, {
    id: envelope.messageId,
    accepted: true,
    delivered: true,
    deliveryId: "delivery-1",
  });
});

test("Boss control delivery requires accepted-to-delivered correlation on one delivery ID", async () => {
  const frames: Buffer[] = [];
  const client = new IntercomClient();
  (client as any)._sessionId = "worker-session";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(frame: Buffer) {
      frames.push(frame);
      return true;
    },
  };
  const envelope = {
    type: "boss.assignment.submitted" as const,
    version: 1 as const,
    messageId: "control-state-machine",
    bossRunId: "run-a",
    participantId: "worker-a",
    bindingEpoch: participantBindingEpoch(1),
    idempotencyKey: "assignment-a:submission:state-machine",
    payload: { assignmentId: "assignment-a" },
  };
  const pending = client.sendBossControl("manager-session", envelope);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_delivered",
    messageId: envelope.messageId,
    deliveryId: "delivery-a",
  }), /did not follow matching acceptance/);
  (client as any).handleBrokerMessage({
    type: "boss_control_accepted",
    messageId: envelope.messageId,
    deliveryId: "delivery-a",
  });
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_accepted",
    messageId: envelope.messageId,
    deliveryId: "delivery-a",
  }), /Duplicate Boss control acceptance/);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_delivered",
    messageId: envelope.messageId,
    deliveryId: "delivery-b",
  }), /did not follow matching acceptance/);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_delivered",
    messageId: envelope.messageId,
    deliveryId: "delivery-a",
    accepted: true,
  }), /not supported/);
  (client as any).handleBrokerMessage({
    type: "boss_control_delivered",
    messageId: envelope.messageId,
    deliveryId: "delivery-a",
  });
  assert.equal((await pending).deliveryId, "delivery-a");
});

test("Boss control failures have exact pre/post-acceptance shapes and delivery correlation", async () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "worker-session";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      return true;
    },
  };
  const base = {
    type: "boss.assignment.submitted" as const,
    version: 1 as const,
    bossRunId: "run-a",
    participantId: "worker-a",
    bindingEpoch: participantBindingEpoch(1),
    payload: { assignmentId: "assignment-a" },
  };

  const preEnvelope = {
    ...base,
    messageId: "control-pre-failure",
    idempotencyKey: "assignment-a:pre-failure",
  };
  const pre = client.sendBossControl("manager-session", preEnvelope);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: preEnvelope.messageId,
    deliveryId: "contradictory-delivery",
    accepted: false,
    code: "SESSION_NOT_FOUND",
    reason: "missing",
  }), /not supported/);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: preEnvelope.messageId,
    accepted: false,
    code: "UNKNOWN_FAILURE",
    reason: "unknown",
  }), /Invalid boss_control_failed message/);
  (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: preEnvelope.messageId,
    accepted: false,
    code: "SESSION_NOT_FOUND",
    reason: "missing",
  });
  assert.deepEqual(await pre, {
    id: preEnvelope.messageId,
    accepted: false,
    delivered: false,
    code: "SESSION_NOT_FOUND",
    reason: "missing",
  });

  const postEnvelope = {
    ...base,
    messageId: "control-post-failure",
    idempotencyKey: "assignment-a:post-failure",
  };
  const post = client.sendBossControl("manager-session", postEnvelope);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: postEnvelope.messageId,
    deliveryId: "delivery-a",
    accepted: true,
    code: "DELIVERY_TIMEOUT",
    reason: "timeout",
  }), /acceptance state is inconsistent/);
  (client as any).handleBrokerMessage({
    type: "boss_control_accepted",
    messageId: postEnvelope.messageId,
    deliveryId: "delivery-a",
  });
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: postEnvelope.messageId,
    deliveryId: "delivery-b",
    accepted: true,
    code: "DELIVERY_TIMEOUT",
    reason: "timeout",
  }), /did not follow matching acceptance/);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: postEnvelope.messageId,
    accepted: true,
    code: "DELIVERY_TIMEOUT",
    reason: "timeout",
  }), /deliveryId.*not supported|deliveryId/);
  (client as any).handleBrokerMessage({
    type: "boss_control_failed",
    messageId: postEnvelope.messageId,
    deliveryId: "delivery-a",
    accepted: true,
    code: "DELIVERY_TIMEOUT",
    reason: "timeout",
  });
  assert.deepEqual(await post, {
    id: postEnvelope.messageId,
    accepted: true,
    delivered: false,
    deliveryId: "delivery-a",
    code: "DELIVERY_TIMEOUT",
    reason: "timeout",
  });
});

test("ordinary client rejects Boss session metadata and feature-shaped registration responses", () => {
  const client = new IntercomClient();
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "registered",
    sessionId: "ordinary-session",
    protocol: "pi-intercom",
    version: 3,
    capabilities: { baseProtocolVersion: 3, features: [] },
  }), /must not contain feature or Boss metadata/);

  (client as any)._sessionId = "ordinary-session";
  (client as any).pendingLists.set("list-a", { resolve() {}, reject() {} });
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "sessions",
    requestId: "list-a",
    sessions: [{
      id: "boss-shaped",
      cwd: "/repo",
      model: "test",
      pid: 1,
      startedAt: 1,
      lastActivity: 1,
      boss: {},
    }],
  }), /Invalid sessions message/);
});

test("broker-delivered Boss control accepts exact authoritative sender metadata", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "manager-session";
  const sender = bossSender();
  const envelope = workerControlEnvelope();
  let received: unknown[] | undefined;
  client.once("boss_control", (...args) => {
    received = args;
  });

  (client as any).handleBrokerMessage({
    type: "boss_control",
    deliveryId: "delivery-1",
    from: sender,
    envelope,
  });

  assert.deepEqual(received, [sender, envelope, "delivery-1"]);
  assert.notStrictEqual(received![0], sender);
});

test("Boss control rejects ordinary, stale, substituted, and envelope-mismatched senders", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "manager-session";
  const envelope = workerControlEnvelope();
  const ordinary = {
    id: "ordinary-session",
    cwd: "/repo",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
  const stale = structuredClone(bossSender());
  stale.boss!.registration.state = "revoked";
  const substituted = structuredClone(bossSender());
  substituted.boss!.binding!.sessionId = "replacement-session";

  for (const from of [ordinary, stale, substituted]) {
    assert.throws(() => (client as any).handleBrokerMessage({
      type: "boss_control",
      deliveryId: "delivery-1",
      from,
      envelope,
    }), /Invalid boss_control event/);
  }

  assert.throws(() => (client as any).handleBrokerMessage({
    type: "boss_control",
    deliveryId: "delivery-1",
    from: bossSender(),
    envelope: { ...envelope, participantId: "substituted-worker" },
  }), /must match the sender/);
});

test("Boss control rejects proxy, inherited, accessor, extra, and sparse sender shapes", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "manager-session";
  const envelope = workerControlEnvelope();
  const deliver = (from: unknown) => (client as any).handleBrokerMessage({
    type: "boss_control",
    deliveryId: "delivery-1",
    from,
    envelope,
  });

  let proxyTraps = 0;
  const proxied = new Proxy(bossSender(), {
    get() {
      proxyTraps += 1;
      throw new Error("proxy get trap must not run");
    },
    ownKeys() {
      proxyTraps += 1;
      throw new Error("proxy ownKeys trap must not run");
    },
  });
  assert.throws(() => deliver(proxied), /Invalid boss_control event/);
  assert.equal(proxyTraps, 0);

  const nestedProxy = bossSender();
  nestedProxy.boss = new Proxy(nestedProxy.boss!, {
    ownKeys() {
      proxyTraps += 1;
      throw new Error("nested proxy ownKeys trap must not run");
    },
  });
  assert.throws(() => deliver(nestedProxy), /Invalid boss_control event/);
  assert.equal(proxyTraps, 0);

  assert.throws(() => deliver(Object.create(bossSender())), /Invalid boss_control event/);
  const inheritedBoss = bossSender();
  inheritedBoss.boss = Object.create(inheritedBoss.boss!);
  assert.throws(() => deliver(inheritedBoss), /Invalid boss_control event/);

  let accessorReads = 0;
  const accessor = bossSender();
  Object.defineProperty(accessor.boss!.registration, "bossRunId", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "run-a";
    },
  });
  assert.throws(() => deliver(accessor), /Invalid boss_control event/);
  assert.equal(accessorReads, 0);

  assert.throws(() => deliver({ ...bossSender(), unexpectedAuthority: true }), /Invalid boss_control event/);
  const extraBossField = bossSender();
  (extraBossField.boss as any).unexpectedAuthority = true;
  assert.throws(() => deliver(extraBossField), /Invalid boss_control event/);

  const sparse = bossSender("manager");
  sparse.boss!.principal.assignedParticipantIds = new Array(1);
  assert.throws(() => deliver(sparse), /Invalid boss_control event/);
});
