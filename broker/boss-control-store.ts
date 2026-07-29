import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseBossControlEnvelope,
  type BossControlEnvelope,
  type BossControlKind,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  canonicalJson,
  assertExactKeys,
  assertRecord,
  participantBindingEpoch,
  type ParticipantBindingEpoch,
} from "@dataforxyz/agent-intercom-core/canonical";
import { writeDurableJson } from "../durable-json.ts";
import { ensureIntercomRuntimeDir } from "./paths.ts";
import { bossControlKind } from "./boss.ts";
import type { DeliveryFailureCode } from "../types.ts";

const STATE_VERSION = 1;

export type BossControlTerminalFailureCode = Extract<
  DeliveryFailureCode,
  "BOSS_CONTROL_DENIED" | "RECIPIENT_DISCONNECTED" | "SENDER_DISCONNECTED" | "DELIVERY_TIMEOUT"
>;

export interface BossControlIdempotencyIdentity {
  senderSessionId: string;
  bossRunId: string;
  participantId: string;
  senderBindingEpoch: ParticipantBindingEpoch;
  idempotencyKey: string;
}

export interface DurableBossControlRecord extends BossControlIdempotencyIdentity {
  targetSessionId: string;
  targetBindingEpoch: ParticipantBindingEpoch;
  controlKind: BossControlKind;
  envelope: BossControlEnvelope;
  fingerprint: string;
  deliveryId: string;
  state: "accepted" | "delivered" | "rejected";
  acceptedAt: string;
  deliveredAt?: string;
  failureCode?: BossControlTerminalFailureCode;
  failureReason?: string;
  rejectedAt?: string;
}

export type BossControlAcceptedFrame = {
  type: "boss_control_accepted";
  messageId: string;
  deliveryId: string;
};

export type BossControlTerminalFrame =
  | {
    type: "boss_control_delivered";
    messageId: string;
    deliveryId: string;
  }
  | {
    type: "boss_control_failed";
    messageId: string;
    deliveryId: string;
    accepted: true;
    code: BossControlTerminalFailureCode;
    reason: string;
  };

interface BossControlState {
  version: typeof STATE_VERSION;
  records: Record<string, DurableBossControlRecord>;
}

const CONTROL_KINDS: readonly BossControlKind[] = [
  "assignment_request",
  "assignment_response",
  "health",
  "staffing",
  "review_request",
  "review_result",
  "proof",
  "lifecycle",
  "decision",
];

const TERMINAL_FAILURE_CODES: readonly BossControlTerminalFailureCode[] = [
  "BOSS_CONTROL_DENIED",
  "RECIPIENT_DISCONNECTED",
  "SENDER_DISCONNECTED",
  "DELIVERY_TIMEOUT",
];

