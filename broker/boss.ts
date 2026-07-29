import {
  BOSS_CONTROL_TYPES,
  parseBossControlEnvelope,
  parseBossParticipantBinding,
  parseBossPolicyPrincipal,
  parseFeatureRegistration,
  type BossControlEnvelope,
  type BossControlKind,
  type BossControlType,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  ContractValidationError,
  assertExactKeys,
  assertRecord,
} from "@dataforxyz/agent-intercom-core/canonical";
import type { BossSessionMetadata, SessionInfo } from "../types.ts";

const CONTROL_KIND_BY_TYPE = {
  "boss.assignment.created": "assignment_request",
  "boss.assignment.accepted": "assignment_response",
  "boss.assignment.checkpoint": "assignment_response",
  "boss.assignment.submitted": "assignment_response",
  "boss.assignment.rejected": "assignment_response",
  "boss.assignment.cancelled": "lifecycle",
  "boss.staffing.requested": "staffing",
  "boss.staffing.resolved": "staffing",
  "boss.review.requested": "review_request",
  "boss.review.submitted": "review_result",
  "boss.council.requested": "review_request",
  "boss.council.submitted": "review_result",
  "boss.proof.submitted": "proof",
  "boss.worker.health": "health",
  "boss.worker.blocked": "health",
  "boss.worker.failed": "health",
  "boss.worker.notice": "lifecycle",
  "boss.worker.notice_delivery_failed": "lifecycle",
  "boss.decision.required": "decision",
} as const satisfies Record<BossControlType, BossControlKind>;

if (Object.keys(CONTROL_KIND_BY_TYPE).length !== BOSS_CONTROL_TYPES.length) {
  throw new Error("Boss control type mapping is incomplete");
}

export function bossControlKind(type: BossControlType): BossControlKind {
  return CONTROL_KIND_BY_TYPE[type];
}

export function parseBossSessionMetadata(value: unknown, sessionId: string): BossSessionMetadata {
  assertRecord(value, "$.boss");
  assertExactKeys(value, ["registration", "principal"], ["binding"], "$.boss");
  const metadata = value;
  const registration = parseFeatureRegistration(metadata.registration);
  const principal = parseBossPolicyPrincipal(metadata.principal);
  if (registration.principalClass !== "boss-bound" || principal.principalClass !== "boss-private") {
    throw new ContractValidationError("$.boss", "must contain Boss-bound registration and private principal metadata");
  }
  if (
    registration.principalId !== sessionId
    || principal.principalId !== sessionId
    || registration.bossRunId !== principal.bossRunId
    || registration.participantId !== principal.participantId
    || registration.bindingEpoch !== principal.bindingEpoch
  ) {
    throw new ContractValidationError("$.boss", "registration and principal identity bindings must exactly match the session");
  }

  const binding = metadata.binding === undefined ? undefined : parseBossParticipantBinding(metadata.binding);
  if (principal.role === "controller") {
    if (binding !== undefined) throw new ContractValidationError("$.boss.binding", "is forbidden for Controller principals");
  } else {
    if (binding === undefined) throw new ContractValidationError("$.boss.binding", "is required for Boss participants");
    if (
      binding.sessionId !== sessionId
      || binding.bossRunId !== principal.bossRunId
      || binding.participantId !== principal.participantId
      || binding.role !== principal.role
      || binding.bindingEpoch !== principal.bindingEpoch
      || binding.state !== principal.state
      || binding.assignedManagerParticipantId !== principal.assignedManagerParticipantId
    ) {
      throw new ContractValidationError("$.boss.binding", "must exactly match the authenticated session principal");
    }
  }
  return { registration, principal, ...(binding === undefined ? {} : { binding }) };
}

export function validatedBossMetadata(session: SessionInfo): BossSessionMetadata | undefined {
  if (session.boss === undefined) return undefined;
  return parseBossSessionMetadata(session.boss, session.id);
}

export function parseBoundBossControl(value: unknown, sender: SessionInfo): BossControlEnvelope {
  const envelope = parseBossControlEnvelope(value);
  const boss = validatedBossMetadata(sender);
  if (!boss) throw new ContractValidationError("$.envelope", "sender is not an authenticated Boss participant");
  if (
    envelope.bossRunId !== boss.principal.bossRunId
    || envelope.participantId !== boss.principal.participantId
    || envelope.bindingEpoch !== boss.principal.bindingEpoch
  ) {
    throw new ContractValidationError("$.envelope", "run, participant, and binding epoch must match the sender");
  }
  return envelope;
}
