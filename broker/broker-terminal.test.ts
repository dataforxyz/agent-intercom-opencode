import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
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
  bossControlIdempotencyScope,
  DurableBossControlStore,
  type BossControlTerminalFailureCode,
  type DurableBossControlRecord,
} from "./boss-control-store.ts";
import { IntercomBroker } from "./broker.ts";

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

function accepted(): DurableBossControlRecord {
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
  };
}

type PostRenameFaultStage = "restrict" | "directory-fsync";

function faultingPersist(stage: PostRenameFaultStage): (path: string, state: unknown) => void {
  return (path, state) => {
    let fsyncCalls = 0;
    const operations: DurableJsonFileOperations = {
      ...DURABLE_JSON_FILE_OPERATIONS,
      fsync(fileDescriptor) {
        fsyncCalls += 1;
        if (stage === "directory-fsync" && fsyncCalls === 2) {
          throw new Error("injected durable directory-fsync fault");
        }
        DURABLE_JSON_FILE_OPERATIONS.fsync(fileDescriptor);
      },
      restrict(filePath) {
        if (stage === "restrict") throw new Error("injected durable restrict fault");
        DURABLE_JSON_FILE_OPERATIONS.restrict(filePath);
      },
    };
    writeDurableJson(path, state, operations);
  };
}

function capturingSocket(frames: unknown[]): Socket {
  return {
    write(data: Uint8Array) {
      const frame = Buffer.from(data);
      const length = frame.readUInt32BE(0);
      frames.push(JSON.parse(frame.subarray(4, 4 + length).toString("utf8")));
      return true;
    },
  } as unknown as Socket;
}

interface PendingHarness {
  id: string;
  key: string;
  fingerprint: string;
  envelope: typeof envelope;
  controlKind: "assignment_response";
  from: string;
  to: string;
  requesters: Map<string, Socket>;
  recipientSocket: Socket;
  fromBindingEpoch: ReturnType<typeof participantBindingEpoch>;
  toBindingEpoch: ReturnType<typeof participantBindingEpoch>;
  timeout: NodeJS.Timeout;
}

interface BrokerTerminalHarness {
  pendingBossControls: Map<string, PendingHarness>;
  pendingBossControlKeys: Map<string, string>;
  sessions: Map<string, { socket: Socket }>;
  bossControlStoreInstance: DurableBossControlStore;
  isBossControlAuthorized: () => boolean;
  failDurableBossControl(
    record: DurableBossControlRecord,
    code: BossControlTerminalFailureCode,
    reason: string,
    senderSocket?: Socket,
    requestMessageId?: string,
  ): void;
  acknowledgePendingBossControl(deliveryId: string, sessionId: string, socket: Socket): void;
  failPendingBossControl(deliveryId: string, code: BossControlTerminalFailureCode, reason: string): void;
  clearPendingBossControlsForSession(sessionId: string, socket: Socket): void;
}

function brokerHarness(store: DurableBossControlStore, authorized: boolean): {
  broker: BrokerTerminalHarness;
  frames: unknown[];
  recipientSocket: Socket;
} {
  const frames: unknown[] = [];
  const senderSocket = capturingSocket(frames);
  const recipientSocket = capturingSocket([]);
  const record = accepted();
  const key = bossControlIdempotencyScope(record);
  const timeout = setTimeout(() => {}, 60_000);
  timeout.unref?.();
  const pending: PendingHarness = {
    id: record.deliveryId,
    key,
    fingerprint: record.fingerprint,
    envelope,
    controlKind: record.controlKind,
    from: record.senderSessionId,
    to: record.targetSessionId,
    requesters: new Map([[record.envelope.messageId, senderSocket]]),
    recipientSocket,
    fromBindingEpoch: record.senderBindingEpoch,
    toBindingEpoch: record.targetBindingEpoch,
    timeout,
  };
  const broker = Object.create(IntercomBroker.prototype) as BrokerTerminalHarness;
  broker.pendingBossControls = new Map([[record.deliveryId, pending]]);
  broker.pendingBossControlKeys = new Map([[key, record.deliveryId]]);
  broker.sessions = new Map([[record.senderSessionId, { socket: senderSocket }]]);
  broker.bossControlStoreInstance = store;
  broker.isBossControlAuthorized = () => authorized;
  return { broker, frames, recipientSocket };
}

