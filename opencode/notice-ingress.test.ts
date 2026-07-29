import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DELIVERY_CLAIM_VERSION,
  NOTICE_RECIPIENT_INGRESS_VERSION,
  TARGET_LEDGER_RESULT_VERSION,
  type DeliveryClaimRecord,
  type NoticeRecipientIngressEnvelope,
  type TargetLedgerLookupResult,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  deliveryClaimGeneration,
  recipientTransferGeneration,
  transitionVersion,
  workerGeneration,
} from "@dataforxyz/agent-intercom-core/canonical";
import {
  DURABLE_JSON_FILE_OPERATIONS,
  writeDurableJson,
  type DurableJsonFileOperations,
} from "../durable-json.ts";
import {
  DurableOpenCodeNoticeIngressStore,
  createProductionOpenCodeNoticeRecipientIngress,
  getOpenCodeNoticeIngressStatePath,
  INSERTION_FENCING_UNAVAILABLE,
  OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
  OpenCodeNoticeCurrentClaimUnavailableError,
  OpenCodeNoticeInsertionFencingUnavailableError,
  OpenCodeNoticeRecipientIngress,
  type AuthenticatedOpenCodeNoticeAuthority,
  type OpenCodeNoticeAtomicInsertionRequest,
  type OpenCodeNoticeAtomicInsertionResult,
  type OpenCodeNoticeProtectedInsertion,
} from "./notice-ingress.ts";

const members = ["notice-a", "notice-b"];

function envelope(
  operation: NoticeRecipientIngressEnvelope["operation"],
  payload: Record<string, unknown>,
): NoticeRecipientIngressEnvelope {
  return {
    version: NOTICE_RECIPIENT_INGRESS_VERSION,
    operation,
    requestId: `request-${operation}`,
    idempotencyKey: `idempotency-${operation}`,
    payload: payload as never,
  };
}

const reserve = envelope("reserve_delivery", {
  deliveryGroupId: "group-a",
  membershipRevision: 1,
  effectiveDeliveryIntent: "wake",
  primaryNoticeId: "notice-a",
  memberNoticeIds: members,
  recipientContext: "opencode",
  recipientSessionId: "intercom-manager-a",
  recipientTargetSessionId: "opencode-ui-a",
  recipientPrincipalId: "manager-a",
  recipientBindingEpoch: 2,
  recipientTransferGeneration: 0,
  workerGeneration: 4,
  requestedAt: "2026-07-28T12:00:00.000Z",
});

const claim: DeliveryClaimRecord = {
  version: DELIVERY_CLAIM_VERSION,
  deliveryClaimId: "claim-a",
  deliveryGroupId: "group-a",
  membershipRevision: 1,
  effectiveDeliveryIntent: "wake",
  primaryNoticeId: "notice-a",
  memberNoticeIds: members,
  claimGeneration: deliveryClaimGeneration(1),
  expiresAt: "2099-07-28T12:10:00.000Z",
  recipientContext: "opencode",
  recipientSessionId: "intercom-manager-a",
  recipientTargetSessionId: "opencode-ui-a",
  recipientPrincipalId: "manager-a",
  recipientBindingEpoch: 2,
  recipientTransferGeneration: recipientTransferGeneration(0),
  workerId: "worker-a",
  workerGeneration: workerGeneration(4),
  transitionId: "transition-a",
  transitionVersion: transitionVersion(1),
  assignmentId: "assignment-a",
  turnId: "turn-a",
  ingressMode: "lifecycle_message",
  state: "reserved",
};

const insertion = envelope("insert_or_attach", {
  deliveryClaimId: "claim-a",
  claimGeneration: 1,
  deliveryGroupId: "group-a",
  membershipRevision: 1,
  effectiveDeliveryIntent: "wake",
  primaryNoticeId: "notice-a",
  memberNoticeIds: members,
  transitionIds: ["transition-a"],
  recipientPrincipalId: "manager-a",
  recipientBindingEpoch: 2,
  workerGeneration: 4,
  ingressMode: "lifecycle_message",
  requestedAt: "2026-07-28T12:00:01.000Z",
});

const receipt = envelope("record_receipt", {
  deliveryClaimId: "claim-a",
  claimGeneration: 1,
  deliveryGroupId: "group-a",
  membershipRevision: 1,
  recipientPrincipalId: "manager-a",
  recipientBindingEpoch: 2,
  workerGeneration: 4,
  deliveryReceiptId: "receipt-a",
  targetLedgerEntryId: "ledger-a",
  deliveryMode: "lifecycle_message",
  insertedAt: "2026-07-28T12:00:02.000Z",
  deliveredAt: "2026-07-28T12:00:03.000Z",
});

const deliveredClaim: DeliveryClaimRecord = {
  ...claim,
  state: "delivered",
  deliveryAttemptedAt: "2026-07-28T12:00:01.000Z",
  targetLedgerEntryId: "ledger-a",
  insertedAt: "2026-07-28T12:00:02.000Z",
  deliveredAt: "2026-07-28T12:00:03.000Z",
  deliveryReceiptId: "receipt-a",
};

