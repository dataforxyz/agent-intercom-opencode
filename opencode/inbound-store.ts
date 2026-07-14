import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { ensureIntercomRuntimeDir, getIntercomDirPath } from "../broker/paths.ts";
import { writeDurableJson } from "../durable-json.ts";
import type { Message, SessionInfo } from "../types.ts";

export interface DurableInboundEntry {
  from: SessionInfo;
  message: Message;
  deliveryId: string;
  receivedAt: number;
  read: boolean;
}

interface DurableInboundRecord {
  entry: DurableInboundEntry;
  injected: boolean;
}

interface DurableInboundState {
  version: 1;
  records: Record<string, DurableInboundRecord>;
  delivered: string[];
}

export interface InboundDeliveryStore {
  enqueue(entry: DurableInboundEntry): "new" | "pending" | "injected" | "delivered";
  pendingInjection(): DurableInboundEntry[];
  unresolvedAsks(): DurableInboundEntry[];
  retainedEntries(): DurableInboundEntry[];
  markInjected(messageId: string): void;
  markReplied(messageId: string): void;
}

const EMPTY_STATE: DurableInboundState = { version: 1, records: {}, delivered: [] };
const MAX_DELIVERED_IDS = 1000;

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "opencode";
}

export function getOpenCodeInboundStatePath(sessionId: string, intercomDir = getIntercomDirPath()): string {
  return join(intercomDir, `opencode-inbound-${sanitizeSegment(sessionId)}.json`);
}

function normalizeState(value: unknown): DurableInboundState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const input = value as Partial<DurableInboundState>;
  if (input.version !== 1 || !input.records || typeof input.records !== "object" || Array.isArray(input.records)) {
    return structuredClone(EMPTY_STATE);
  }
  return {
    version: 1,
    records: input.records as Record<string, DurableInboundRecord>,
    delivered: Array.isArray(input.delivered) ? input.delivered.filter((id): id is string => typeof id === "string").slice(-MAX_DELIVERED_IDS) : [],
  };
}

export class DurableInboundStore implements InboundDeliveryStore {
  readonly path: string;
  private state: DurableInboundState;

  constructor(path: string) {
    this.path = path;
    ensureIntercomRuntimeDir(dirname(path));
    this.state = this.load();
  }

  private load(): DurableInboundState {
    if (!existsSync(this.path)) return structuredClone(EMPTY_STATE);
    try {
      return normalizeState(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  private save(): void {
    writeDurableJson(this.path, this.state);
  }

  private rememberDelivered(messageId: string): void {
    this.state.delivered = [...this.state.delivered.filter((id) => id !== messageId), messageId].slice(-MAX_DELIVERED_IDS);
  }

  enqueue(entry: DurableInboundEntry): "new" | "pending" | "injected" | "delivered" {
    const messageId = entry.message.id;
    if (this.state.delivered.includes(messageId)) return "delivered";
    const existing = this.state.records[messageId];
    if (existing) return existing.injected ? "injected" : "pending";
    this.state.records[messageId] = { entry, injected: false };
    this.save();
    return "new";
  }

  pendingInjection(): DurableInboundEntry[] {
    return Object.values(this.state.records).filter((record) => !record.injected).map((record) => record.entry);
  }

  unresolvedAsks(): DurableInboundEntry[] {
    return Object.values(this.state.records)
      .filter((record) => record.entry.message.expectsReply)
      .map((record) => record.entry);
  }

  retainedEntries(): DurableInboundEntry[] {
    return Object.values(this.state.records).map((record) => record.entry);
  }

  markInjected(messageId: string): void {
    const record = this.state.records[messageId];
    if (!record) return;
    if (record.entry.message.expectsReply) {
      record.injected = true;
    } else {
      delete this.state.records[messageId];
      this.rememberDelivered(messageId);
    }
    this.save();
  }

  markReplied(messageId: string): void {
    delete this.state.records[messageId];
    this.rememberDelivered(messageId);
    this.save();
  }
}