const TERMINAL_CASES = [
  { name: "ack", authorized: true, state: "delivered" as const },
  { name: "reject", authorized: true, state: "rejected" as const, code: "RECIPIENT_DISCONNECTED" as const },
  { name: "timeout", authorized: true, state: "rejected" as const, code: "DELIVERY_TIMEOUT" as const },
  { name: "close", authorized: true, state: "rejected" as const, code: "RECIPIENT_DISCONNECTED" as const },
];

test("Boss broker contains post-rename terminal faults across ack, reject, timeout, and close callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-broker-terminal-faults-"));
  const originalConsoleError = console.error;
  const containedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    containedErrors.push(args);
  };
  try {
    for (const stage of ["restrict", "directory-fsync"] as const) {
      for (const terminalCase of TERMINAL_CASES) {
        const path = join(root, `${terminalCase.name}-${stage}.json`);
        new DurableBossControlStore(path).reserve(accepted());
        const store = new DurableBossControlStore(path, faultingPersist(stage));
        const { broker, frames, recipientSocket } = brokerHarness(store, terminalCase.authorized);

        assert.doesNotThrow(() => {
          if (terminalCase.name === "ack") {
            broker.acknowledgePendingBossControl("delivery-a", "manager-session-a", recipientSocket);
          } else if (terminalCase.name === "reject") {
            clearTimeout(broker.pendingBossControls.get("delivery-a")!.timeout);
            broker.pendingBossControls.clear();
            broker.pendingBossControlKeys.clear();
            broker.failDurableBossControl(
              accepted(),
              "RECIPIENT_DISCONNECTED",
              "The exact accepted Boss control target is unavailable",
            );
          } else if (terminalCase.name === "timeout") {
            broker.failPendingBossControl("delivery-a", "DELIVERY_TIMEOUT", "Recipient acknowledgement timed out");
          } else {
            broker.clearPendingBossControlsForSession("manager-session-a", recipientSocket);
          }
        }, `${terminalCase.name}/${stage} callback must contain the persist exception`);

        assert.equal(broker.pendingBossControls.size, 0, `${terminalCase.name}/${stage} must clear the exact pending control`);
        assert.equal(broker.pendingBossControlKeys.size, 0, `${terminalCase.name}/${stage} must clear the exact pending key`);
        const live = store.get(accepted());
        const replayed = new DurableBossControlStore(path).get(accepted());
        assert.equal(live?.state, terminalCase.state, `${terminalCase.name}/${stage} live state`);
        assert.deepEqual(replayed, live, `${terminalCase.name}/${stage} restart replay`);

        const expectedFrame = terminalCase.state === "delivered"
          ? { type: "boss_control_delivered", messageId: envelope.messageId, deliveryId: "delivery-a" }
          : {
            type: "boss_control_failed",
            messageId: envelope.messageId,
            deliveryId: "delivery-a",
            accepted: true,
            code: terminalCase.code,
            reason: terminalCase.name === "reject"
              ? "The exact accepted Boss control target is unavailable"
              : terminalCase.name === "timeout"
                ? "Recipient acknowledgement timed out"
                : "Recipient disconnected before acknowledging the Boss control",
          };
        assert.deepEqual(frames, [expectedFrame], `${terminalCase.name}/${stage} must publish the committed terminal`);

        assert.doesNotThrow(() => {
          broker.failPendingBossControl("delivery-a", "DELIVERY_TIMEOUT", "stale timeout");
          broker.clearPendingBossControlsForSession("manager-session-a", recipientSocket);
        });
        assert.deepEqual(frames, [expectedFrame], `${terminalCase.name}/${stage} stale callbacks must not contradict the terminal`);
        assert.equal(new DurableBossControlStore(path).get(accepted())?.state, terminalCase.state);
      }
    }
    assert.equal(containedErrors.length, TERMINAL_CASES.length * 2, "each injected persist exception must be contained and reported");
  } finally {
    console.error = originalConsoleError;
    await rm(root, { recursive: true, force: true });
  }
});
