import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeDurableJson } from "../durable-json.ts";

export function normalizeOpenCodeSessionStatus(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
    return (value as { type: string }).type;
  }
  return "active";
}

export interface OpenCodePeerHealth {
  version: 1;
  runId: string;
  workerId: string;
  intercomSessionId: string;
  openCodeSessionId?: string;
  serverUrl: string;
  directory: string;
  pid: number;
  connected: boolean;
  ready: boolean;
  status: string;
  updatedAt: number;
  error?: string;
}

export class OpenCodePeerHealthReporter {
  readonly path?: string;
  private health: OpenCodePeerHealth;

  constructor(input: {
    path?: string;
    runId?: string;
    workerId?: string;
    intercomSessionId: string;
    serverUrl: string;
    directory: string;
    pid?: number;
  }) {
    this.path = input.path?.trim() || undefined;
    this.health = {
      version: 1,
      runId: input.runId?.trim() || "standalone",
      workerId: input.workerId?.trim() || input.intercomSessionId,
      intercomSessionId: input.intercomSessionId,
      serverUrl: input.serverUrl,
      directory: input.directory,
      pid: input.pid ?? process.pid,
      connected: false,
      ready: false,
      status: "starting",
      updatedAt: Date.now(),
    };
    this.write();
  }

  update(patch: Partial<Omit<OpenCodePeerHealth, "version" | "runId" | "workerId" | "intercomSessionId" | "serverUrl" | "directory" | "pid">>): OpenCodePeerHealth {
    this.health = {
      ...this.health,
      ...patch,
      updatedAt: Date.now(),
    };
    this.health.ready = this.health.connected && Boolean(this.health.openCodeSessionId) && !this.health.error;
    this.write();
    return this.snapshot();
  }

  snapshot(): OpenCodePeerHealth {
    return structuredClone(this.health);
  }

  private write(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeDurableJson(this.path, this.health);
  }
}
