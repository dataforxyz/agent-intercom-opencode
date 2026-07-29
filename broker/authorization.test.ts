import assert from "node:assert/strict";
import test from "node:test";
import { authorizeSessionAction, visibleSessions } from "./authorization.ts";
import type { SessionInfo } from "../types.ts";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE_CONTRACT,
  type BossPolicyRole,
} from "@dataforxyz/agent-intercom-core/boss";
import { brokerGeneration, participantBindingEpoch } from "@dataforxyz/agent-intercom-core/canonical";

function local(id: string): SessionInfo {
  return { id, name: id, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, origin: "local" };
}

function remote(id: string, parentSessionId: string, rootSessionId = "root"): SessionInfo {
  return {
    id,
    name: id,
    cwd: "/tmp",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
    origin: "remote",
    remoteHostId: "ika",
    parentSessionId,
    rootSessionId,
    generation: 1,
  };
}

const sessions = [
  local("root"),
  local("unrelated"),
  remote("manager", "root"),
  remote("child-a", "manager"),
  remote("child-b", "manager"),
];

function bossSession(
  id: string,
  role: BossPolicyRole,
  bossRunId: string,
  options: { managerId?: string; assignedIds?: string[] } = {},
): SessionInfo {
  const bindingEpoch = participantBindingEpoch(1);
  const participantId = `participant-${id}`;
  const assignedManagerParticipantId = options.managerId === undefined ? undefined : `participant-${options.managerId}`;
  const assignedParticipantIds = options.assignedIds?.map((assignedId) => `participant-${assignedId}`);
  const principal = {
    version: BOSS_POLICY_PRINCIPAL_VERSION,
    principalId: id,
    principalClass: "boss-private" as const,
    state: "active" as const,
    bossRunId,
    participantId,
    role,
    bindingEpoch,
    ...(assignedManagerParticipantId === undefined ? {} : { assignedManagerParticipantId }),
    ...(assignedParticipantIds === undefined ? {} : { assignedParticipantIds }),
  };
  const binding = role === "controller" ? undefined : {
    version: BOSS_PARTICIPANT_BINDING_VERSION,
    bossRunId,
    participantId,
    role,
    communicationProfile: role,
    bindingEpoch,
    sessionId: id,
    brokerGeneration: brokerGeneration(1),
    brokerBootInstance: "boot-1",
    state: "active" as const,
    ...(assignedManagerParticipantId === undefined ? {} : { assignedManagerParticipantId }),
    authorityTransitionId: `transition-${id}`,
  };
  return {
    id,
    name: id,
    cwd: "/tmp",
    model: "test",
    pid: 3,
    startedAt: 1,
    lastActivity: 1,
    origin: "local",
    boss: {
      registration: {
        principalId: id,
        principalClass: "boss-bound",
        state: "active",
        bossRunId,
        participantId,
        bindingEpoch,
        featureContract: BOSS_RUN_FEATURE_CONTRACT,
        policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
        capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
        brokerIdentityVerified: true,
      },
      principal,
      ...(binding === undefined ? {} : { binding }),
    },
  };
}

test("phase one discovery and communication use the same ancestor-chain policy", () => {
  assert.equal(authorizeSessionAction(sessions, "root", "send", "manager").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "manager", "ask", "root").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "manager", "send", "child-a").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "reply", "manager").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "send", "root").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "discover", "child-b").allowed, false);
  assert.equal(authorizeSessionAction(sessions, "unrelated", "discover", "manager").allowed, false);
});

test("visibility hides unauthorized sessions rather than revealing denial details", () => {
  assert.deepEqual(visibleSessions(sessions, "child-a").map((session) => session.id).sort(), ["child-a", "manager", "root"]);
  assert.deepEqual(visibleSessions(sessions, "root").map((session) => session.id).sort(), ["child-a", "child-b", "manager", "root", "unrelated"]);
  assert.deepEqual(visibleSessions(sessions, "unrelated").map((session) => session.id).sort(), ["root", "unrelated"]);
});

test("Boss discovery is run-scoped and never downgrades into ordinary local-public routing", () => {
  const mixed = [
    local("ordinary"),
    bossSession("manager-a", "manager", "run-a", { assignedIds: ["worker-a"] }),
    bossSession("worker-a", "worker", "run-a", { managerId: "manager-a" }),
    bossSession("manager-b", "manager", "run-b", { assignedIds: [] }),
  ];

  assert.deepEqual(authorizeSessionAction(mixed, "manager-a", "discover", "worker-a"), {
    allowed: true,
    reason: "communication-profile",
  });
  assert.deepEqual(authorizeSessionAction(mixed, "manager-a", "send", "manager-b"), {
    allowed: false,
    code: "CROSS_RUN_DENIED",
  });
  assert.deepEqual(authorizeSessionAction(mixed, "ordinary", "send", "manager-a"), {
    allowed: false,
    code: "FEATURE_CLASS_DENIED",
  });
  assert.deepEqual(visibleSessions(mixed, "manager-a").map((session) => session.id).sort(), ["manager-a", "worker-a"]);
});

test("Boss typed control uses the directional Core matrix and exact binding epochs", () => {
  const run = [
    bossSession("manager", "manager", "run-a", { assignedIds: ["worker"] }),
    bossSession("worker", "worker", "run-a", { managerId: "manager" }),
  ];
  assert.deepEqual(authorizeSessionAction(run, "manager", "control", "worker", {
    actorBindingEpoch: participantBindingEpoch(1),
    targetBindingEpoch: participantBindingEpoch(1),
    controlKind: "assignment_request",
    correlated: true,
  }), { allowed: true, reason: "structured-control" });
  assert.deepEqual(authorizeSessionAction(run, "manager", "control", "worker", {
    actorBindingEpoch: participantBindingEpoch(1),
    targetBindingEpoch: participantBindingEpoch(1),
    controlKind: "decision",
    correlated: true,
  }), { allowed: false, code: "CONTROL_KIND_DENIED" });
  assert.deepEqual(authorizeSessionAction(run, "manager", "control", "worker", {
    actorBindingEpoch: participantBindingEpoch(1),
    targetBindingEpoch: participantBindingEpoch(1),
    controlKind: "assignment_request",
    correlated: false,
  }), { allowed: false, code: "CONTROL_REQUIRES_CORRELATION" });
});

test("invalid Boss metadata fails closed instead of becoming an ordinary session", () => {
  const corrupt = bossSession("worker", "worker", "run-a", { managerId: "manager" });
  corrupt.boss!.registration.brokerIdentityVerified = false;
  const manager = bossSession("manager", "manager", "run-a", { assignedIds: ["worker"] });
  assert.equal(authorizeSessionAction([manager, corrupt], "manager", "discover", "worker").allowed, false);
});
