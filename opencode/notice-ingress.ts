import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseDeliveryClaimRecord,
  parseNoticeRecipientIngressEnvelope,
  parseTargetLedgerLookupResult,
  type DeliveryClaimRecord,
  type NoticeRecipientIngressEnvelope,
  type TargetLedgerLookupResult,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  canonicalJson,
  assertExactKeys,
  assertRecord,
  type DeliveryClaimGeneration,
} from "@dataforxyz/agent-intercom-core/canonical";
import { ensureIntercomRuntimeDir, getIntercomDirPath } from "../broker/paths.ts";
import { writeDurableJson } from "../durable-json.ts";

export type OpenCodeNoticeIngressPhase = "reserved" | "inserting" | "inserted" | "receipting" | "delivered";

export interface OpenCodeNoticeIngressRecord {
  reserve: NoticeRecipientIngressEnvelope;
  claim: DeliveryClaimRecord;
  phase: OpenCodeNoticeIngressPhase;
  insertion?: NoticeRecipientIngressEnvelope;
  targetLedgerEntryId?: string;
  insertedAt?: string;
  receipt?: NoticeRecipientIngressEnvelope;
  deliveredClaim?: DeliveryClaimRecord;
}

interface OpenCodeNoticeIngressState {
  version: 1;
  records: Record<string, OpenCodeNoticeIngressRecord>;
}

export interface OpenCodeNoticeInsertionReceipt {
  deliveryClaimId: string;
  claimGeneration: DeliveryClaimGeneration;
  targetLedgerEntryId: string;
  insertedAt: string;
}

export const OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION = "opencode.notice-atomic-insertion.v1" as const;
/** @deprecated Preliminary current-claim evidence does not fence insertion. */
export const OPENCODE_NOTICE_CURRENT_CLAIM_EVIDENCE_VERSION = "opencode.notice-current-claim-evidence.v1" as const;

export interface OpenCodeNoticeAtomicInsertionRequest {
  version: typeof OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION;
  requestNonce: string;
  requestedAt: string;
  claim: DeliveryClaimRecord;
  insertion: NoticeRecipientIngressEnvelope;
}

export interface OpenCodeNoticeAtomicInsertionResult {
  version: typeof OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION;
  requestNonce: string;
  status: "inserted" | "revoked" | "superseded" | "expired";
  claim?: DeliveryClaimRecord;
  receipt?: OpenCodeNoticeInsertionReceipt;
}

export type OpenCodeNoticeProtectedInsertion = () => Promise<OpenCodeNoticeInsertionReceipt>;

/**
 * This boundary must be backed by the authenticated Orc/Controller authority
 * channel. The ordinary Intercom broker is not an implementation of it.
 */
export interface AuthenticatedOpenCodeNoticeAuthority {
  reserveDelivery(envelope: NoticeRecipientIngressEnvelope): Promise<unknown>;
  /**
   * This method may only be exposed by an authenticated authority that keeps
   * the exact claim current and its deadline open atomically across the
   * protected insertion callback and the target-ledger commit. A preliminary
   * lookup, an AbortSignal, or a caller-supplied timestamp is not an
   * implementation of this operation.
   */
  insertOrAttachWhileClaimCurrent?(
    request: OpenCodeNoticeAtomicInsertionRequest,
    insertion: OpenCodeNoticeProtectedInsertion,
  ): Promise<unknown>;
  lookupTargetLedger(envelope: NoticeRecipientIngressEnvelope): Promise<unknown>;
  recordReceipt(envelope: NoticeRecipientIngressEnvelope): Promise<unknown>;
}

export const OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE = "OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE" as const;
export const OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE = "OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE" as const;
export const INSERTION_FENCING_UNAVAILABLE = "INSERTION_FENCING_UNAVAILABLE" as const;

export class OpenCodeNoticeAuthorityUnavailableError extends Error {
  readonly code = OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE;

  constructor() {
    super("OpenCode Boss notice ingress is unavailable until an authenticated Orc/Controller authority client and typed notice-to-prompt entrypoint are provided");
    this.name = "OpenCodeNoticeAuthorityUnavailableError";
  }
}

export class OpenCodeNoticeCurrentClaimUnavailableError extends Error {
  readonly code = OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE;
  readonly retryable = true;

  constructor(reason: string, options?: ErrorOptions) {
    super(`OpenCode Boss notice insertion requires a new authenticated reservation before retry: ${reason}`, options);
    this.name = "OpenCodeNoticeCurrentClaimUnavailableError";
  }
}

export class OpenCodeNoticeInsertionFencingUnavailableError extends Error {
  readonly code = INSERTION_FENCING_UNAVAILABLE;
  readonly retryable = true;

  constructor() {
    super("OpenCode Boss notice insertion is unavailable without a protected authenticated atomic current-claim/deadline-bound insertion authority");
    this.name = "OpenCodeNoticeInsertionFencingUnavailableError";
  }
}

