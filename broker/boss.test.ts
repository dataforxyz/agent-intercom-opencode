import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE_CONTRACT,
} from "@dataforxyz/agent-intercom-core/boss";
import { brokerGeneration, participantBindingEpoch } from "@dataforxyz/agent-intercom-core/canonical";
import { bossControlKind, parseBoundBossControl, parseBossSessionMetadata } from "./boss.ts";
import type { SessionInfo } from "../types.ts";

function worker(): SessionInfo {
  const bindingEpoch = participantBindingEpoch(2);
  return {
    id: "worker-session",
    cwd: "/repo",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    boss: {
      registration: {
        principalId: "worker-session",
        principalClass: "boss-bound",
        state: "active",
        bossRunId: "run-a",
        participantId: "worker-a",
        bindingEpoch,
        featureContract: BOSS_RUN_FEATURE_CONTRACT,
        policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
        capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
        brokerIdentityVerified: true,
      },
      principal: {
        version: BOSS_POLICY_PRINCIPAL_VERSION,
        principalId: "worker-session",
        principalClass: "boss-private",
        state: "active",
        bossRunId: "run-a",
        participantId: "worker-a",
        role: "worker",
        bindingEpoch,
        assignedManagerParticipantId: "manager-a",
      },
      binding: {
        version: BOSS_PARTICIPANT_BINDING_VERSION,
        bossRunId: "run-a",
        participantId: "worker-a",
        role: "worker",
        communicationProfile: "worker",
        bindingEpoch,
        sessionId: "worker-session",
        brokerGeneration: brokerGeneration(3),
        brokerBootInstance: "boot-a",
        state: "active",
        assignedManagerParticipantId: "manager-a",
        authorityTransitionId: "transition-a",
      },
    },
  };
}

test("broker-owned Boss participant and binding metadata must agree exactly", () => {
  const session = worker();
  assert.deepEqual(parseBossSessionMetadata(session.boss, session.id), session.boss);
  assert.throws(
    () => parseBossSessionMetadata({ ...session.boss, registration: { ...session.boss!.registration, bossRunId: "run-b" } }, session.id),
    /identity bindings must exactly match/,
  );
});

test("typed controls preserve stable envelope correlation and sender binding", () => {
  const envelope = {
    type: "boss.assignment.submitted" as const,
    version: 1 as const,
    messageId: "message-1",
    bossRunId: "run-a",
    participantId: "worker-a",
    bindingEpoch: participantBindingEpoch(2),
    causationId: "assignment-1",
    replyTo: "message-0",
    idempotencyKey: "assignment-1:submission:1",
    payload: { assignmentId: "assignment-1", outcome: "complete" },
  };
  assert.deepEqual(parseBoundBossControl(envelope, worker()), envelope);
  assert.equal(bossControlKind(envelope.type), "assignment_response");
  assert.throws(() => parseBoundBossControl({ ...envelope, bossRunId: "run-b" }, worker()), /must match the sender/);
});