function authority(overrides: Partial<AuthenticatedOpenCodeNoticeAuthority> = {}): AuthenticatedOpenCodeNoticeAuthority {
  return {
    async reserveDelivery() {
      return claim;
    },
    async insertOrAttachWhileClaimCurrent(request, insert) {
      const protectedReceipt = await insert();
      return atomicInsertionResult(request, protectedReceipt);
    },
    async lookupTargetLedger(lookup): Promise<TargetLedgerLookupResult> {
      return {
        version: TARGET_LEDGER_RESULT_VERSION,
        deliveryClaimId: claim.deliveryClaimId,
        claimGeneration: claim.claimGeneration,
        state: "absent",
        checkedAt: (lookup.payload as Record<string, unknown>).checkedAt as string,
      };
    },
    async recordReceipt() {
      return deliveredClaim;
    },
    ...overrides,
  };
}

function atomicInsertionResult(
  request: OpenCodeNoticeAtomicInsertionRequest,
  protectedReceipt = insertionReceipt(),
  currentClaim: DeliveryClaimRecord = claim,
): OpenCodeNoticeAtomicInsertionResult {
  return {
    version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
    requestNonce: request.requestNonce,
    status: "inserted",
    claim: currentClaim,
    receipt: protectedReceipt,
  };
}

function insertionReceipt() {
  return {
    deliveryClaimId: claim.deliveryClaimId,
    claimGeneration: claim.claimGeneration,
    targetLedgerEntryId: "ledger-a",
    insertedAt: "2026-07-28T12:00:02.000Z",
  };
}

function ingressStorePhase(path: string): string | undefined {
  return new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase;
}

type DurableFaultStage = "write" | "temp-fsync" | "rename" | "restrict" | "dir-fsync";

const PRE_RENAME_FAULTS: readonly DurableFaultStage[] = ["write", "temp-fsync", "rename"];
const DURABLE_FAULT_STAGES: readonly DurableFaultStage[] = [...PRE_RENAME_FAULTS, "restrict", "dir-fsync"];

function faultOncePersist(stage: DurableFaultStage): (path: string, state: unknown) => void {
  let faulted = false;
  return (path, state) => {
    if (faulted) {
      writeDurableJson(path, state);
      return;
    }
    let fsyncCalls = 0;
    const operations: DurableJsonFileOperations = {
      ...DURABLE_JSON_FILE_OPERATIONS,
      writeFile(filePath, contents, options) {
        if (stage === "write") {
          faulted = true;
          throw new Error("injected durable write fault");
        }
        DURABLE_JSON_FILE_OPERATIONS.writeFile(filePath, contents, options);
      },
      fsync(fileDescriptor) {
        fsyncCalls += 1;
        if (stage === "temp-fsync" && fsyncCalls === 1) {
          faulted = true;
          throw new Error("injected durable temp-fsync fault");
        }
        if (stage === "dir-fsync" && fsyncCalls === 2) {
          faulted = true;
          throw new Error("injected durable dir-fsync fault");
        }
        DURABLE_JSON_FILE_OPERATIONS.fsync(fileDescriptor);
      },
      rename(from, to) {
        if (stage === "rename") {
          faulted = true;
          throw new Error("injected durable rename fault");
        }
        DURABLE_JSON_FILE_OPERATIONS.rename(from, to);
      },
      restrict(filePath) {
        if (stage === "restrict") {
          faulted = true;
          throw new Error("injected durable restrict fault");
        }
        DURABLE_JSON_FILE_OPERATIONS.restrict(filePath);
      },
    };
    writeDurableJson(path, state, operations);
  };
}

function prepareIngressPhase(path: string, phase: "empty" | "reserved" | "inserting" | "inserted" | "receipting"): void {
  if (phase === "empty") {
    writeDurableJson(path, { version: 1, records: {} });
    return;
  }
  const store = new DurableOpenCodeNoticeIngressStore(path);
  store.reserve(reserve, claim);
  if (phase === "reserved") return;
  store.beginInsertion(insertion);
  if (phase === "inserting") return;
  store.markInserted(claim.deliveryClaimId, insertionReceipt());
  if (phase === "inserted") return;
  store.beginReceipt(receipt);
}

