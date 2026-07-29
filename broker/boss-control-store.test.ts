import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { participantBindingEpoch } from "@dataforxyz/agent-intercom-core/canonical";
import {
  DURABLE_JSON_FILE_OPERATIONS,
  writeDurableJson,
  type DurableJsonFileOperations,
} from "../durable-json.ts";
import {
  bossControlFingerprint,
  bossControlReplayFrames,
  DurableBossControlStore,
  type DurableBossControlRecord,
} from "./boss-control-store.ts";

const envelope = {
  type: "boss.assignment.submitted" as const,
  version: 1 as const,
  messageId: "control-message-a",
  bossRunId: "run-a",
  participantId: "worker-a",
  bindingEpoch: participantBindingEpoch(2),
  causationId: "assignment-a",
  replyTo: "control-message-parent",
  idempotencyKey: "assignment-a:submission:1",
  payload: { assignmentId: "assignment-a", outcome: "complete" },
};

function accepted(overrides: Partial<DurableBossControlRecord> = {}): DurableBossControlRecord {
  return {
    senderSessionId: "worker-session-a",
    bossRunId: envelope.bossRunId,
    participantId: envelope.participantId,
    senderBindingEpoch: envelope.bindingEpoch,
    idempotencyKey: envelope.idempotencyKey,
    targetSessionId: "manager-session-a",
    targetBindingEpoch: participantBindingEpoch(4),
    controlKind: "assignment_response",
    envelope,
    fingerprint: bossControlFingerprint("manager-session-a", envelope),
    deliveryId: "delivery-a",
    state: "accepted",
    acceptedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

type DurableFaultStage = "write" | "fsync" | "rename" | "restrict" | "directory-fsync";

function faultingPersist(stage: DurableFaultStage): (path: string, state: unknown) => void {
  return (path, state) => {
    let fsyncCalls = 0;
    const operations: DurableJsonFileOperations = {
      ...DURABLE_JSON_FILE_OPERATIONS,
      writeFile(filePath, contents, options) {
        if (stage === "write") throw new Error("injected durable write fault");
        DURABLE_JSON_FILE_OPERATIONS.writeFile(filePath, contents, options);
      },
      fsync(fileDescriptor) {
        fsyncCalls += 1;
        if (stage === "fsync" && fsyncCalls === 1) throw new Error("injected durable fsync fault");
        if (stage === "directory-fsync" && fsyncCalls === 2) {
          throw new Error("injected durable directory-fsync fault");
        }
        DURABLE_JSON_FILE_OPERATIONS.fsync(fileDescriptor);
      },
      rename(from, to) {
        if (stage === "rename") throw new Error("injected durable rename fault");
        DURABLE_JSON_FILE_OPERATIONS.rename(from, to);
      },
      restrict(filePath) {
        if (stage === "restrict") throw new Error("injected durable restrict fault");
        DURABLE_JSON_FILE_OPERATIONS.restrict(filePath);
      },
    };
    writeDurableJson(path, state, operations);
  };
}

test("Boss control acceptance and delivery survive broker-process restarts with one delivery ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-store-"));
  try {
    const path = join(root, "controls.json");
    const first = new DurableBossControlStore(path);
    assert.equal(first.reserve(accepted()).created, true);
    assert.equal(new DurableBossControlStore(path).get(accepted())?.state, "accepted");

    const delivered = new DurableBossControlStore(path).markDelivered(accepted(), "delivery-a", "2026-07-28T12:00:01.000Z");
    assert.equal(delivered.deliveryId, "delivery-a");
    assert.equal(delivered.state, "delivered");
    assert.deepEqual(new DurableBossControlStore(path).get(accepted()), delivered);
    assert.deepEqual(bossControlReplayFrames(delivered, "control-message-retry"), [
      {
        type: "boss_control_accepted",
        messageId: "control-message-retry",
        deliveryId: "delivery-a",
      },
      {
        type: "boss_control_delivered",
        messageId: "control-message-retry",
        deliveryId: "delivery-a",
      },
    ]);
    assert.throws(
      () => new DurableBossControlStore(path).markRejected(accepted(), "delivery-a", "DELIVERY_TIMEOUT", "late timeout"),
      /delivered Boss control cannot become rejected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control idempotency excludes transport messageId and replays to the new request", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-idempotency-"));
  try {
    const path = join(root, "controls.json");
    const store = new DurableBossControlStore(path);
    store.reserve(accepted());
    assert.equal(store.reserve({ ...accepted(), deliveryId: "ignored-retry-id" }).record.deliveryId, "delivery-a");

    const substitutedEnvelope = { ...envelope, messageId: "substituted-message" };
    const replay = store.reserve(accepted({
      envelope: substitutedEnvelope,
      fingerprint: bossControlFingerprint("manager-session-a", substitutedEnvelope),
      deliveryId: "ignored-new-request-delivery",
    }));
    assert.equal(replay.created, false);
    assert.equal(replay.record.deliveryId, "delivery-a");
    assert.equal(replay.record.envelope.messageId, envelope.messageId);
    assert.equal(
      bossControlFingerprint("manager-session-a", envelope),
      bossControlFingerprint("manager-session-a", substitutedEnvelope),
    );

    const reorderedEnvelope = {
      payload: envelope.payload,
      idempotencyKey: envelope.idempotencyKey,
      replyTo: envelope.replyTo,
      causationId: envelope.causationId,
      bindingEpoch: envelope.bindingEpoch,
      participantId: envelope.participantId,
      bossRunId: envelope.bossRunId,
      messageId: "property-order-replay",
      version: envelope.version,
      type: envelope.type,
    };
    assert.equal(
      bossControlFingerprint("manager-session-a", envelope),
      bossControlFingerprint("manager-session-a", reorderedEnvelope),
    );

    const conflictingEnvelope = {
      ...substitutedEnvelope,
      payload: { assignmentId: "assignment-a", outcome: "different" },
    };
    assert.throws(() => store.reserve(accepted({
      envelope: conflictingEnvelope,
      fingerprint: bossControlFingerprint("manager-session-a", conflictingEnvelope),
    })), /Conflicting Boss control idempotency replay/);

    const reboundEnvelope = { ...envelope, bindingEpoch: participantBindingEpoch(3) };
    const nextBinding = accepted({
      senderBindingEpoch: participantBindingEpoch(3),
      envelope: reboundEnvelope,
      fingerprint: bossControlFingerprint("manager-session-a", reboundEnvelope),
      deliveryId: "delivery-new-binding",
    });
    assert.equal(store.reserve(nextBinding).created, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control rejections persist and corrupt cross-record identity fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-failure-"));
  try {
    const path = join(root, "controls.json");
    const store = new DurableBossControlStore(path);
    store.reserve(accepted());
    const failed = store.markRejected(accepted(), "delivery-a", "DELIVERY_TIMEOUT", "recipient timeout", "2026-07-28T12:00:08.000Z");
    assert.equal(failed.state, "rejected");
    assert.equal(new DurableBossControlStore(path).get(accepted())?.failureCode, "DELIVERY_TIMEOUT");

    assert.deepEqual(bossControlReplayFrames(failed, "new-request-message"), [
      {
        type: "boss_control_accepted",
        messageId: "new-request-message",
        deliveryId: "delivery-a",
      },
      {
        type: "boss_control_failed",
        messageId: "new-request-message",
        deliveryId: "delivery-a",
        accepted: true,
        code: "DELIVERY_TIMEOUT",
        reason: "recipient timeout",
      },
    ]);

    const state = JSON.parse(await readFile(path, "utf8"));
    const [scope] = Object.keys(state.records);
    state.records[scope].participantId = "substituted-worker";
    await writeFile(path, JSON.stringify(state));
    assert.throws(() => new DurableBossControlStore(path), /identity does not match its envelope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control durable records require exact plain data boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-boundaries-"));
  try {
    const store = new DurableBossControlStore(join(root, "controls.json"));
    let getterCalls = 0;
    const accessor = { ...accepted() } as Record<string, unknown>;
    Object.defineProperty(accessor, "targetSessionId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "manager-session-a";
      },
    });
    assert.throws(() => store.reserve(accessor as unknown as DurableBossControlRecord), /enumerable data property/);
    assert.equal(getterCalls, 0);
    assert.throws(() => store.reserve({ ...accepted(), unsupported: true } as never), /not supported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control reserve publishes no live or replayable acceptance after write, fsync, or rename faults", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-reserve-faults-"));
  try {
    for (const stage of ["write", "fsync", "rename"] as const) {
      const path = join(root, `${stage}.json`);
      const store = new DurableBossControlStore(path, faultingPersist(stage));
      assert.throws(() => store.reserve(accepted()), new RegExp(`injected durable ${stage} fault`));
      assert.throws(
        () => store.get(accepted()),
        /Durable Boss control store is unavailable after commit reconciliation failed/,
        `${stage} fault with a missing exact target must poison the live store`,
      );
      assert.equal(
        new DurableBossControlStore(path).get(accepted()),
        undefined,
        `${stage} fault must not leave replayable acceptance`,
      );
      assert.equal(new DurableBossControlStore(path).reserve(accepted()).created, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control terminal mutations stay accepted after write, fsync, or rename faults", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-terminal-faults-"));
  try {
    for (const terminal of ["delivered", "rejected"] as const) {
      for (const stage of ["write", "fsync", "rename"] as const) {
        const path = join(root, `${terminal}-${stage}.json`);
        new DurableBossControlStore(path).reserve(accepted());
        const store = new DurableBossControlStore(path, faultingPersist(stage));
        const mutate = terminal === "delivered"
          ? () => store.markDelivered(accepted(), "delivery-a", "2026-07-28T12:00:01.000Z")
          : () => store.markRejected(
            accepted(),
            "delivery-a",
            "DELIVERY_TIMEOUT",
            "recipient timeout",
            "2026-07-28T12:00:08.000Z",
          );
        assert.throws(mutate, new RegExp(`injected durable ${stage} fault`));

        const live = store.get(accepted());
        const replayed = new DurableBossControlStore(path).get(accepted());
        assert.equal(live?.state, "accepted", `${terminal}/${stage} fault must preserve live accepted state`);
        assert.equal(replayed?.state, "accepted", `${terminal}/${stage} fault must preserve durable accepted state`);
        assert.deepEqual(bossControlReplayFrames(replayed!, "replay-after-fault"), [{
          type: "boss_control_accepted",
          messageId: "replay-after-fault",
          deliveryId: "delivery-a",
        }]);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control reserve reconciles the committed target after restrict or directory fsync faults", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-reserve-post-rename-faults-"));
  try {
    for (const stage of ["restrict", "directory-fsync"] as const) {
      const path = join(root, `${stage}.json`);
      const store = new DurableBossControlStore(path, faultingPersist(stage));
      assert.throws(() => store.reserve(accepted()), new RegExp(`injected durable ${stage} fault`));

      const live = store.get(accepted());
      assert.equal(live?.deliveryId, "delivery-a", `${stage} fault must reconcile the renamed acceptance`);
      assert.equal(live?.state, "accepted");

      const retry = store.reserve(accepted({ deliveryId: "conflicting-delivery-id" }));
      assert.equal(retry.created, false, `${stage} retry must not create a second reservation`);
      assert.equal(retry.record.deliveryId, "delivery-a");

      const conflictingEnvelope = {
        ...envelope,
        payload: { assignmentId: "assignment-a", outcome: "conflicting" },
      };
      assert.throws(() => store.reserve(accepted({
        envelope: conflictingEnvelope,
        fingerprint: bossControlFingerprint("manager-session-a", conflictingEnvelope),
      })), /Conflicting Boss control idempotency replay/);

      assert.deepEqual(new DurableBossControlStore(path).get(accepted()), live);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control terminal mutations reconcile without stale replay after restrict or directory fsync faults", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-terminal-post-rename-faults-"));
  try {
    for (const terminal of ["delivered", "rejected"] as const) {
      for (const stage of ["restrict", "directory-fsync"] as const) {
        const path = join(root, `${terminal}-${stage}.json`);
        new DurableBossControlStore(path).reserve(accepted());
        const store = new DurableBossControlStore(path, faultingPersist(stage));
        const mutate = terminal === "delivered"
          ? () => store.markDelivered(accepted(), "delivery-a", "2026-07-28T12:00:01.000Z")
          : () => store.markRejected(
            accepted(),
            "delivery-a",
            "DELIVERY_TIMEOUT",
            "recipient timeout",
            "2026-07-28T12:00:08.000Z",
          );
        assert.throws(mutate, new RegExp(`injected durable ${stage} fault`));

        const live = store.get(accepted());
        assert.equal(live?.state, terminal, `${terminal}/${stage} fault must reconcile the renamed terminal state`);
        assert.deepEqual(bossControlReplayFrames(live!, "same-process-replay"), terminal === "delivered"
          ? [
            { type: "boss_control_accepted", messageId: "same-process-replay", deliveryId: "delivery-a" },
            { type: "boss_control_delivered", messageId: "same-process-replay", deliveryId: "delivery-a" },
          ]
          : [
            { type: "boss_control_accepted", messageId: "same-process-replay", deliveryId: "delivery-a" },
            {
              type: "boss_control_failed",
              messageId: "same-process-replay",
              deliveryId: "delivery-a",
              accepted: true,
              code: "DELIVERY_TIMEOUT",
              reason: "recipient timeout",
            },
          ]);
        if (terminal === "delivered") {
          assert.throws(
            () => store.markRejected(accepted(), "delivery-a", "DELIVERY_TIMEOUT", "stale timeout"),
            /delivered Boss control cannot become rejected/,
          );
        } else {
          assert.throws(
            () => store.markDelivered(accepted(), "delivery-a"),
            /rejected Boss control cannot become delivered/,
          );
        }

        const replayed = new DurableBossControlStore(path).get(accepted());
        assert.deepEqual(replayed, live, `${terminal}/${stage} restart must load the valid committed state`);
        assert.deepEqual(
          bossControlReplayFrames(replayed!, "restart-replay"),
          bossControlReplayFrames(live!, "restart-replay"),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control store never publishes the mutable state exposed to its persister", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-persist-alias-"));
  try {
    const path = join(root, "controls.json");
    let retained: { records: Record<string, unknown> } | undefined;
    const store = new DurableBossControlStore(path, (target, state) => {
      writeDurableJson(target, state);
      retained = state;
      state.records = {};
    });

    store.reserve(accepted());
    assert.equal(store.get(accepted())?.state, "accepted");
    assert.equal(new DurableBossControlStore(path).get(accepted())?.state, "accepted");

    retained!.records = {};
    assert.equal(store.get(accepted())?.state, "accepted");
    assert.equal(new DurableBossControlStore(path).get(accepted())?.state, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control store reconciles exceptions against pre-callback prior and staged snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-persist-snapshots-"));
  try {
    for (const durableTarget of ["prior", "staged"] as const) {
      const path = join(root, `${durableTarget}.json`);
      let call = 0;
      let retainedPrior: { records: Record<string, unknown> } | undefined;
      let retainedStaged: { records: Record<string, unknown> } | undefined;
      const store = new DurableBossControlStore(path, (target, state) => {
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

      store.reserve(accepted());
      assert.throws(
        () => store.markDelivered(accepted(), "delivery-a", "2026-07-28T12:00:01.000Z"),
        new RegExp(`injected ${durableTarget} exception after mutation`),
      );
      const expectedState = durableTarget === "staged" ? "delivered" : "accepted";
      assert.equal(store.get(accepted())?.state, expectedState);
      assert.equal(new DurableBossControlStore(path).get(accepted())?.state, expectedState);

      retainedPrior!.records = {};
      retainedStaged!.records = {};
      assert.equal(store.get(accepted())?.state, expectedState);
      assert.equal(new DurableBossControlStore(path).get(accepted())?.state, expectedState);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss control store poisons after persist exceptions reload missing, corrupt, or foreign targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-control-poison-fallbacks-"));
  try {
    for (const fallback of ["missing", "corrupt", "foreign"] as const) {
      const path = join(root, `${fallback}.json`);
      new DurableBossControlStore(path).reserve(accepted());
      let persistCalls = 0;
      const store = new DurableBossControlStore(path, (target, staged) => {
        persistCalls += 1;
        if (fallback === "missing") {
          rmSync(target, { force: true });
        } else if (fallback === "corrupt") {
          writeFileSync(target, "{corrupt", "utf8");
        } else {
          const foreign = structuredClone(staged) as {
            records: Record<string, DurableBossControlRecord>;
          };
          const [record] = Object.values(foreign.records);
          assert(record);
          record.deliveredAt = "2026-07-28T12:00:02.000Z";
          writeDurableJson(target, foreign);
        }
        throw new Error(`injected ${fallback} target persist fault`);
      });

      assert.throws(
        () => store.markDelivered(accepted(), "delivery-a", "2026-07-28T12:00:01.000Z"),
        new RegExp(`injected ${fallback} target persist fault`),
      );
      const targetAfterPoison = existsSync(path) ? await readFile(path, "utf8") : undefined;
      const poisoned = /Durable Boss control store is unavailable after commit reconciliation failed/;
      assert.throws(() => store.get(accepted()), poisoned, `${fallback} target must not replay through get`);
      assert.throws(
        () => store.reserve(accepted({ deliveryId: "replay-after-poison" })),
        poisoned,
        `${fallback} target must not replay through reserve`,
      );

      const nextEnvelope = { ...envelope, bindingEpoch: participantBindingEpoch(3) };
      assert.throws(
        () => store.reserve(accepted({
          senderBindingEpoch: nextEnvelope.bindingEpoch,
          envelope: nextEnvelope,
          fingerprint: bossControlFingerprint("manager-session-a", nextEnvelope),
          deliveryId: "new-reservation-after-poison",
        })),
        poisoned,
        `${fallback} target must not accept a new reservation`,
      );
      assert.throws(
        () => store.markDelivered(accepted(), "delivery-a", "2026-07-28T12:00:03.000Z"),
        poisoned,
        `${fallback} target must not record delivery`,
      );
      assert.throws(
        () => store.markRejected(
          accepted(),
          "delivery-a",
          "DELIVERY_TIMEOUT",
          "recipient timeout",
          "2026-07-28T12:00:04.000Z",
        ),
        poisoned,
        `${fallback} target must not record rejection`,
      );

      assert.equal(persistCalls, 1, `${fallback} target must not be persisted again after poison`);
      assert.equal(
        existsSync(path) ? await readFile(path, "utf8") : undefined,
        targetAfterPoison,
        `${fallback} target must remain unchanged after poison`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