/**
 * Current production boundary. Ordinary Message delivery must never be used as
 * a substitute authority or as locally manufactured target-ledger evidence.
 */
export function createProductionOpenCodeNoticeRecipientIngress(): never {
  throw new OpenCodeNoticeAuthorityUnavailableError();
}

function emptyState(): OpenCodeNoticeIngressState {
  return { version: 1, records: Object.create(null) as Record<string, OpenCodeNoticeIngressRecord> };
}

function collisionResistantName(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function getOpenCodeNoticeIngressStatePath(sessionId: string, intercomDir = getIntercomDirPath()): string {
  return join(intercomDir, `opencode-notice-ingress-${collisionResistantName(sessionId)}.json`);
}

function ownRecord(value: unknown, path: string): Record<string, unknown> {
  assertRecord(value, path);
  return value;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], path: string): void {
  assertExactKeys(value, required, optional, path);
}

function payload(envelope: NoticeRecipientIngressEnvelope): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${path} must be a timestamp`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function assertSame(actual: unknown, expected: unknown, field: string, context: string): void {
  if (actual !== expected) throw new Error(`${context} ${field} does not match the winning claim`);
}

function assertReservationMatches(envelope: NoticeRecipientIngressEnvelope, claim: DeliveryClaimRecord): void {
  if (envelope.operation !== "reserve_delivery") throw new Error("Expected reserve_delivery before prompt injection");
  if (claim.state !== "reserved") throw new Error("Notice delivery claim must be reserved before prompt injection");
  if (claim.recipientContext !== "opencode") throw new Error("Notice delivery claim is not for OpenCode");
  const request = payload(envelope);
  const comparisons: Array<[unknown, unknown, string]> = [
    [claim.deliveryGroupId, request.deliveryGroupId, "deliveryGroupId"],
    [claim.membershipRevision, request.membershipRevision, "membershipRevision"],
    [claim.effectiveDeliveryIntent, request.effectiveDeliveryIntent, "effectiveDeliveryIntent"],
    [claim.primaryNoticeId, request.primaryNoticeId, "primaryNoticeId"],
    [claim.recipientContext, request.recipientContext, "recipientContext"],
    [claim.recipientSessionId, request.recipientSessionId, "recipientSessionId"],
    [claim.recipientTargetSessionId, request.recipientTargetSessionId, "recipientTargetSessionId"],
    [claim.recipientPrincipalId, request.recipientPrincipalId, "recipientPrincipalId"],
    [claim.recipientBindingEpoch, request.recipientBindingEpoch, "recipientBindingEpoch"],
    [claim.recipientTransferGeneration, request.recipientTransferGeneration, "recipientTransferGeneration"],
    [claim.workerGeneration, request.workerGeneration, "workerGeneration"],
  ];
  for (const [actual, expected, field] of comparisons) assertSame(actual, expected, field, "Reserved notice claim");
  if (canonicalJson(claim.memberNoticeIds) !== canonicalJson(request.memberNoticeIds)) {
    throw new Error("Reserved notice claim memberNoticeIds do not match the ingress request");
  }
  if (Date.parse(timestamp(request.requestedAt, "$.payload.requestedAt")) >= Date.parse(claim.expiresAt)) {
    throw new Error("Notice reservation was requested after the winning claim expired");
  }
}

function assertWallClockFresh(claim: DeliveryClaimRecord, now: number): void {
  if (Date.parse(claim.expiresAt) <= now) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError("the winning delivery claim is wall-clock expired");
  }
}

function atomicInsertionRequest(
  record: OpenCodeNoticeIngressRecord,
  insertion: NoticeRecipientIngressEnvelope,
  now: number,
): OpenCodeNoticeAtomicInsertionRequest {
  return {
    version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
    requestNonce: randomUUID(),
    requestedAt: new Date(now).toISOString(),
    claim: structuredClone(record.claim),
    insertion: structuredClone(insertion),
  };
}

function parseInsertionReceipt(value: unknown, path: string): OpenCodeNoticeInsertionReceipt {
  const receipt = ownRecord(value, path);
  exactKeys(receipt, ["deliveryClaimId", "claimGeneration", "targetLedgerEntryId", "insertedAt"], [], path);
  const claimGeneration = receipt.claimGeneration;
  if (!Number.isSafeInteger(claimGeneration) || (claimGeneration as number) < 0) {
    throw new Error(`${path}.claimGeneration must be a non-negative safe integer`);
  }
  return {
    deliveryClaimId: nonEmptyString(receipt.deliveryClaimId, `${path}.deliveryClaimId`),
    claimGeneration: claimGeneration as DeliveryClaimGeneration,
    targetLedgerEntryId: nonEmptyString(receipt.targetLedgerEntryId, `${path}.targetLedgerEntryId`),
    insertedAt: timestamp(receipt.insertedAt, `${path}.insertedAt`),
  };
}

function parseAtomicInsertionResult(value: unknown): OpenCodeNoticeAtomicInsertionResult {
  const result = ownRecord(value, "$atomicInsertionResult");
  exactKeys(
    result,
    ["version", "requestNonce", "status"],
    ["claim", "receipt"],
    "$atomicInsertionResult",
  );
  if (result.version !== OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION) {
    throw new Error("Unsupported OpenCode atomic insertion result version");
  }
  const status = result.status;
  if (status !== "inserted" && status !== "revoked" && status !== "superseded" && status !== "expired") {
    throw new Error("$atomicInsertionResult.status is invalid");
  }
  const claim = result.claim === undefined ? undefined : parseDeliveryClaimRecord(result.claim);
  const receipt = result.receipt === undefined
    ? undefined
    : parseInsertionReceipt(result.receipt, "$atomicInsertionResult.receipt");
  if (status === "inserted" ? claim === undefined || receipt === undefined : claim !== undefined || receipt !== undefined) {
    throw new Error("$atomicInsertionResult claim and receipt are present exactly for inserted status");
  }
  return {
    version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
    requestNonce: nonEmptyString(result.requestNonce, "$atomicInsertionResult.requestNonce"),
    status,
    ...(claim === undefined ? {} : { claim }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function assertAtomicInsertionResultMatches(
  record: OpenCodeNoticeIngressRecord,
  request: OpenCodeNoticeAtomicInsertionRequest,
  result: OpenCodeNoticeAtomicInsertionResult,
): asserts result is OpenCodeNoticeAtomicInsertionResult & {
  status: "inserted";
  claim: DeliveryClaimRecord;
  receipt: OpenCodeNoticeInsertionReceipt;
} {
  if (result.requestNonce !== request.requestNonce) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError("atomic insertion result does not bind the fresh request nonce");
  }
  if (result.status !== "inserted" || !result.claim || !result.receipt) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError(`the authenticated winning claim is ${result.status}`);
  }
  if (canonicalJson(result.claim) !== canonicalJson(record.claim)) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError("atomic insertion current-claim proof does not exactly match the durable winner");
  }
  assertInsertionReceiptMatches(record, result.receipt);
}

function assertInsertionMatches(record: OpenCodeNoticeIngressRecord, envelope: NoticeRecipientIngressEnvelope): void {
  if (envelope.operation !== "insert_or_attach") throw new Error("Expected insert_or_attach");
  const request = payload(envelope);
  const claim = record.claim;
  const comparisons: Array<[unknown, unknown, string]> = [
    [claim.deliveryClaimId, request.deliveryClaimId, "deliveryClaimId"],
    [claim.claimGeneration, request.claimGeneration, "claimGeneration"],
    [claim.deliveryGroupId, request.deliveryGroupId, "deliveryGroupId"],
    [claim.membershipRevision, request.membershipRevision, "membershipRevision"],
    [claim.effectiveDeliveryIntent, request.effectiveDeliveryIntent, "effectiveDeliveryIntent"],
    [claim.primaryNoticeId, request.primaryNoticeId, "primaryNoticeId"],
    [claim.recipientPrincipalId, request.recipientPrincipalId, "recipientPrincipalId"],
    [claim.recipientBindingEpoch, request.recipientBindingEpoch, "recipientBindingEpoch"],
    [claim.workerGeneration, request.workerGeneration, "workerGeneration"],
    [claim.ingressMode, request.ingressMode, "ingressMode"],
  ];
  for (const [actual, expected, field] of comparisons) assertSame(actual, expected, field, "Notice insertion");
  if (canonicalJson(claim.memberNoticeIds) !== canonicalJson(request.memberNoticeIds)) {
    throw new Error("Notice insertion memberNoticeIds do not match the winning claim");
  }
  if (canonicalJson(request.transitionIds) !== canonicalJson([claim.transitionId])) {
    throw new Error("Notice insertion transitionIds do not exactly match the winning claim transition");
  }
  const requestedAt = timestamp(request.requestedAt, "$.payload.requestedAt");
  if (Date.parse(requestedAt) >= Date.parse(claim.expiresAt)) throw new Error("Notice insertion was requested after claim expiry");
  const reserveRequestedAt = timestamp(payload(record.reserve).requestedAt, "$.reserve.payload.requestedAt");
  if (Date.parse(requestedAt) < Date.parse(reserveRequestedAt)) throw new Error("Notice insertion predates its reservation");
}

function assertLookupMatches(
  record: OpenCodeNoticeIngressRecord,
  request: NoticeRecipientIngressEnvelope,
  lookup: TargetLedgerLookupResult,
): void {
  assertSame(record.claim.deliveryClaimId, lookup.deliveryClaimId, "deliveryClaimId", "Target ledger lookup");
  assertSame(record.claim.claimGeneration, lookup.claimGeneration, "claimGeneration", "Target ledger lookup");
  const requestedAt = timestamp(payload(request).checkedAt, "$.lookup.payload.checkedAt");
  if (Date.parse(lookup.checkedAt) < Date.parse(requestedAt)) {
    throw new Error("Target ledger result predates its authenticated lookup request");
  }
}

function assertInsertionReceiptMatches(record: OpenCodeNoticeIngressRecord, receipt: OpenCodeNoticeInsertionReceipt): void {
  assertSame(record.claim.deliveryClaimId, receipt.deliveryClaimId, "deliveryClaimId", "OpenCode insertion receipt");
  assertSame(record.claim.claimGeneration, receipt.claimGeneration, "claimGeneration", "OpenCode insertion receipt");
  if (!receipt.targetLedgerEntryId) throw new Error("OpenCode insertion receipt targetLedgerEntryId is required");
  const insertedAt = timestamp(receipt.insertedAt, "$.insertedAt");
  const requestedAt = timestamp(payload(record.insertion!).requestedAt, "$.insertion.payload.requestedAt");
  if (Date.parse(insertedAt) < Date.parse(requestedAt)) throw new Error("OpenCode insertion receipt predates the insertion attempt");
  if (Date.parse(insertedAt) >= Date.parse(record.claim.expiresAt)) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError("the insertion receipt is not strictly before the winning claim expiry");
  }
}

function assertReceiptMatches(record: OpenCodeNoticeIngressRecord, envelope: NoticeRecipientIngressEnvelope): void {
  if (envelope.operation !== "record_receipt") throw new Error("Expected record_receipt");
  if (!record.insertion || !record.targetLedgerEntryId || !record.insertedAt) {
    throw new Error("Cannot receipt a notice without durable target-ledger insertion evidence");
  }
  const request = payload(envelope);
  const claim = record.claim;
  const comparisons: Array<[unknown, unknown, string]> = [
    [claim.deliveryClaimId, request.deliveryClaimId, "deliveryClaimId"],
    [claim.claimGeneration, request.claimGeneration, "claimGeneration"],
    [claim.deliveryGroupId, request.deliveryGroupId, "deliveryGroupId"],
    [claim.membershipRevision, request.membershipRevision, "membershipRevision"],
    [claim.recipientPrincipalId, request.recipientPrincipalId, "recipientPrincipalId"],
    [claim.recipientBindingEpoch, request.recipientBindingEpoch, "recipientBindingEpoch"],
    [claim.workerGeneration, request.workerGeneration, "workerGeneration"],
    [claim.ingressMode, request.deliveryMode, "deliveryMode"],
    [record.targetLedgerEntryId, request.targetLedgerEntryId, "targetLedgerEntryId"],
    [record.insertedAt, request.insertedAt, "insertedAt"],
    [payload(record.insertion).resultMessageId, request.resultMessageId, "resultMessageId"],
  ];
  for (const [actual, expected, field] of comparisons) assertSame(actual, expected, field, "Notice receipt");
}

function assertDeliveredClaimMatches(record: OpenCodeNoticeIngressRecord, delivered: DeliveryClaimRecord): void {
  if (delivered.state !== "delivered") throw new Error("Receipt authority did not return a delivered claim");
  const receipt = payload(record.receipt!);
  const immutableFields: Array<keyof DeliveryClaimRecord> = [
    "deliveryClaimId",
    "claimGeneration",
    "deliveryGroupId",
    "membershipRevision",
    "effectiveDeliveryIntent",
    "primaryNoticeId",
    "recipientContext",
    "recipientSessionId",
    "recipientTargetSessionId",
    "recipientPrincipalId",
    "recipientBindingEpoch",
    "recipientTransferGeneration",
    "workerId",
    "workerGeneration",
    "transitionId",
    "transitionVersion",
    "assignmentId",
    "turnId",
    "watchdogGeneration",
    "ingressMode",
  ];
  for (const field of immutableFields) assertSame(record.claim[field], delivered[field], String(field), "Delivered claim");
  if (canonicalJson(record.claim.memberNoticeIds) !== canonicalJson(delivered.memberNoticeIds)) {
    throw new Error("Delivered claim memberNoticeIds changed after reservation");
  }
  const settlement: Array<[unknown, unknown, string]> = [
    [record.targetLedgerEntryId, delivered.targetLedgerEntryId, "targetLedgerEntryId"],
    [record.insertedAt, delivered.insertedAt, "insertedAt"],
    [receipt.deliveryReceiptId, delivered.deliveryReceiptId, "deliveryReceiptId"],
    [receipt.deliveredAt, delivered.deliveredAt, "deliveredAt"],
    [receipt.resultMessageId, delivered.resultMessageId, "resultMessageId"],
    [receipt.coalescedByResult, delivered.coalescedByResult, "coalescedByResult"],
  ];
  for (const [actual, expected, field] of settlement) assertSame(actual, expected, field, "Delivered claim");
}

function parseRecord(value: unknown, path: string): OpenCodeNoticeIngressRecord {
  const record = ownRecord(value, path);
  exactKeys(
    record,
    ["reserve", "claim", "phase"],
    ["insertion", "targetLedgerEntryId", "insertedAt", "receipt", "deliveredClaim"],
    path,
  );
  const reserve = parseNoticeRecipientIngressEnvelope(record.reserve);
  const claim = parseDeliveryClaimRecord(record.claim);
  const phase = record.phase;
  if (phase !== "reserved" && phase !== "inserting" && phase !== "inserted" && phase !== "receipting" && phase !== "delivered") {
    throw new Error(`${path}.phase is invalid`);
  }
  const insertion = record.insertion === undefined ? undefined : parseNoticeRecipientIngressEnvelope(record.insertion);
  const targetLedgerEntryId = record.targetLedgerEntryId === undefined ? undefined : String(record.targetLedgerEntryId);
  if (record.targetLedgerEntryId !== undefined && (typeof record.targetLedgerEntryId !== "string" || record.targetLedgerEntryId.length === 0)) {
    throw new Error(`${path}.targetLedgerEntryId must be a non-empty string`);
  }
  const insertedAt = record.insertedAt === undefined ? undefined : timestamp(record.insertedAt, `${path}.insertedAt`);
  const receipt = record.receipt === undefined ? undefined : parseNoticeRecipientIngressEnvelope(record.receipt);
  const deliveredClaim = record.deliveredClaim === undefined ? undefined : parseDeliveryClaimRecord(record.deliveredClaim);

  const parsed: OpenCodeNoticeIngressRecord = {
    reserve,
    claim,
    phase,
    ...(insertion === undefined ? {} : { insertion }),
    ...(targetLedgerEntryId === undefined ? {} : { targetLedgerEntryId }),
    ...(insertedAt === undefined ? {} : { insertedAt }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(deliveredClaim === undefined ? {} : { deliveredClaim }),
  };
  assertReservationMatches(reserve, claim);
  if (insertion !== undefined) assertInsertionMatches(parsed, insertion);
  const hasInsertionEvidence = targetLedgerEntryId !== undefined || insertedAt !== undefined;
  if (hasInsertionEvidence && (targetLedgerEntryId === undefined || insertedAt === undefined)) {
    throw new Error(`${path} target ledger evidence must be present together`);
  }
  if (phase === "reserved" && (insertion !== undefined || hasInsertionEvidence || receipt !== undefined || deliveredClaim !== undefined)) {
    throw new Error(`${path} reserved record contains later-phase evidence`);
  }
  if (phase === "inserting" && (insertion === undefined || hasInsertionEvidence || receipt !== undefined || deliveredClaim !== undefined)) {
    throw new Error(`${path} inserting record has invalid evidence`);
  }
  if (phase === "inserted" && (insertion === undefined || !hasInsertionEvidence || receipt !== undefined || deliveredClaim !== undefined)) {
    throw new Error(`${path} inserted record has invalid evidence`);
  }
  if (phase === "receipting" && (insertion === undefined || !hasInsertionEvidence || receipt === undefined || deliveredClaim !== undefined)) {
    throw new Error(`${path} receipting record has invalid evidence`);
  }
  if (phase === "delivered" && (insertion === undefined || !hasInsertionEvidence || receipt === undefined || deliveredClaim === undefined)) {
    throw new Error(`${path} delivered record lacks settlement evidence`);
  }
  if (receipt !== undefined) assertReceiptMatches(parsed, receipt);
  if (deliveredClaim !== undefined) assertDeliveredClaimMatches(parsed, deliveredClaim);
  return parsed;
}

function parseState(value: unknown): OpenCodeNoticeIngressState {
  const state = ownRecord(value, "$noticeIngress");
  exactKeys(state, ["version", "records"], [], "$noticeIngress");
  if (state.version !== 1) throw new Error("Unsupported OpenCode notice ingress state version");
  const recordsValue = ownRecord(state.records, "$noticeIngress.records");
  const records = Object.create(null) as Record<string, OpenCodeNoticeIngressRecord>;
  const deliveryGroups = new Set<string>();
  for (const [claimId, value] of Object.entries(recordsValue)) {
    const record = parseRecord(value, `$noticeIngress.records[${JSON.stringify(claimId)}]`);
    if (record.claim.deliveryClaimId !== claimId) throw new Error("Notice ingress claim key does not match its record");
    if (deliveryGroups.has(record.claim.deliveryGroupId)) throw new Error("Multiple OpenCode notice claims own one delivery group");
    deliveryGroups.add(record.claim.deliveryGroupId);
    records[claimId] = record;
  }
  return { version: 1, records };
}

function clone(record: OpenCodeNoticeIngressRecord): OpenCodeNoticeIngressRecord {
  return structuredClone(record);
}

function cloneState(state: OpenCodeNoticeIngressState): OpenCodeNoticeIngressState {
  return parseState(structuredClone(state));
}

function getOwnRecord(
  records: Record<string, OpenCodeNoticeIngressRecord>,
  deliveryClaimId: string,
): OpenCodeNoticeIngressRecord | undefined {
  return Object.hasOwn(records, deliveryClaimId) ? records[deliveryClaimId] : undefined;
}

function serializableState(state: OpenCodeNoticeIngressState): OpenCodeNoticeIngressState {
  const records: Record<string, OpenCodeNoticeIngressRecord> = {};
  for (const [deliveryClaimId, record] of Object.entries(state.records)) {
    Object.defineProperty(records, deliveryClaimId, {
      value: clone(record),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { version: 1, records };
}

function canonicalState(state: OpenCodeNoticeIngressState): string {
  return canonicalJson(serializableState(state));
}

export function targetLedgerLookupEnvelope(record: OpenCodeNoticeIngressRecord): NoticeRecipientIngressEnvelope {
  if (!record.insertion) throw new Error("Cannot look up a notice before insertion begins");
  const claim = record.claim;
  const requestNonce = randomUUID();
  const checkedAt = new Date().toISOString();
  return parseNoticeRecipientIngressEnvelope({
    version: "orc.notice-recipient-ingress.v1",
    operation: "lookup_target_ledger",
    requestId: `${claim.deliveryClaimId}:opencode-ledger:${claim.claimGeneration}:${requestNonce}`,
    idempotencyKey: `${claim.deliveryClaimId}:opencode-ledger:${claim.claimGeneration}:${requestNonce}`,
    payload: {
      deliveryClaimId: claim.deliveryClaimId,
      claimGeneration: claim.claimGeneration,
      recipientContext: claim.recipientContext,
      recipientSessionId: claim.recipientSessionId,
      ...(claim.recipientTargetSessionId === undefined ? {} : { recipientTargetSessionId: claim.recipientTargetSessionId }),
      checkedAt,
    },
  });
}

export class DurableOpenCodeNoticeIngressStore {
  readonly path: string;
  private state: OpenCodeNoticeIngressState;
  private readonly persist: (path: string, state: OpenCodeNoticeIngressState) => void;
  private poisoned: Error | undefined;

  constructor(
    path: string,
    persist: (path: string, state: OpenCodeNoticeIngressState) => void = writeDurableJson,
  ) {
    this.path = path;
    ensureIntercomRuntimeDir(dirname(path));
    this.persist = persist;
    this.state = this.load();
  }

  get(deliveryClaimId: string): OpenCodeNoticeIngressRecord | undefined {
    this.assertUsable();
    const record = getOwnRecord(this.state.records, deliveryClaimId);
    return record === undefined ? undefined : clone(record);
  }

  reserve(envelopeValue: unknown, claimValue: unknown): OpenCodeNoticeIngressRecord {
    this.assertUsable();
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    const claim = parseDeliveryClaimRecord(claimValue);
    assertReservationMatches(envelope, claim);
    const existing = getOwnRecord(this.state.records, claim.deliveryClaimId);
    if (existing) {
      if (canonicalJson(existing.reserve) !== canonicalJson(envelope) || canonicalJson(existing.claim) !== canonicalJson(claim)) {
        throw new Error("Conflicting OpenCode notice reservation");
      }
      return clone(existing);
    }
    if (Object.values(this.state.records).some((record) => record.claim.deliveryGroupId === claim.deliveryGroupId)) {
      throw new Error("A different OpenCode notice claim already owns this delivery group");
    }
    const record: OpenCodeNoticeIngressRecord = { reserve: envelope, claim, phase: "reserved" };
    const next = cloneState(this.state);
    next.records[claim.deliveryClaimId] = record;
    this.commit(next);
    return clone(record);
  }

  beginInsertion(envelopeValue: unknown): OpenCodeNoticeIngressRecord {
    this.assertUsable();
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    if (envelope.operation !== "insert_or_attach") throw new Error("Expected insert_or_attach");
    const claimId = payload(envelope).deliveryClaimId;
    if (typeof claimId !== "string") throw new Error("Notice insertion omitted deliveryClaimId");
    const record = getOwnRecord(this.state.records, claimId);
    if (!record) throw new Error("Notice insertion has no durable winning reservation");
    assertInsertionMatches(record, envelope);
    if (record.phase !== "reserved") {
      if (canonicalJson(record.insertion) !== canonicalJson(envelope)) throw new Error("Conflicting OpenCode notice insertion replay");
      return clone(record);
    }
    const updated: OpenCodeNoticeIngressRecord = { ...record, phase: "inserting", insertion: envelope };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[claimId] = updated;
    this.commit(next);
    return clone(updated);
  }

  markInserted(deliveryClaimId: string, receipt: OpenCodeNoticeInsertionReceipt): OpenCodeNoticeIngressRecord {
    this.assertUsable();
    const record = getOwnRecord(this.state.records, deliveryClaimId);
    if (!record || record.phase === "reserved") throw new Error("Cannot receipt an unreserved OpenCode notice insertion");
    assertInsertionReceiptMatches(record, receipt);
    if (record.phase !== "inserting") {
      if (record.targetLedgerEntryId !== receipt.targetLedgerEntryId || record.insertedAt !== receipt.insertedAt) {
        throw new Error("Conflicting OpenCode notice ledger receipt");
      }
      return clone(record);
    }
    const updated: OpenCodeNoticeIngressRecord = {
      ...record,
      phase: "inserted",
      targetLedgerEntryId: receipt.targetLedgerEntryId,
      insertedAt: receipt.insertedAt,
    };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[deliveryClaimId] = updated;
    this.commit(next);
    return clone(updated);
  }

  beginReceipt(envelopeValue: unknown): OpenCodeNoticeIngressRecord {
    this.assertUsable();
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    if (envelope.operation !== "record_receipt") throw new Error("Expected record_receipt");
    const claimId = payload(envelope).deliveryClaimId;
    if (typeof claimId !== "string") throw new Error("Notice receipt omitted deliveryClaimId");
    const record = getOwnRecord(this.state.records, claimId);
    if (!record || (record.phase !== "inserted" && record.phase !== "receipting" && record.phase !== "delivered")) {
      throw new Error("Cannot record a receipt before durable OpenCode insertion");
    }
    assertReceiptMatches(record, envelope);
    if (record.phase !== "inserted") {
      if (canonicalJson(record.receipt) !== canonicalJson(envelope)) throw new Error("Conflicting OpenCode notice receipt replay");
      return clone(record);
    }
    const updated: OpenCodeNoticeIngressRecord = { ...record, phase: "receipting", receipt: envelope };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[claimId] = updated;
    this.commit(next);
    return clone(updated);
  }

  markDelivered(deliveryClaimId: string, claimValue: unknown): OpenCodeNoticeIngressRecord {
    this.assertUsable();
    const record = getOwnRecord(this.state.records, deliveryClaimId);
    if (!record || (record.phase !== "receipting" && record.phase !== "delivered")) {
      throw new Error("Cannot settle an OpenCode notice before recording its receipt request");
    }
    const deliveredClaim = parseDeliveryClaimRecord(claimValue);
    assertDeliveredClaimMatches(record, deliveredClaim);
    if (record.phase === "delivered") {
      if (canonicalJson(record.deliveredClaim) !== canonicalJson(deliveredClaim)) throw new Error("Conflicting delivered claim replay");
      return clone(record);
    }
    const updated: OpenCodeNoticeIngressRecord = { ...record, phase: "delivered", deliveredClaim };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[deliveryClaimId] = updated;
    this.commit(next);
    return clone(updated);
  }

  pending(): OpenCodeNoticeIngressRecord[] {
    this.assertUsable();
    return Object.values(this.state.records).filter((record) => record.phase !== "delivered").map(clone);
  }

  private load(): OpenCodeNoticeIngressState {
    if (!existsSync(this.path)) return emptyState();
    return parseState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  private loadExactTarget(): OpenCodeNoticeIngressState {
    if (!existsSync(this.path)) throw new Error("Durable OpenCode notice ingress target is missing");
    return parseState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  private commit(next: OpenCodeNoticeIngressState): void {
    const stagedCanonical = canonicalState(parseState(structuredClone(next)));
    const priorCanonical = canonicalState(this.state);
    try {
      this.persist(this.path, serializableState(parseState(JSON.parse(stagedCanonical))));
    } catch (persistError) {
      try {
        const recovered = this.loadExactTarget();
        const recoveredCanonical = canonicalState(recovered);
        if (recoveredCanonical === stagedCanonical) {
          this.state = parseState(JSON.parse(stagedCanonical));
        } else if (recoveredCanonical === priorCanonical) {
          this.state = parseState(JSON.parse(priorCanonical));
        } else {
          throw new Error("Durable OpenCode notice ingress state does not match the prior or staged commit");
        }
      } catch (reconcileError) {
        this.poisoned = new Error("Durable OpenCode notice ingress store is unavailable after commit reconciliation failed", {
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

export class OpenCodeNoticeRecipientIngress {
  constructor(
    private readonly store: DurableOpenCodeNoticeIngressStore,
    private readonly authority: AuthenticatedOpenCodeNoticeAuthority,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!authority) throw new Error("Authenticated notice authority API is required");
  }

  async reserveBeforePrompt(envelopeValue: unknown): Promise<OpenCodeNoticeIngressRecord> {
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    if (envelope.operation !== "reserve_delivery") throw new Error("Expected reserve_delivery");
    const claim = await this.authority.reserveDelivery(envelope);
    return this.store.reserve(envelope, claim);
  }

  async insertOrAttach(
    envelopeValue: unknown,
    injectPromptOrAttach: (envelope: NoticeRecipientIngressEnvelope) => Promise<OpenCodeNoticeInsertionReceipt>,
  ): Promise<OpenCodeNoticeIngressRecord> {
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    const claimId = payload(envelope).deliveryClaimId;
    if (typeof claimId !== "string") throw new Error("Notice insertion omitted deliveryClaimId");
    const prior = this.store.get(claimId);
    if (prior?.phase === "reserved") {
      assertInsertionMatches(prior, envelope);
      const protectedInsertion = this.authority.insertOrAttachWhileClaimCurrent;
      if (typeof protectedInsertion !== "function") {
        throw new OpenCodeNoticeInsertionFencingUnavailableError();
      }
      const requestedAt = this.now();
      assertWallClockFresh(prior.claim, requestedAt);
      const request = atomicInsertionRequest(prior, envelope, requestedAt);
      let callbackCalls = 0;
      let authorityCallOpen = false;
      let rawResult: unknown;
      const guardedInsertion = async (): Promise<OpenCodeNoticeInsertionReceipt> => {
        if (!authorityCallOpen || callbackCalls !== 0) throw new Error("FENCING_CALLBACK_CLOSED");
        callbackCalls = 1;
        // This local check is defense in depth only. The authenticated
        // authority's atomic current-claim/deadline fence is the authority.
        assertWallClockFresh(prior.claim, this.now());
        const inserting = this.store.beginInsertion(envelope);
        if (inserting.phase !== "inserting") throw new Error("Protected OpenCode notice insertion did not begin from its reserved phase");
        return parseInsertionReceipt(await injectPromptOrAttach(envelope), "$protectedInsertionReceipt");
      };
      try {
        authorityCallOpen = true;
        rawResult = await new Promise<unknown>((resolve, reject) => {
          try {
            protectedInsertion.call(this.authority, request, guardedInsertion).then(
              (value) => {
                authorityCallOpen = false;
                resolve(value);
              },
              (error: unknown) => {
                authorityCallOpen = false;
                reject(error);
              },
            );
          } catch (error) {
            authorityCallOpen = false;
            reject(error);
          }
        });
      } finally {
        authorityCallOpen = false;
      }
      const result = parseAtomicInsertionResult(rawResult);
      if (result.status !== "inserted") {
        if (callbackCalls !== 0) {
          throw new Error(`Protected insertion authority invoked the target but returned ${result.status}`);
        }
        assertAtomicInsertionResultMatches(prior, request, result);
      }
      const expectedInserting: OpenCodeNoticeIngressRecord = {
        ...prior,
        phase: "inserting",
        insertion: envelope,
      };
      parseRecord(expectedInserting, "$expectedProtectedInsertion");
      assertAtomicInsertionResultMatches(expectedInserting, request, result);
      if (callbackCalls !== 1) {
        throw new Error("Protected insertion authority claimed insertion without invoking the protected target operation");
      }
      const inserting = this.store.get(claimId);
      if (!inserting || inserting.phase !== "inserting") {
        throw new Error("Protected OpenCode notice insertion lacks its durable inserting phase");
      }
      return this.store.markInserted(inserting.claim.deliveryClaimId, result.receipt);
    }
    const record = this.store.beginInsertion(envelope);
    if (record.phase === "inserted" || record.phase === "receipting" || record.phase === "delivered") return record;
    if (prior?.phase === "inserting") {
      const lookupEnvelope = targetLedgerLookupEnvelope(record);
      const lookup = parseTargetLedgerLookupResult(await this.authority.lookupTargetLedger(lookupEnvelope));
      assertLookupMatches(record, lookupEnvelope, lookup);
      if (lookup.state === "inserted") {
        return this.store.markInserted(record.claim.deliveryClaimId, {
          deliveryClaimId: lookup.deliveryClaimId,
          claimGeneration: lookup.claimGeneration,
          targetLedgerEntryId: lookup.targetLedgerEntryId!,
          insertedAt: lookup.insertedAt!,
        });
      }
      if (lookup.state !== "absent") {
        throw new Error(`Authenticated target ledger is ${lookup.state}; refusing ambiguous OpenCode replay`);
      }
      throw new Error(
        "Authenticated target-drained proof and generation-incremented current-claim reissue authority are unavailable; refusing OpenCode reinsertion",
      );
    }
    throw new Error("Unexpected OpenCode notice insertion state");
  }

  async recordReceipt(envelopeValue: unknown): Promise<OpenCodeNoticeIngressRecord> {
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    const record = this.store.beginReceipt(envelope);
    if (record.phase === "delivered") return record;
    const deliveredClaim = await this.authority.recordReceipt(envelope);
    return this.store.markDelivered(record.claim.deliveryClaimId, deliveredClaim);
  }

}