test("OpenCode ingress durably reserves before prompt API and receipts the exact claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-ingress-"));
  try {
    const path = join(root, "notices.json");
    const order: string[] = [];
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async reserveDelivery() {
        order.push("authority-reserved");
        return claim;
      },
      async insertOrAttachWhileClaimCurrent(request, insert) {
        order.push("authority-atomic");
        const protectedReceipt = await insert();
        return atomicInsertionResult(request, protectedReceipt);
      },
      async recordReceipt() {
        order.push(`receipt-after-${new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase}`);
        return deliveredClaim;
      },
    }));

    await ingress.reserveBeforePrompt(reserve);
    assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, "reserved");
    const inserted = await ingress.insertOrAttach(insertion, async () => {
      order.push(`prompt-after-${new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase}`);
      return insertionReceipt();
    });
    assert.equal(inserted.phase, "inserted");
    const delivered = await ingress.recordReceipt(receipt);
    assert.equal(delivered.phase, "delivered");
    assert.deepEqual(order, ["authority-reserved", "authority-atomic", "prompt-after-inserting", "receipt-after-receipting"]);
    assert.deepEqual(new DurableOpenCodeNoticeIngressStore(path).pending(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every notice ingress transition reconciles durable faults before same-process retry or reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-transition-faults-"));
  try {
    const transitions = [
      {
        name: "reserve",
        prepare: "empty",
        prior: undefined,
        next: "reserved",
        mutate: (store: DurableOpenCodeNoticeIngressStore) => store.reserve(reserve, claim),
      },
      {
        name: "beginInsertion",
        prepare: "reserved",
        prior: "reserved",
        next: "inserting",
        mutate: (store: DurableOpenCodeNoticeIngressStore) => store.beginInsertion(insertion),
      },
      {
        name: "markInserted",
        prepare: "inserting",
        prior: "inserting",
        next: "inserted",
        mutate: (store: DurableOpenCodeNoticeIngressStore) => store.markInserted(claim.deliveryClaimId, insertionReceipt()),
      },
      {
        name: "beginReceipt",
        prepare: "inserted",
        prior: "inserted",
        next: "receipting",
        mutate: (store: DurableOpenCodeNoticeIngressStore) => store.beginReceipt(receipt),
      },
      {
        name: "markDelivered",
        prepare: "receipting",
        prior: "receipting",
        next: "delivered",
        mutate: (store: DurableOpenCodeNoticeIngressStore) => store.markDelivered(claim.deliveryClaimId, deliveredClaim),
      },
    ] as const;

    for (const transition of transitions) {
      for (const stage of DURABLE_FAULT_STAGES) {
        const path = join(root, `${transition.name}-${stage}.json`);
        prepareIngressPhase(path, transition.prepare);
        const store = new DurableOpenCodeNoticeIngressStore(path, faultOncePersist(stage));
        assert.throws(
          () => transition.mutate(store),
          new RegExp(`injected durable ${stage} fault`),
          `${transition.name}/${stage} must surface the persistence exception`,
        );

        const reconciledPhase = PRE_RENAME_FAULTS.includes(stage) ? transition.prior : transition.next;
        assert.equal(
          store.get(claim.deliveryClaimId)?.phase,
          reconciledPhase,
          `${transition.name}/${stage} must publish only the exact reconciled disk state`,
        );
        assert.equal(
          new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase,
          reconciledPhase,
          `${transition.name}/${stage} reload must agree with same-process reconciliation`,
        );

        const retried = transition.mutate(store);
        assert.equal(retried.phase, transition.next, `${transition.name}/${stage} exact retry must reach the next phase`);
        assert.deepEqual(
          transition.mutate(store),
          retried,
          `${transition.name}/${stage} committed replay must remain exactly idempotent`,
        );
        assert.equal(
          new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase,
          transition.next,
          `${transition.name}/${stage} retried phase must survive reload`,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notice ingress never publishes the mutable state exposed to its persister", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-persist-alias-"));
  try {
    const path = join(root, "notices.json");
    let retained: { records: Record<string, unknown> } | undefined;
    const store = new DurableOpenCodeNoticeIngressStore(path, (target, state) => {
      writeDurableJson(target, state);
      retained = state;
      state.records = { callbackMutation: state.records[claim.deliveryClaimId]! };
    });

    store.reserve(reserve, claim);
    assert.equal(store.get(claim.deliveryClaimId)?.phase, "reserved");
    assert.equal(store.pending().length, 1);
    assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, "reserved");

    retained!.records = {};
    assert.equal(store.get(claim.deliveryClaimId)?.phase, "reserved");
    assert.equal(store.pending().length, 1);
    assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, "reserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notice ingress reconciles exceptions against pre-callback prior and staged snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-persist-snapshots-"));
  try {
    for (const durableTarget of ["prior", "staged"] as const) {
      const path = join(root, `${durableTarget}.json`);
      let call = 0;
      let retainedPrior: { records: Record<string, unknown> } | undefined;
      let retainedStaged: { records: Record<string, unknown> } | undefined;
      const store = new DurableOpenCodeNoticeIngressStore(path, (target, state) => {
        call += 1;
        if (call === 1) {
          writeDurableJson(target, state);
          retainedPrior = state;
          return;
        }
        if (durableTarget === "staged") writeDurableJson(target, state);
        retainedStaged = state;
        retainedPrior!.records = {};
        state.records = {};
        throw new Error(`injected ${durableTarget} exception after mutation`);
      });

      store.reserve(reserve, claim);
      assert.throws(
        () => store.beginInsertion(insertion),
        new RegExp(`injected ${durableTarget} exception after mutation`),
      );
      const expectedPhase = durableTarget === "staged" ? "inserting" : "reserved";
      assert.equal(store.get(claim.deliveryClaimId)?.phase, expectedPhase);
      assert.equal(store.pending().length, 1);
      assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, expectedPhase);

      retainedPrior!.records = {};
      retainedStaged!.records = {};
      assert.equal(store.get(claim.deliveryClaimId)?.phase, expectedPhase);
      assert.equal(store.pending().length, 1);
      assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, expectedPhase);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt and settlement callbacks never cross an uncommitted ingress phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-side-effect-faults-"));
  try {
    for (const stage of DURABLE_FAULT_STAGES) {
      const insertionPath = join(root, `insertion-${stage}.json`);
      prepareIngressPhase(insertionPath, "reserved");
      let promptCalls = 0;
      const insertionIngress = new OpenCodeNoticeRecipientIngress(
        new DurableOpenCodeNoticeIngressStore(insertionPath, faultOncePersist(stage)),
        authority({
          async lookupTargetLedger(lookup): Promise<TargetLedgerLookupResult> {
            const checkedAt = (lookup.payload as Record<string, unknown>).checkedAt as string;
            return {
              version: TARGET_LEDGER_RESULT_VERSION,
              deliveryClaimId: claim.deliveryClaimId,
              claimGeneration: claim.claimGeneration,
              state: "inserted",
              checkedAt,
              targetLedgerEntryId: "ledger-a",
              insertedAt: checkedAt,
            };
          },
        }),
      );
      await assert.rejects(
        () => insertionIngress.insertOrAttach(insertion, async () => {
          promptCalls += 1;
          return insertionReceipt();
        }),
        new RegExp(`injected durable ${stage} fault`),
      );
      assert.equal(promptCalls, 0, `${stage} must not prompt before inserting is committed`);
      const inserted = await insertionIngress.insertOrAttach(insertion, async () => {
        promptCalls += 1;
        return insertionReceipt();
      });
      assert.equal(inserted.phase, "inserted");
      assert.equal(promptCalls, PRE_RENAME_FAULTS.includes(stage) ? 1 : 0);

      const receiptPath = join(root, `receipt-${stage}.json`);
      prepareIngressPhase(receiptPath, "inserted");
      let settlementCalls = 0;
      const receiptIngress = new OpenCodeNoticeRecipientIngress(
        new DurableOpenCodeNoticeIngressStore(receiptPath, faultOncePersist(stage)),
        authority({
          async recordReceipt() {
            settlementCalls += 1;
            return deliveredClaim;
          },
        }),
      );
      await assert.rejects(() => receiptIngress.recordReceipt(receipt), new RegExp(`injected durable ${stage} fault`));
      assert.equal(settlementCalls, 0, `${stage} must not settle before receipting is committed`);
      assert.equal((await receiptIngress.recordReceipt(receipt)).phase, "delivered");
      assert.equal(settlementCalls, 1, `${stage} retry must settle exactly once after reconciliation`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired persisted reservations remain dormant without an atomic-authority call or prompt callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-expired-"));
  try {
    const path = join(root, "notices.json");
    const expiredClaim: DeliveryClaimRecord = {
      ...claim,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, expiredClaim);
    let authorityCalls = 0;
    let promptCalls = 0;
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async insertOrAttachWhileClaimCurrent() {
        authorityCalls += 1;
        throw new Error("expired claim reached atomic authority");
      },
    }));
    await assert.rejects(
      () => ingress.insertOrAttach(insertion, async () => {
        promptCalls += 1;
        return insertionReceipt();
      }),
      (error: unknown) => error instanceof OpenCodeNoticeCurrentClaimUnavailableError
        && error.code === "OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE"
        && error.retryable
        && /wall-clock expired/.test(error.message),
    );
    assert.equal(authorityCalls, 0);
    assert.equal(promptCalls, 0);
    assert.equal(ingressStorePhase(path), "reserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revoked, superseded, and expired atomic decisions never leave reserved or invoke the prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-no-longer-current-"));
  try {
    for (const status of ["revoked", "superseded", "expired"] as const) {
      const path = join(root, `${status}.json`);
      new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, claim);
      let promptCalls = 0;
      const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
        async insertOrAttachWhileClaimCurrent(request) {
          return {
            version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
            requestNonce: request.requestNonce,
            status,
          } satisfies OpenCodeNoticeAtomicInsertionResult;
        },
      }));
      await assert.rejects(
        () => ingress.insertOrAttach(insertion, async () => {
          promptCalls += 1;
          return insertionReceipt();
        }),
        new RegExp(`authenticated winning claim is ${status}`),
      );
      assert.equal(promptCalls, 0);
      assert.equal(ingressStorePhase(path), "reserved");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained atomic insertion callbacks close after every authority settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-closed-callback-"));
  try {
    const outcomes = ["inserted", "revoked", "superseded", "expired", "rejected", "thenable"] as const;
    for (const outcome of outcomes) {
      const path = join(root, `${outcome}.json`);
      new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, claim);
      let retained: OpenCodeNoticeProtectedInsertion | undefined;
      let settledThenableCallback: Promise<unknown> | undefined;
      let promptCalls = 0;
      const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
        insertOrAttachWhileClaimCurrent(request, insert): Promise<unknown> {
          retained = insert;
          if (outcome === "rejected") return Promise.reject(new Error("authority rejected"));
          const result = atomicInsertionResult(request);
          if (outcome !== "inserted" && outcome !== "thenable") {
            return Promise.resolve({
              version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
              requestNonce: request.requestNonce,
              status: outcome,
            } satisfies OpenCodeNoticeAtomicInsertionResult);
          }
          if (outcome === "thenable") {
            return {
              then(resolve: (value: unknown) => void) {
                resolve(result);
                settledThenableCallback = insert();
              },
            } as Promise<unknown>;
          }
          return Promise.resolve(result);
        },
      }));

      await assert.rejects(
        () => ingress.insertOrAttach(insertion, async () => {
          promptCalls += 1;
          return insertionReceipt();
        }),
      );
      if (settledThenableCallback) {
        await assert.rejects(
          settledThenableCallback,
          (error: unknown) => error instanceof Error && error.message === "FENCING_CALLBACK_CLOSED",
        );
      }
      const retainedCallback = retained;
      assert.ok(retainedCallback);
      await assert.rejects(
        retainedCallback,
        (error: unknown) => error instanceof Error && error.message === "FENCING_CALLBACK_CLOSED",
      );
      assert.equal(promptCalls, 0, `${outcome} retained callback must not invoke the prompt`);
      assert.equal(ingressStorePhase(path), "reserved", `${outcome} retained callback must not begin insertion`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic insertion callback can be invoked only once while its authority call is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-single-callback-"));
  try {
    const path = join(root, "notices.json");
    new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, claim);
    let retained: OpenCodeNoticeProtectedInsertion | undefined;
    let duplicateError: unknown;
    let promptCalls = 0;
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async insertOrAttachWhileClaimCurrent(request, insert) {
        retained = insert;
        const protectedReceipt = await insert();
        try {
          await insert();
        } catch (error) {
          duplicateError = error;
        }
        return atomicInsertionResult(request, protectedReceipt);
      },
    }));

    const inserted = await ingress.insertOrAttach(insertion, async () => {
      promptCalls += 1;
      return insertionReceipt();
    });
    assert.equal(inserted.phase, "inserted");
    assert.equal(promptCalls, 1);
    assert.ok(duplicateError instanceof Error);
    assert.equal(duplicateError.message, "FENCING_CALLBACK_CLOSED");
    const retainedCallback = retained;
    assert.ok(retainedCallback);
    await assert.rejects(
      retainedCallback,
      (error: unknown) => error instanceof Error && error.message === "FENCING_CALLBACK_CLOSED",
    );
    assert.equal(promptCalls, 1);
    assert.equal(ingressStorePhase(path), "inserted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic insertion result keeps the complete current-claim proof exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-current-binding-"));
  try {
    const substitutions: Array<[string, Partial<DeliveryClaimRecord>]> = [
      ["deliveryClaimId", { deliveryClaimId: "claim-superseding" }],
      ["claimGeneration", { claimGeneration: deliveryClaimGeneration(2) }],
      ["recipientSessionId", { recipientSessionId: "intercom-manager-substituted" }],
      ["recipientBindingEpoch", { recipientBindingEpoch: 3 }],
      ["recipientTransferGeneration", { recipientTransferGeneration: recipientTransferGeneration(1) }],
      ["workerGeneration", { workerGeneration: workerGeneration(5) }],
      ["expiresAt", { expiresAt: "2099-07-28T12:11:00.000Z" }],
      ["memberNoticeIds", { memberNoticeIds: ["notice-a"] }],
      ["transitionId", { transitionId: "transition-substituted" }],
    ];
    for (const [field, substitution] of substitutions) {
      const path = join(root, `${field}.json`);
      new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, claim);
      let promptCalls = 0;
      const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
        async insertOrAttachWhileClaimCurrent(request) {
          return atomicInsertionResult(request, insertionReceipt(), { ...claim, ...substitution });
        },
      }));
      await assert.rejects(
        () => ingress.insertOrAttach(insertion, async () => {
          promptCalls += 1;
          return insertionReceipt();
        }),
        /current-claim proof does not exactly match/,
      );
      assert.equal(promptCalls, 0, `${field} substitution must not invoke the prompt`);
      assert.equal(ingressStorePhase(path), "reserved", `${field} substitution must not begin insertion`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("callback-only insertion fails explicitly before side effects when atomic fencing is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-current-unavailable-"));
  try {
    const path = join(root, "notices.json");
    new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, claim);
    const unavailableAuthority = {
      ...authority(),
      insertOrAttachWhileClaimCurrent: undefined,
    } as AuthenticatedOpenCodeNoticeAuthority;
    const recovered = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), unavailableAuthority);
    let promptCalls = 0;
    await assert.rejects(
      () => recovered.insertOrAttach(insertion, async () => {
        promptCalls += 1;
        return insertionReceipt();
      }),
      (error: unknown) => error instanceof OpenCodeNoticeInsertionFencingUnavailableError
        && error.code === INSERTION_FENCING_UNAVAILABLE
        && error.retryable
        && /atomic current-claim\/deadline-bound insertion authority/.test(error.message),
    );
    assert.equal(promptCalls, 0);
    assert.equal(ingressStorePhase(path), "reserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled atomic authority cannot start insertion at the claim deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-stalled-current-"));
  try {
    const path = join(root, "notices.json");
    const expiresAt = "2026-07-28T12:00:02.000Z";
    const shortClaim: DeliveryClaimRecord = { ...claim, expiresAt };
    new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, shortClaim);
    let now = Date.parse("2026-07-28T12:00:01.500Z");
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async insertOrAttachWhileClaimCurrent(_request, insert) {
        now = Date.parse(expiresAt);
        return insert();
      },
    }), () => now);
    let promptCalls = 0;
    await assert.rejects(
      () => ingress.insertOrAttach(insertion, async () => {
        promptCalls += 1;
        return insertionReceipt();
      }),
      /wall-clock expired/,
    );
    assert.equal(promptCalls, 0);
    assert.equal(ingressStorePhase(path), "reserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late and forged atomic insertion receipts are never durably accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-forged-receipts-"));
  try {
    const cases = [
      ["late", { ...insertionReceipt(), insertedAt: claim.expiresAt }, /not strictly before/],
      ["claim-id", { ...insertionReceipt(), deliveryClaimId: "claim-forged" }, /deliveryClaimId does not match/],
      ["generation", { ...insertionReceipt(), claimGeneration: deliveryClaimGeneration(2) }, /claimGeneration does not match/],
    ] as const;
    for (const [name, forgedReceipt, expected] of cases) {
      const path = join(root, `${name}.json`);
      new DurableOpenCodeNoticeIngressStore(path).reserve(reserve, claim);
      let promptCalls = 0;
      const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
        async insertOrAttachWhileClaimCurrent(request) {
          return atomicInsertionResult(request, forgedReceipt);
        },
      }));
      await assert.rejects(
        () => ingress.insertOrAttach(insertion, async () => {
          promptCalls += 1;
          return insertionReceipt();
        }),
        expected,
      );
      assert.equal(promptCalls, 0, `${name} forged authority response must not invoke the callback`);
      assert.equal(ingressStorePhase(path), "reserved");
    }

    const recoveryPath = join(root, "late-recovery.json");
    const recoveryStore = new DurableOpenCodeNoticeIngressStore(recoveryPath);
    recoveryStore.reserve(reserve, claim);
    recoveryStore.beginInsertion(insertion);
    assert.throws(
      () => recoveryStore.markInserted(claim.deliveryClaimId, {
        ...insertionReceipt(),
        insertedAt: claim.expiresAt,
      }),
      /not strictly before/,
    );
    assert.equal(recoveryStore.get(claim.deliveryClaimId)?.phase, "inserting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash after prompt API recovers from authenticated target ledger without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-recover-"));
  try {
    const path = join(root, "notices.json");
    const first = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority());
    await first.reserveBeforePrompt(reserve);
    await assert.rejects(() => first.insertOrAttach(insertion, async () => {
      throw new Error("crash after API");
    }), /crash after API/);
    assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, "inserting");

    let reinjected = false;
    let lookupOperation = "";
    const recovered = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async lookupTargetLedger(lookup): Promise<TargetLedgerLookupResult> {
        lookupOperation = lookup.operation;
        const checkedAt = (lookup.payload as Record<string, unknown>).checkedAt as string;
        return {
          version: TARGET_LEDGER_RESULT_VERSION,
          deliveryClaimId: claim.deliveryClaimId,
          claimGeneration: claim.claimGeneration,
          state: "inserted",
          checkedAt,
          targetLedgerEntryId: "ledger-a",
          insertedAt: checkedAt,
        };
      },
    }));
    const result = await recovered.insertOrAttach(insertion, async () => {
      reinjected = true;
      return insertionReceipt();
    });
    assert.equal(lookupOperation, "lookup_target_ledger");
    assert.equal(reinjected, false);
    assert.equal(result.phase, "inserted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous or absent target ledger fails closed without authenticated drain/reissue authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-lookup-"));
  try {
    const path = join(root, "notices.json");
    const first = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority());
    await first.reserveBeforePrompt(reserve);
    await assert.rejects(() => first.insertOrAttach(insertion, async () => {
      throw new Error("api interrupted");
    }), /api interrupted/);

    let invoked = false;
    const ambiguous = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async lookupTargetLedger(lookup): Promise<TargetLedgerLookupResult> {
        return {
          version: TARGET_LEDGER_RESULT_VERSION,
          deliveryClaimId: claim.deliveryClaimId,
          claimGeneration: claim.claimGeneration,
          state: "ambiguous",
          checkedAt: (lookup.payload as Record<string, unknown>).checkedAt as string,
        };
      },
    }));
    await assert.rejects(() => ambiguous.insertOrAttach(insertion, async () => {
      invoked = true;
      return insertionReceipt();
    }), /refusing ambiguous OpenCode replay/);
    assert.equal(invoked, false);

    const absent = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority());
    await assert.rejects(() => absent.insertOrAttach(insertion, async () => {
      invoked = true;
      return insertionReceipt();
    }), /target-drained proof.*generation-incremented.*unavailable/);
    assert.equal(invoked, false);
    assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, "inserting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash recovery rejects stale claim-generation ledger evidence without reinjection", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-stale-ledger-"));
  try {
    const path = join(root, "notices.json");
    const first = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority());
    await first.reserveBeforePrompt(reserve);
    await assert.rejects(() => first.insertOrAttach(insertion, async () => {
      throw new Error("api interrupted");
    }), /api interrupted/);

    let reinjected = false;
    const stale = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async lookupTargetLedger(lookup): Promise<TargetLedgerLookupResult> {
        return {
          version: TARGET_LEDGER_RESULT_VERSION,
          deliveryClaimId: claim.deliveryClaimId,
          claimGeneration: deliveryClaimGeneration(2),
          state: "absent",
          checkedAt: (lookup.payload as Record<string, unknown>).checkedAt as string,
        };
      },
    }));
    await assert.rejects(() => stale.insertOrAttach(insertion, async () => {
      reinjected = true;
      return insertionReceipt();
    }), /claimGeneration does not match the winning claim/);
    assert.equal(reinjected, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt crash remains receipting and idempotently settles after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-receipt-"));
  try {
    const path = join(root, "notices.json");
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority({
      async recordReceipt() {
        throw new Error("receipt response lost");
      },
    }));
    await ingress.reserveBeforePrompt(reserve);
    await ingress.insertOrAttach(insertion, async () => insertionReceipt());
    await assert.rejects(() => ingress.recordReceipt(receipt), /receipt response lost/);
    assert.equal(new DurableOpenCodeNoticeIngressStore(path).get(claim.deliveryClaimId)?.phase, "receipting");

    const recovered = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority());
    assert.equal((await recovered.recordReceipt(receipt)).phase, "delivered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inserted and receipt replays require the exact persisted envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-replay-"));
  try {
    const path = join(root, "notices.json");
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(path), authority());
    await ingress.reserveBeforePrompt(reserve);
    await ingress.insertOrAttach(insertion, async () => insertionReceipt());
    await assert.rejects(
      () => ingress.insertOrAttach({ ...insertion, requestId: "substituted-request" }, async () => insertionReceipt()),
      /Conflicting OpenCode notice insertion replay/,
    );
    await ingress.recordReceipt(receipt);
    await assert.rejects(
      () => ingress.recordReceipt({ ...receipt, idempotencyKey: "substituted-idempotency" }),
      /Conflicting OpenCode notice receipt replay/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state load revalidates cross-record claim and transition correlation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-cross-record-"));
  try {
    const path = join(root, "notices.json");
    const store = new DurableOpenCodeNoticeIngressStore(path);
    store.reserve(reserve, claim);
    store.beginInsertion(insertion);
    const state = JSON.parse(await readFile(path, "utf8"));
    state.records[claim.deliveryClaimId].claim.transitionId = "substituted-transition";
    await writeFile(path, JSON.stringify(state));
    assert.throws(
      () => new DurableOpenCodeNoticeIngressStore(path),
      /transitionIds do not exactly match the winning claim transition/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("arbitrary delivery claim IDs survive exact-own durable JSON round trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-record-keys-"));
  try {
    const path = join(root, "notices.json");
    const specialKeys = ["__proto__", "constructor", "toString"] as const;
    const store = new DurableOpenCodeNoticeIngressStore(path);
    for (const [index, deliveryClaimId] of specialKeys.entries()) {
      const deliveryGroupId = `special-group-${index}`;
      const transitionId = `special-transition-${index}`;
      store.reserve(
        envelope("reserve_delivery", {
          ...(reserve.payload as object),
          deliveryGroupId,
        }),
        {
          ...claim,
          deliveryClaimId,
          deliveryGroupId,
          transitionId,
        },
      );
    }

    const persisted = JSON.parse(await readFile(path, "utf8"));
    for (const deliveryClaimId of specialKeys) {
      assert.equal(Object.hasOwn(persisted.records, deliveryClaimId), true);
      assert.equal(store.get(deliveryClaimId)?.claim.deliveryClaimId, deliveryClaimId);
    }
    assert.equal(store.get("valueOf"), undefined, "inherited names must not resolve as records");

    const reloaded = new DurableOpenCodeNoticeIngressStore(path);
    for (const [index, deliveryClaimId] of specialKeys.entries()) {
      const deliveryGroupId = `special-group-${index}`;
      const transitionId = `special-transition-${index}`;
      const begun = reloaded.beginInsertion(envelope("insert_or_attach", {
        ...(insertion.payload as object),
        deliveryClaimId,
        deliveryGroupId,
        transitionIds: [transitionId],
      }));
      assert.equal(begun.claim.deliveryClaimId, deliveryClaimId);
      assert.equal(begun.phase, "inserting");
    }
    const roundTripped = new DurableOpenCodeNoticeIngressStore(path);
    for (const deliveryClaimId of specialKeys) {
      assert.equal(roundTripped.get(deliveryClaimId)?.phase, "inserting");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notice ingress poisons every public operation when reconciliation finds a missing, corrupt, or foreign target", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-poison-fallbacks-"));
  try {
    for (const fallback of ["missing", "corrupt", "foreign"] as const) {
      const path = join(root, `${fallback}.json`);
      prepareIngressPhase(path, "reserved");
      let persistCalls = 0;
      const store = new DurableOpenCodeNoticeIngressStore(path, (target) => {
        persistCalls += 1;
        if (fallback === "missing") {
          rmSync(target, { force: true });
        } else if (fallback === "corrupt") {
          writeFileSync(target, "{corrupt", "utf8");
        } else {
          writeDurableJson(target, { version: 1, records: {} });
        }
        throw new Error(`injected ${fallback} target persist fault`);
      });

      assert.throws(
        () => store.beginInsertion(insertion),
        new RegExp(`injected ${fallback} target persist fault`),
      );
      const targetAfterPoison = existsSync(path) ? await readFile(path, "utf8") : undefined;
      let poisonError: unknown;
      assert.throws(
        () => store.get(claim.deliveryClaimId),
        (error: unknown) => {
          poisonError = error;
          return error instanceof Error
            && /Durable OpenCode notice ingress store is unavailable after commit reconciliation failed/.test(error.message);
        },
      );
      const publicOperations: Array<() => unknown> = [
        () => store.get(claim.deliveryClaimId),
        () => store.reserve(reserve, claim),
        () => store.beginInsertion(insertion),
        () => store.markInserted(claim.deliveryClaimId, insertionReceipt()),
        () => store.beginReceipt(receipt),
        () => store.markDelivered(claim.deliveryClaimId, deliveredClaim),
        () => store.pending(),
      ];
      for (const operation of publicOperations) {
        assert.throws(
          operation,
          (error: unknown) => error === poisonError,
          `${fallback} reconciliation must fail closed with one deterministic poison error`,
        );
      }
      assert.equal(persistCalls, 1, `${fallback} poison must prevent further persistence attempts`);
      assert.equal(
        existsSync(path) ? await readFile(path, "utf8") : undefined,
        targetAfterPoison,
        `${fallback} target must remain untouched after poison`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notice state paths hash the exact session ID instead of lossy sanitization", () => {
  assert.notEqual(
    getOpenCodeNoticeIngressStatePath("Manager/A", "/tmp/intercom"),
    getOpenCodeNoticeIngressStatePath("Manager-A", "/tmp/intercom"),
  );
  assert.equal(getOpenCodeNoticeIngressStatePath("Manager/A", "/tmp/intercom"), getOpenCodeNoticeIngressStatePath("Manager/A", "/tmp/intercom"));
});

test("OpenCode ingress refuses insertion without a winning claim or authenticated authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-unreserved-"));
  try {
    assert.throws(
      () => new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(join(root, "missing-authority.json")), undefined as never),
      /Authenticated notice authority API is required/,
    );
    const ingress = new OpenCodeNoticeRecipientIngress(new DurableOpenCodeNoticeIngressStore(join(root, "notices.json")), authority());
    let invoked = false;
    await assert.rejects(() => ingress.insertOrAttach(insertion, async () => {
      invoked = true;
      return insertionReceipt();
    }), /no durable winning reservation/);
    assert.equal(invoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production notice ingress is explicitly unavailable without the protected authority API", () => {
  assert.throws(createProductionOpenCodeNoticeRecipientIngress, (error: unknown) => {
    return error instanceof Error
      && "code" in error
      && error.code === "OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE";
  });
});

test("OpenCode notice ingress state fails closed on unknown versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-version-"));
  try {
    const path = join(root, "notices.json");
    await writeFile(path, JSON.stringify({ version: 2, records: {} }));
    assert.throws(() => new DurableOpenCodeNoticeIngressStore(path), /Unsupported OpenCode notice ingress state version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ingress contracts reject accessor, proxy, sparse, and inexact boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-notice-boundaries-"));
  try {
    const store = new DurableOpenCodeNoticeIngressStore(join(root, "notices.json"));
    let getterCalls = 0;
    const accessorEnvelope = { ...reserve } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, "operation", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "reserve_delivery";
      },
    });
    assert.throws(() => store.reserve(accessorEnvelope, claim), /enumerable data property/);
    assert.equal(getterCalls, 0);

    const sparseMembers = ["notice-a", "notice-b"];
    delete sparseMembers[1];
    assert.throws(
      () => store.reserve({ ...reserve, payload: { ...(reserve.payload as object), memberNoticeIds: sparseMembers } }, claim),
      /sparse array holes/,
    );
    assert.throws(
      () => store.reserve({ ...reserve, unsupported: true } as never, claim),
      /unsupported.*not supported|unsupported/,
    );
    assert.throws(
      () => store.reserve(new Proxy({}, { ownKeys() { throw new Error("proxy rejected"); } }), claim),
      /proxy rejected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