function recordValue(value: unknown, path: string): Record<string, unknown> {
  assertRecord(value, path);
  return value;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  assertExactKeys(value, required, optional, path);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function timestampValue(value: unknown, path: string): string {
  const timestamp = stringValue(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${path} must be a timestamp`);
  return timestamp;
}

export function bossControlIdempotencyScope(identity: BossControlIdempotencyIdentity): string {
  return canonicalJson({
    senderSessionId: identity.senderSessionId,
    bossRunId: identity.bossRunId,
    participantId: identity.participantId,
    senderBindingEpoch: identity.senderBindingEpoch,
    idempotencyKey: identity.idempotencyKey,
  });
}

export function bossControlFingerprint(targetSessionId: string, envelope: BossControlEnvelope): string {
  return canonicalJson({
    targetSessionId,
    envelope: {
      type: envelope.type,
      version: envelope.version,
      bossRunId: envelope.bossRunId,
      participantId: envelope.participantId,
      bindingEpoch: envelope.bindingEpoch,
      ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
      ...(envelope.replyTo === undefined ? {} : { replyTo: envelope.replyTo }),
      idempotencyKey: envelope.idempotencyKey,
      payload: envelope.payload,
    },
  });
}

export function bossControlAcceptedFrame(
  record: DurableBossControlRecord,
  requestMessageId: string,
): BossControlAcceptedFrame {
  return {
    type: "boss_control_accepted",
    messageId: stringValue(requestMessageId, "$requestMessageId"),
    deliveryId: record.deliveryId,
  };
}

export function bossControlTerminalFrame(
  record: DurableBossControlRecord,
  requestMessageId: string,
): BossControlTerminalFrame {
  const messageId = stringValue(requestMessageId, "$requestMessageId");
  if (record.state === "delivered") {
    return { type: "boss_control_delivered", messageId, deliveryId: record.deliveryId };
  }
  if (record.state === "rejected") {
    return {
      type: "boss_control_failed",
      messageId,
      deliveryId: record.deliveryId,
      accepted: true,
      code: record.failureCode!,
      reason: record.failureReason!,
    };
  }
  throw new Error("Accepted Boss control has no terminal result");
}

export function bossControlReplayFrames(
  record: DurableBossControlRecord,
  requestMessageId: string,
): [BossControlAcceptedFrame] | [BossControlAcceptedFrame, BossControlTerminalFrame] {
  const accepted = bossControlAcceptedFrame(record, requestMessageId);
  return record.state === "accepted"
    ? [accepted]
    : [accepted, bossControlTerminalFrame(record, requestMessageId)];
}

function parseRecord(value: unknown, path: string): DurableBossControlRecord {
  const record = recordValue(value, path);
  exactKeys(record, [
    "senderSessionId",
    "bossRunId",
    "participantId",
    "senderBindingEpoch",
    "idempotencyKey",
    "targetSessionId",
    "targetBindingEpoch",
    "controlKind",
    "envelope",
    "fingerprint",
    "deliveryId",
    "state",
    "acceptedAt",
  ], ["deliveredAt", "failureCode", "failureReason", "rejectedAt"], path);

  const envelope = parseBossControlEnvelope(record.envelope);
  const senderSessionId = stringValue(record.senderSessionId, `${path}.senderSessionId`);
  const bossRunId = stringValue(record.bossRunId, `${path}.bossRunId`);
  const participantId = stringValue(record.participantId, `${path}.participantId`);
  const senderBindingEpoch = participantBindingEpoch(record.senderBindingEpoch, `${path}.senderBindingEpoch`);
  const idempotencyKey = stringValue(record.idempotencyKey, `${path}.idempotencyKey`);
  const targetSessionId = stringValue(record.targetSessionId, `${path}.targetSessionId`);
  const targetBindingEpoch = participantBindingEpoch(record.targetBindingEpoch, `${path}.targetBindingEpoch`);
  const controlKind = record.controlKind;
  if (!CONTROL_KINDS.includes(controlKind as BossControlKind)) throw new Error(`${path}.controlKind is invalid`);
  const fingerprint = stringValue(record.fingerprint, `${path}.fingerprint`);
  const deliveryId = stringValue(record.deliveryId, `${path}.deliveryId`);
  const acceptedAt = timestampValue(record.acceptedAt, `${path}.acceptedAt`);
  if (
    envelope.bossRunId !== bossRunId
    || envelope.participantId !== participantId
    || envelope.bindingEpoch !== senderBindingEpoch
    || envelope.idempotencyKey !== idempotencyKey
  ) {
    throw new Error(`${path} identity does not match its envelope`);
  }
  if (controlKind !== bossControlKind(envelope.type)) throw new Error(`${path}.controlKind does not match its envelope type`);
  if (fingerprint !== bossControlFingerprint(targetSessionId, envelope)) {
    throw new Error(`${path}.fingerprint does not match its canonical target and envelope`);
  }

  const state = record.state;
  if (state !== "accepted" && state !== "delivered" && state !== "rejected") throw new Error(`${path}.state is invalid`);
  const deliveredAt = record.deliveredAt === undefined ? undefined : timestampValue(record.deliveredAt, `${path}.deliveredAt`);
  const failureCode = record.failureCode as BossControlTerminalFailureCode | undefined;
  const failureReason = record.failureReason === undefined ? undefined : stringValue(record.failureReason, `${path}.failureReason`);
  const rejectedAt = record.rejectedAt === undefined ? undefined : timestampValue(record.rejectedAt, `${path}.rejectedAt`);
  if (state === "accepted" && (deliveredAt !== undefined || failureCode !== undefined || failureReason !== undefined || rejectedAt !== undefined)) {
    throw new Error(`${path} accepted record contains terminal evidence`);
  }
  if (state === "delivered" && (deliveredAt === undefined || failureCode !== undefined || failureReason !== undefined || rejectedAt !== undefined)) {
    throw new Error(`${path} delivered record has invalid terminal evidence`);
  }
  if (
    state === "rejected"
    && (
      failureCode === undefined
      || !TERMINAL_FAILURE_CODES.includes(failureCode)
      || failureReason === undefined
      || rejectedAt === undefined
      || deliveredAt !== undefined
    )
  ) {
    throw new Error(`${path} rejected record has invalid terminal evidence`);
  }
  if (deliveredAt !== undefined && Date.parse(deliveredAt) < Date.parse(acceptedAt)) {
    throw new Error(`${path}.deliveredAt precedes acceptance`);
  }
  if (rejectedAt !== undefined && Date.parse(rejectedAt) < Date.parse(acceptedAt)) {
    throw new Error(`${path}.rejectedAt precedes acceptance`);
  }

  return {
    senderSessionId,
    bossRunId,
    participantId,
    senderBindingEpoch,
    idempotencyKey,
    targetSessionId,
    targetBindingEpoch,
    controlKind: controlKind as BossControlKind,
    envelope,
    fingerprint,
    deliveryId,
    state,
    acceptedAt,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(rejectedAt === undefined ? {} : { rejectedAt }),
  };
}

function parseState(value: unknown): BossControlState {
  const state = recordValue(value, "$bossControls");
  exactKeys(state, ["version", "records"], [], "$bossControls");
  if (state.version !== STATE_VERSION) throw new Error("Unsupported Boss control state version");
  const recordsValue = recordValue(state.records, "$bossControls.records");
  const records: Record<string, DurableBossControlRecord> = {};
  for (const [scope, value] of Object.entries(recordsValue)) {
    const record = parseRecord(value, `$bossControls.records[${JSON.stringify(scope)}]`);
    if (scope !== bossControlIdempotencyScope(record)) throw new Error("Boss control scope key does not match its record");
    records[scope] = record;
  }
  return { version: STATE_VERSION, records };
}

function clone(record: DurableBossControlRecord): DurableBossControlRecord {
  return structuredClone(record);
}

export class DurableBossControlStore {
  private state: BossControlState;
  private readonly persist: (path: string, state: BossControlState) => void;
  private poisoned: Error | undefined;

  constructor(
    readonly path: string,
    persist: (path: string, state: BossControlState) => void = writeDurableJson,
  ) {
    ensureIntercomRuntimeDir(dirname(path));
    this.persist = persist;
    this.state = this.load();
  }

  get(identity: BossControlIdempotencyIdentity): DurableBossControlRecord | undefined {
    this.assertUsable();
    const record = this.state.records[bossControlIdempotencyScope(identity)];
    return record === undefined ? undefined : clone(record);
  }

  reserve(recordValue: DurableBossControlRecord): { created: boolean; record: DurableBossControlRecord } {
    this.assertUsable();
    const record = parseRecord(recordValue, "$record");
    if (record.state !== "accepted") throw new Error("A Boss control reservation must start accepted");
    const scope = bossControlIdempotencyScope(record);
    const existing = this.state.records[scope];
    if (existing) {
      if (
        existing.fingerprint !== record.fingerprint
        || existing.targetBindingEpoch !== record.targetBindingEpoch
        || existing.controlKind !== record.controlKind
      ) {
        throw new Error("Conflicting Boss control idempotency replay");
      }
      return { created: false, record: clone(existing) };
    }
    const next = structuredClone(this.state);
    next.records[scope] = record;
    this.commit(next);
    return { created: true, record: clone(record) };
  }

  markDelivered(identity: BossControlIdempotencyIdentity, deliveryId: string, deliveredAt = new Date().toISOString()): DurableBossControlRecord {
    this.assertUsable();
    const scope = bossControlIdempotencyScope(identity);
    const record = this.state.records[scope];
    if (!record || record.deliveryId !== deliveryId) throw new Error("Boss control delivery does not match its durable acceptance");
    if (record.state === "rejected") throw new Error("A rejected Boss control cannot become delivered");
    if (record.state === "delivered") return clone(record);
    const updated: DurableBossControlRecord = {
      ...record,
      state: "delivered",
      deliveredAt: timestampValue(deliveredAt, "$deliveredAt"),
    };
    parseRecord(updated, "$record");
    const next = structuredClone(this.state);
    next.records[scope] = updated;
    this.commit(next);
    return clone(updated);
  }

  markRejected(
    identity: BossControlIdempotencyIdentity,
    deliveryId: string,
    failureCode: BossControlTerminalFailureCode,
    failureReason: string,
    rejectedAt = new Date().toISOString(),
  ): DurableBossControlRecord {
    this.assertUsable();
    const scope = bossControlIdempotencyScope(identity);
    const record = this.state.records[scope];
    if (!record || record.deliveryId !== deliveryId) throw new Error("Boss control failure does not match its durable acceptance");
    if (record.state === "delivered") throw new Error("A delivered Boss control cannot become rejected");
    if (record.state === "rejected") {
      if (record.failureCode !== failureCode || record.failureReason !== failureReason) {
        throw new Error("Conflicting terminal Boss control failure");
      }
      return clone(record);
    }
    const updated: DurableBossControlRecord = {
      ...record,
      state: "rejected",
      failureCode,
      failureReason: stringValue(failureReason, "$failureReason"),
      rejectedAt: timestampValue(rejectedAt, "$rejectedAt"),
    };
    parseRecord(updated, "$record");
    const next = structuredClone(this.state);
    next.records[scope] = updated;
    this.commit(next);
    return clone(updated);
  }

  private load(): BossControlState {
    if (!existsSync(this.path)) return { version: STATE_VERSION, records: {} };
    return parseState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  private loadExactTarget(): BossControlState {
    if (!existsSync(this.path)) throw new Error("Durable Boss control target is missing");
    return parseState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  private commit(next: BossControlState): void {
    const stagedCanonical = canonicalJson(parseState(structuredClone(next)));
    const priorCanonical = canonicalJson(this.state);
    try {
      this.persist(this.path, parseState(JSON.parse(stagedCanonical)));
    } catch (persistError) {
      try {
        const recovered = this.loadExactTarget();
        const recoveredCanonical = canonicalJson(recovered);
        if (recoveredCanonical === stagedCanonical) {
          this.state = parseState(JSON.parse(stagedCanonical));
        } else if (recoveredCanonical === priorCanonical) {
          this.state = parseState(JSON.parse(priorCanonical));
        } else {
          throw new Error("Durable Boss control state does not match the prior or staged commit");
        }
      } catch (reconcileError) {
        this.poisoned = new Error("Durable Boss control store is unavailable after commit reconciliation failed", {
          cause: reconcileError,
        });
      }
      throw persistError;
    }
    this.state = parseState(JSON.parse(stagedCanonical));
  }

  private assertUsable(): void {
    if (this.poisoned) throw this.poisoned;
  }
}
