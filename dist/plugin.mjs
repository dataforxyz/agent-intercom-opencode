// opencode/plugin.ts
import { appendFileSync } from "fs";
import { tool } from "@opencode-ai/plugin";

// opencode/runtime.ts
import { randomUUID as randomUUID4, createHash as createHash2 } from "crypto";
import { spawnSync } from "child_process";
import { basename as basename2 } from "path";
import { cwd as processCwd } from "process";

// broker/client.ts
import { EventEmitter } from "events";
import net from "net";
import { randomUUID as randomUUID2 } from "crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  POLICY_SEMANTICS_HASH,
  POLICY_SEMANTICS_VERSION
} from "@dataforxyz/agent-intercom-core";
import {
  parseBossControlEnvelope as parseBossControlEnvelope2
} from "@dataforxyz/agent-intercom-core/boss";
import { assertExactKeys as assertExactKeys2 } from "@dataforxyz/agent-intercom-core/canonical";

// broker/boss.ts
import {
  BOSS_CONTROL_TYPES,
  parseBossControlEnvelope,
  parseBossParticipantBinding,
  parseBossPolicyPrincipal,
  parseFeatureRegistration
} from "@dataforxyz/agent-intercom-core/boss";
import {
  ContractValidationError,
  assertExactKeys,
  assertRecord
} from "@dataforxyz/agent-intercom-core/canonical";
var CONTROL_KIND_BY_TYPE = {
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
  "boss.decision.required": "decision"
};
if (Object.keys(CONTROL_KIND_BY_TYPE).length !== BOSS_CONTROL_TYPES.length) {
  throw new Error("Boss control type mapping is incomplete");
}
function parseBossSessionMetadata(value, sessionId) {
  assertRecord(value, "$.boss");
  assertExactKeys(value, ["registration", "principal"], ["binding"], "$.boss");
  const metadata = value;
  const registration = parseFeatureRegistration(metadata.registration);
  const principal = parseBossPolicyPrincipal(metadata.principal);
  if (registration.principalClass !== "boss-bound" || principal.principalClass !== "boss-private") {
    throw new ContractValidationError("$.boss", "must contain Boss-bound registration and private principal metadata");
  }
  if (registration.principalId !== sessionId || principal.principalId !== sessionId || registration.bossRunId !== principal.bossRunId || registration.participantId !== principal.participantId || registration.bindingEpoch !== principal.bindingEpoch) {
    throw new ContractValidationError("$.boss", "registration and principal identity bindings must exactly match the session");
  }
  const binding = metadata.binding === void 0 ? void 0 : parseBossParticipantBinding(metadata.binding);
  if (principal.role === "controller") {
    if (binding !== void 0) throw new ContractValidationError("$.boss.binding", "is forbidden for Controller principals");
  } else {
    if (binding === void 0) throw new ContractValidationError("$.boss.binding", "is required for Boss participants");
    if (binding.sessionId !== sessionId || binding.bossRunId !== principal.bossRunId || binding.participantId !== principal.participantId || binding.role !== principal.role || binding.bindingEpoch !== principal.bindingEpoch || binding.state !== principal.state || binding.assignedManagerParticipantId !== principal.assignedManagerParticipantId) {
      throw new ContractValidationError("$.boss.binding", "must exactly match the authenticated session principal");
    }
  }
  return { registration, principal, ...binding === void 0 ? {} : { binding } };
}
function validatedBossMetadata(session) {
  if (session.boss === void 0) return void 0;
  return parseBossSessionMetadata(session.boss, session.id);
}
function parseBoundBossControl(value, sender) {
  const envelope = parseBossControlEnvelope(value);
  const boss = validatedBossMetadata(sender);
  if (!boss) throw new ContractValidationError("$.envelope", "sender is not an authenticated Boss participant");
  if (envelope.bossRunId !== boss.principal.bossRunId || envelope.participantId !== boss.principal.participantId || envelope.bindingEpoch !== boss.principal.bindingEpoch) {
    throw new ContractValidationError("$.envelope", "run, participant, and binding epoch must match the sender");
  }
  return envelope;
}

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;
function writeMessage(socket, msg) {
  const json = JSON.stringify(msg);
  const payload2 = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload2.length, 0);
  socket.write(Buffer.concat([header, payload2]));
}
function createMessageReader(onMessage, onError, maxFrameBytes = MAX_FRAME_BYTES) {
  let buffer = Buffer.alloc(0);
  function reportMessage(payload2) {
    let msg;
    try {
      msg = JSON.parse(payload2.toString("utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
      return false;
    }
    try {
      onMessage(msg);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
      return false;
    }
  }
  return (data) => {
    let remaining = data;
    while (remaining.length > 0) {
      if (buffer.length < 4) {
        const headerBytes = Math.min(4 - buffer.length, remaining.length);
        buffer = Buffer.concat([buffer, remaining.subarray(0, headerBytes)]);
        remaining = remaining.subarray(headerBytes);
        if (buffer.length < 4) {
          return;
        }
      }
      const length = buffer.readUInt32BE(0);
      if (length > maxFrameBytes) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Intercom frame length ${length} exceeds maximum ${maxFrameBytes} bytes`));
        return;
      }
      const missingPayloadBytes = length - Math.max(0, buffer.length - 4);
      const payloadBytes = Math.min(missingPayloadBytes, remaining.length);
      if (payloadBytes > 0) {
        buffer = Buffer.concat([buffer, remaining.subarray(0, payloadBytes)]);
        remaining = remaining.subarray(payloadBytes);
      }
      if (buffer.length < 4 + length) {
        return;
      }
      const payload2 = buffer.subarray(4, 4 + length);
      buffer = Buffer.alloc(0);
      if (!reportMessage(payload2)) {
        return;
      }
    }
  };
}

// outbound-outbox.ts
import { createHash } from "crypto";
import { chmodSync as chmodSync2, existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2 } from "fs";
import { join as join2 } from "path";

// broker/paths.ts
import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
var INTERCOM_DIR_MODE = 448;
var INTERCOM_RUNTIME_FILE_MODE = 384;
var INTERCOM_TCP_HOST = "127.0.0.1";
var INTERCOM_PROTOCOL_NAME = "pi-intercom";
var INTERCOM_PROTOCOL_VERSION = 3;
function sanitizePipeSegment(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}
function getAgentDirPath(env = process.env, homeDir = homedir(), cwd = process.cwd()) {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homeDir, ".pi/agent");
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
function getIntercomDirPath(agentDir = getAgentDirPath()) {
  return join(agentDir, "intercom");
}
function shouldUseWindowsTcpTransport(platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return false;
  }
  const transport = env.PI_INTERCOM_TRANSPORT?.trim().toLowerCase();
  if (transport === "tcp") {
    return true;
  }
  const legacyOptIn = env.PI_INTERCOM_TCP?.trim().toLowerCase();
  return legacyOptIn === "1" || legacyOptIn === "true";
}
function getBrokerPortFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker.port.json");
}
function getBrokerSocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "broker.sock");
}
function getBrokerConnectTarget(platform = process.platform, env = process.env, intercomDir = getIntercomDirPath(getAgentDirPath(env))) {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    const endpointFile = getBrokerPortFilePath(intercomDir);
    const raw = readFileSync(endpointFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}: expected a JSON object`);
    }
    const endpoint = parsed;
    if (endpoint.transport !== "tcp" || endpoint.host !== INTERCOM_TCP_HOST || typeof endpoint.port !== "number" || !Number.isSafeInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535 || typeof endpoint.stateId !== "string" || endpoint.stateId.length === 0) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}`);
    }
    return { transport: "tcp", host: endpoint.host, port: endpoint.port, stateId: endpoint.stateId };
  }
  return getBrokerSocketPath(platform, getAgentDirPath(env));
}
function ensureIntercomRuntimeDir(intercomDir = getIntercomDirPath(), platform = process.platform) {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}
function restrictIntercomRuntimeFile(filePath, platform = process.platform) {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}

// durable-json.ts
import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
var DURABLE_JSON_FILE_OPERATIONS = Object.freeze({
  writeFile(filePath, contents, options) {
    writeFileSync(filePath, contents, options);
  },
  open(filePath, flags) {
    return openSync(filePath, flags);
  },
  fsync(fileDescriptor) {
    fsyncSync(fileDescriptor);
  },
  close(fileDescriptor) {
    closeSync(fileDescriptor);
  },
  rename(from, to) {
    renameSync(from, to);
  },
  restrict(filePath) {
    restrictIntercomRuntimeFile(filePath);
  },
  platform: process.platform
});
function writeDurableJson(filePath, value, operations = DURABLE_JSON_FILE_OPERATIONS) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  operations.writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: INTERCOM_RUNTIME_FILE_MODE });
  const fileDescriptor = operations.open(temporaryPath, "r");
  try {
    operations.fsync(fileDescriptor);
  } finally {
    operations.close(fileDescriptor);
  }
  operations.rename(temporaryPath, filePath);
  operations.restrict(filePath);
  if (operations.platform !== "win32") {
    const directoryDescriptor = operations.open(dirname(filePath), "r");
    try {
      operations.fsync(directoryDescriptor);
    } finally {
      operations.close(directoryDescriptor);
    }
  }
}

// outbound-outbox.ts
var OUTBOX_STATE_VERSION = 1;
var MAX_OUTBOX_MESSAGES = 256;
function fingerprint(entry) {
  return JSON.stringify({
    to: entry.to,
    replyTo: entry.message.replyTo,
    expectsReply: entry.message.expectsReply,
    content: entry.message.content
  });
}
function isStoredOutboundMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value;
  if (typeof entry.to !== "string" || typeof entry.queuedAt !== "number") return false;
  if (typeof entry.message !== "object" || entry.message === null || Array.isArray(entry.message)) return false;
  const message = entry.message;
  return typeof message.id === "string" && typeof message.timestamp === "number" && typeof message.content === "object" && message.content !== null && typeof message.content.text === "string";
}
function fileName(sessionId) {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}
var PersistentOutboundOutbox = class {
  directory;
  filePath;
  state;
  constructor(sessionId, intercomDir = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    this.directory = join2(intercomDir, "outbox");
    mkdirSync2(this.directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync2(this.directory, INTERCOM_DIR_MODE);
    this.filePath = join2(this.directory, fileName(sessionId));
    this.state = this.load();
  }
  list() {
    return this.state.entries.map((entry) => ({ ...entry, message: { ...entry.message, content: { ...entry.message.content } } }));
  }
  enqueue(to, message) {
    const existing = this.state.entries.find((entry) => entry.message.id === message.id);
    if (existing) {
      if (fingerprint(existing) !== fingerprint({ to, message })) {
        throw new Error(`Message ID ${message.id} is already queued with a different payload`);
      }
      return "existing";
    }
    if (this.state.entries.length >= MAX_OUTBOX_MESSAGES) {
      throw new Error(`Durable outbox is full (${MAX_OUTBOX_MESSAGES} messages)`);
    }
    this.state.entries.push({ to, message, queuedAt: Date.now() });
    this.persist();
    return "added";
  }
  remove(messageId) {
    const remaining = this.state.entries.filter((entry) => entry.message.id !== messageId);
    if (remaining.length === this.state.entries.length) return;
    this.state.entries = remaining;
    this.persist();
  }
  clear() {
    if (this.state.entries.length === 0) return;
    this.state.entries = [];
    this.persist();
  }
  load() {
    if (!existsSync(this.filePath)) return { version: OUTBOX_STATE_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync2(this.filePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed;
      if (state.version !== OUTBOX_STATE_VERSION || !Array.isArray(state.entries) || !state.entries.every(isStoredOutboundMessage)) {
        throw new Error("invalid outbox state");
      }
      return { version: OUTBOX_STATE_VERSION, entries: state.entries };
    } catch {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync2(this.filePath, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      return { version: OUTBOX_STATE_VERSION, entries: [] };
    }
  }
  persist() {
    writeDurableJson(this.filePath, this.state);
  }
};

// broker/access-credential.ts
import { readFileSync as readFileSync3 } from "fs";
var ACCESS_CREDENTIAL_ENV = "AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH";
var ACCESS_CREDENTIAL_VERSION = 1;
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function loadRemoteAccessCredential(env = process.env) {
  const path = env[ACCESS_CREDENTIAL_ENV]?.trim();
  if (!path) return void 0;
  const parsed = JSON.parse(readFileSync3(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Agent Intercom access credential at ${path}`);
  }
  const credential = parsed;
  if (nonEmptyString(credential.enrollmentToken)) {
    return { path, access: { enrollmentToken: credential.enrollmentToken }, enrollment: true };
  }
  if (credential.version === ACCESS_CREDENTIAL_VERSION && nonEmptyString(credential.sessionCredential) && nonEmptyString(credential.sessionId) && typeof credential.generation === "number" && Number.isSafeInteger(credential.generation) && credential.generation > 0) {
    return {
      path,
      access: {
        sessionCredential: credential.sessionCredential,
        sessionId: credential.sessionId,
        generation: credential.generation
      },
      enrollment: false
    };
  }
  throw new Error(`Invalid Agent Intercom access credential at ${path}`);
}
function writeRemoteSessionCredential(path, sessionId, metadata) {
  if (!metadata.sessionCredential) {
    throw new Error("Remote enrollment response omitted the session credential");
  }
  writeDurableJson(path, {
    version: ACCESS_CREDENTIAL_VERSION,
    sessionCredential: metadata.sessionCredential,
    sessionId,
    generation: metadata.generation
  });
}

// broker/client.ts
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function connectToBrokerTarget(target) {
  return typeof target === "string" ? net.connect(target) : net.connect({ host: target.host, port: target.port });
}
function isAttachment(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") {
    return false;
  }
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }
  return attachment.language === void 0 || typeof attachment.language === "string";
}
function isMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }
  if (message.replyTo !== void 0 && typeof message.replyTo !== "string") {
    return false;
  }
  if (message.expectsReply !== void 0 && typeof message.expectsReply !== "boolean") {
    return false;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  const content = message.content;
  if (typeof content.text !== "string") {
    return false;
  }
  return content.attachments === void 0 || Array.isArray(content.attachments) && content.attachments.every(isAttachment);
}
var PRE_ACCEPT_BOSS_CONTROL_FAILURE_CODES = [
  "INVALID_BOSS_CONTROL",
  "SESSION_NOT_FOUND",
  "CONFLICTING_MESSAGE_ID",
  "TOO_MANY_PENDING_DELIVERIES",
  "BOSS_CONTROL_DENIED"
];
var POST_ACCEPT_BOSS_CONTROL_FAILURE_CODES = [
  "BOSS_CONTROL_DENIED",
  "RECIPIENT_DISCONNECTED",
  "SENDER_DISCONNECTED",
  "DELIVERY_TIMEOUT"
];
function isBossControlFailureCode(value, accepted) {
  return typeof value === "string" && (accepted ? POST_ACCEPT_BOSS_CONTROL_FAILURE_CODES : PRE_ACCEPT_BOSS_CONTROL_FAILURE_CODES).includes(value);
}
function exactBossControlFrame(frame, required, path) {
  assertExactKeys2(frame, required, [], path);
}
function bossControlFrameString(value, path) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
}
function isSessionInfo(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value;
  if (typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.model !== "string" || typeof session.pid !== "number" || typeof session.startedAt !== "number" || typeof session.lastActivity !== "number") {
    return false;
  }
  if (session.name !== void 0 && typeof session.name !== "string") {
    return false;
  }
  if (session.status !== void 0 && typeof session.status !== "string") {
    return false;
  }
  if (session.peerUid !== void 0 && typeof session.peerUid !== "number") {
    return false;
  }
  if (session.trustedLocal !== void 0 && typeof session.trustedLocal !== "boolean") return false;
  if (session.origin !== void 0 && session.origin !== "local" && session.origin !== "remote") return false;
  if (session.remoteHostId !== void 0 && typeof session.remoteHostId !== "string") return false;
  if (session.parentSessionId !== void 0 && typeof session.parentSessionId !== "string") return false;
  if (session.rootSessionId !== void 0 && typeof session.rootSessionId !== "string") return false;
  if (session.generation !== void 0 && (typeof session.generation !== "number" || !Number.isSafeInteger(session.generation))) return false;
  if (session.canDelegate !== void 0 && typeof session.canDelegate !== "boolean") return false;
  for (const field of ["depth", "maxDepth", "maxChildren"]) {
    if (session[field] !== void 0 && (typeof session[field] !== "number" || !Number.isSafeInteger(session[field]))) return false;
  }
  return session.boss === void 0;
}
var BOSS_SESSION_REQUIRED_FIELDS = [
  "id",
  "cwd",
  "model",
  "pid",
  "startedAt",
  "lastActivity",
  "boss"
];
var BOSS_SESSION_OPTIONAL_FIELDS = [
  "name",
  "status",
  "peerUid",
  "trustedLocal",
  "origin",
  "remoteHostId",
  "parentSessionId",
  "rootSessionId",
  "generation",
  "canDelegate",
  "depth",
  "maxDepth",
  "maxChildren"
];
function snapshotBossData(value, path, seen = /* @__PURE__ */ new WeakSet(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${path} must be a JSON number`);
    return value;
  }
  if (typeof value !== "object" || nodeUtilTypes.isProxy(value)) {
    throw new Error(`${path} must be unproxied broker-owned data`);
  }
  if (depth >= 32 || seen.has(value)) throw new Error(`${path} must be an acyclic bounded data tree`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${path} must be a plain array`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === void 0 || !Object.hasOwn(lengthDescriptor, "value") || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      throw new Error(`${path} must be a dense array`);
    }
    const entries = /* @__PURE__ */ new Map();
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string") throw new Error(`${path} must not contain symbol properties`);
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= lengthDescriptor.value || String(index) !== key) {
        throw new Error(`${path}.${key} is not a supported array index`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === void 0 || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${path}[${index}] must be an enumerable data property`);
      }
      entries.set(index, snapshotBossData(descriptor.value, `${path}[${index}]`, seen, depth + 1));
    }
    if (entries.size !== lengthDescriptor.value) throw new Error(`${path} must not contain sparse array holes`);
    return Array.from({ length: lengthDescriptor.value }, (_, index) => entries.get(index));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be a plain object`);
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${path} must not contain symbol properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === void 0 || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${path}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: snapshotBossData(descriptor.value, `${path}.${key}`, seen, depth + 1),
      writable: true
    });
  }
  return snapshot;
}
function authoritativeBossSessionInfo(value) {
  try {
    const snapshot = snapshotBossData(value, "$.boss_control.from");
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return void 0;
    const session = snapshot;
    assertExactKeys2(
      session,
      [...BOSS_SESSION_REQUIRED_FIELDS],
      [...BOSS_SESSION_OPTIONAL_FIELDS],
      "$.boss_control.from"
    );
    const { boss, ...ordinaryFields } = session;
    if (!isSessionInfo(ordinaryFields)) return void 0;
    const parsedBoss = parseBossSessionMetadata(boss, ordinaryFields.id);
    if (parsedBoss.registration.state !== "active" || !parsedBoss.registration.brokerIdentityVerified || parsedBoss.principal.state !== "active" || parsedBoss.binding !== void 0 && parsedBoss.binding.state !== "active") {
      return void 0;
    }
    return { ...ordinaryFields, boss: parsedBoss };
  } catch {
    return void 0;
  }
}
function isRemoteAccessMetadata(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const access = value;
  return access.origin === "remote" && typeof access.remoteHostId === "string" && typeof access.parentSessionId === "string" && typeof access.rootSessionId === "string" && typeof access.generation === "number" && Number.isSafeInteger(access.generation) && access.generation > 0 && typeof access.canDelegate === "boolean" && typeof access.depth === "number" && Number.isSafeInteger(access.depth) && typeof access.maxDepth === "number" && Number.isSafeInteger(access.maxDepth) && typeof access.maxChildren === "number" && Number.isSafeInteger(access.maxChildren) && (access.sessionCredential === void 0 || typeof access.sessionCredential === "string");
}
var IntercomClient = class extends EventEmitter {
  socket = null;
  _sessionId = null;
  pendingSends = /* @__PURE__ */ new Map();
  pendingLists = /* @__PURE__ */ new Map();
  pendingAskControls = /* @__PURE__ */ new Map();
  pendingBossControls = /* @__PURE__ */ new Map();
  outbox = null;
  remoteAccessCredential;
  disconnecting = false;
  disconnectError = null;
  failPending(error) {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
    for (const pending of this.pendingAskControls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAskControls.clear();
    for (const pending of this.pendingBossControls.values()) pending.reject(error);
    this.pendingBossControls.clear();
  }
  get sessionId() {
    return this._sessionId;
  }
  get outboxSize() {
    return this.outbox?.list().length ?? 0;
  }
  isConnected() {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }
  requireActiveSocket() {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }
    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }
    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }
    return socket;
  }
  connect(session, sessionId) {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }
    return new Promise((resolve3, reject) => {
      let socket;
      let target;
      try {
        target = getBrokerConnectTarget();
        this.remoteAccessCredential = loadRemoteAccessCredential();
        socket = connectToBrokerTarget(target);
      } catch (error) {
        reject(toError(error));
        return;
      }
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 1e4);
      let connectionEstablished = false;
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve3();
      };
      const onError = (err) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };
      const onSocketError = (err) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };
      const onReaderError = (error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };
      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };
      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      try {
        writeMessage(socket, {
          type: "register",
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION,
          session,
          ...!this.remoteAccessCredential && sessionId ? { sessionId } : {},
          ...this.remoteAccessCredential ? { access: this.remoteAccessCredential.access } : {},
          ...typeof target === "string" ? {} : { stateId: target.stateId }
        });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }
  handleBrokerMessage(msg) {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }
    const brokerMessage = msg;
    if (this._sessionId === null && brokerMessage.type !== "registered" && brokerMessage.type !== "error") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }
    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string" || brokerMessage.protocol !== INTERCOM_PROTOCOL_NAME || brokerMessage.version !== INTERCOM_PROTOCOL_VERSION) {
          throw new Error("Invalid registered message");
        }
        if (brokerMessage.boss !== void 0 || brokerMessage.capabilities !== void 0) {
          throw new Error("Ordinary registration must not contain feature or Boss metadata");
        }
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        if (this.remoteAccessCredential) {
          const contract = brokerMessage.remoteAccess;
          const contractFields = typeof contract === "object" && contract !== null ? contract : void 0;
          if (!contractFields || contractFields.feature !== "remote-access-v1" || contractFields.policySemanticsVersion !== POLICY_SEMANTICS_VERSION || contractFields.policySemanticsHash !== POLICY_SEMANTICS_HASH) {
            throw new Error("Remote Intercom policy contract is absent or incompatible");
          }
          if (!isRemoteAccessMetadata(brokerMessage.access)) {
            throw new Error("Remote Intercom registration omitted broker-owned provenance");
          }
          if (this.remoteAccessCredential.enrollment) {
            writeRemoteSessionCredential(this.remoteAccessCredential.path, brokerMessage.sessionId, brokerMessage.access);
          } else {
            const reconnect = this.remoteAccessCredential.access;
            if (!("sessionId" in reconnect) || reconnect.sessionId !== brokerMessage.sessionId || reconnect.generation !== brokerMessage.access.generation) {
              throw new Error("Remote Intercom reconnect identity or generation changed unexpectedly");
            }
          }
        }
        this._sessionId = brokerMessage.sessionId;
        this.outbox = new PersistentOutboundOutbox(brokerMessage.sessionId);
        this.replayOutbox();
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }
        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }
      case "message": {
        const { deliveryId, from, message } = brokerMessage;
        if (typeof deliveryId !== "string" || !isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
        }
        this.emit("message", from, message, deliveryId);
        break;
      }
      case "boss_control": {
        const { deliveryId, envelope } = brokerMessage;
        const from = authoritativeBossSessionInfo(brokerMessage.from);
        if (typeof deliveryId !== "string" || from === void 0) throw new Error("Invalid boss_control event");
        const parsed = parseBoundBossControl(
          snapshotBossData(envelope, "$.boss_control.envelope"),
          from
        );
        this.emit("boss_control", from, parsed, deliveryId);
        break;
      }
      case "boss_control_accepted": {
        exactBossControlFrame(brokerMessage, ["type", "messageId", "deliveryId"], "$.boss_control_accepted");
        const { deliveryId, messageId } = brokerMessage;
        bossControlFrameString(deliveryId, "$.boss_control_accepted.deliveryId");
        bossControlFrameString(messageId, "$.boss_control_accepted.messageId");
        const pending = this.pendingBossControls.get(messageId);
        if (!pending) break;
        if (pending.accepted) throw new Error("Duplicate Boss control acceptance");
        if (pending.deliveryId !== void 0) throw new Error("Boss control acceptance state is contradictory");
        pending.accepted = true;
        pending.deliveryId = deliveryId;
        break;
      }
      case "boss_control_delivered": {
        exactBossControlFrame(brokerMessage, ["type", "messageId", "deliveryId"], "$.boss_control_delivered");
        const { deliveryId, messageId } = brokerMessage;
        bossControlFrameString(deliveryId, "$.boss_control_delivered.deliveryId");
        bossControlFrameString(messageId, "$.boss_control_delivered.messageId");
        const pending = this.pendingBossControls.get(messageId);
        if (!pending) break;
        if (!pending.accepted || pending.deliveryId !== deliveryId) {
          throw new Error("Boss control delivery did not follow matching acceptance");
        }
        this.pendingBossControls.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: true, deliveryId });
        break;
      }
      case "boss_control_failed": {
        const { accepted } = brokerMessage;
        if (typeof accepted !== "boolean") throw new Error("Invalid boss_control_failed message");
        exactBossControlFrame(
          brokerMessage,
          accepted ? ["type", "messageId", "deliveryId", "accepted", "code", "reason"] : ["type", "messageId", "accepted", "code", "reason"],
          "$.boss_control_failed"
        );
        const { code, deliveryId, messageId, reason } = brokerMessage;
        if (!isBossControlFailureCode(code, accepted) || typeof reason !== "string" || reason.length === 0) {
          throw new Error("Invalid boss_control_failed message");
        }
        bossControlFrameString(messageId, "$.boss_control_failed.messageId");
        if (accepted) bossControlFrameString(deliveryId, "$.boss_control_failed.deliveryId");
        const pending = this.pendingBossControls.get(messageId);
        if (!pending) break;
        if (accepted !== pending.accepted) throw new Error("Boss control failure acceptance state is inconsistent");
        if (accepted && pending.deliveryId !== deliveryId) {
          throw new Error("Boss control failure did not follow matching acceptance");
        }
        this.pendingBossControls.delete(messageId);
        pending.resolve({
          id: messageId,
          accepted,
          delivered: false,
          code,
          reason,
          ...accepted ? { deliveryId } : {}
        });
        break;
      }
      case "delivery_accepted": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivery_accepted message");
        }
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          return;
        }
        pending.accepted = true;
        pending.deliveryId = deliveryId;
        this.emit("delivery_accepted", messageId, deliveryId);
        break;
      }
      case "delivered": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }
        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_delivered", messageId, deliveryId);
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: true, deliveryId });
        break;
      }
      case "delivery_failed": {
        const { accepted, code, messageId, reason } = brokerMessage;
        if (typeof accepted !== "boolean" || typeof code !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }
        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_failed", messageId, code, reason);
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({
          id: messageId,
          accepted,
          delivered: false,
          code,
          reason,
          ...pending.deliveryId ? { deliveryId: pending.deliveryId } : {}
        });
        break;
      }
      case "ask_deferred": {
        const { fromSessionId, messageId } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid ask_deferred message");
        }
        this.emit("ask_deferred", messageId, fromSessionId);
        break;
      }
      case "ask_cancelled": {
        const { fromSessionId, messageId, reason } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid ask_cancelled message");
        }
        this.emit("ask_cancelled", messageId, fromSessionId, reason);
        break;
      }
      case "ask_control_result": {
        const { action, applied, messageId, requestId } = brokerMessage;
        if (action !== "defer" && action !== "cancel" || typeof applied !== "boolean" || typeof messageId !== "string" || typeof requestId !== "string") {
          throw new Error("Invalid ask_control_result message");
        }
        const pending = this.pendingAskControls.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingAskControls.delete(requestId);
        pending.resolve(applied);
        break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "error": {
        if (typeof brokerMessage.code !== "string" || typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        if (this._sessionId === null) {
          const error2 = new Error(brokerMessage.error);
          error2.code = brokerMessage.code;
          throw error2;
        }
        const error = new Error(brokerMessage.error);
        error.code = brokerMessage.code;
        this.emit("error", error);
        break;
      }
      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  async disconnect(preserveAsks = false) {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));
    if (!preserveAsks) this.outbox?.clear();
    await new Promise((resolve3) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve3();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2e3);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister", ...preserveAsks ? { preserveAsks: true } : {} });
        socket.end();
      } catch {
        socket.destroy();
      }
    });
  }
  listSessions() {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve3, reject) => {
      const requestId = randomUUID2();
      const wrappedResolve = (sessions) => {
        clearTimeout(timeout);
        resolve3(sessions);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5e3);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }
  send(to, options) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const messageId = options.messageId ?? randomUUID2();
    if (this.pendingSends.has(messageId)) {
      return Promise.resolve({
        id: messageId,
        accepted: false,
        delivered: false,
        code: "DUPLICATE_MESSAGE_ID",
        reason: `Message ID ${messageId} is already pending`
      });
    }
    const message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments
      }
    };
    try {
      this.outbox?.enqueue(to, message);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve3, reject) => {
      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve3(result);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 1e4);
      this.pendingSends.set(messageId, {
        accepted: false,
        resolve: wrappedResolve,
        reject: wrappedReject
      });
      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }
  sendBossControl(to, envelopeValue) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    let envelope;
    try {
      envelope = parseBossControlEnvelope2(envelopeValue);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    if (this.pendingBossControls.has(envelope.messageId)) {
      return Promise.resolve({
        id: envelope.messageId,
        accepted: false,
        delivered: false,
        code: "CONFLICTING_MESSAGE_ID",
        reason: `Boss control message ID ${envelope.messageId} is already pending`
      });
    }
    return new Promise((resolve3, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBossControls.delete(envelope.messageId)) return;
        reject(new Error("Boss control send timeout"));
      }, 1e4);
      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve3(result);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      this.pendingBossControls.set(envelope.messageId, { accepted: false, resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "boss_control_send", to, envelope });
      } catch (error) {
        this.pendingBossControls.delete(envelope.messageId);
        wrappedReject(toError(error));
      }
    });
  }
  acknowledgeMessage(deliveryId) {
    return this.writeControlMessage({ type: "message_received", deliveryId });
  }
  acknowledgeBossControl(deliveryId) {
    return this.writeControlMessage({ type: "boss_control_received", deliveryId });
  }
  rejectMessage(deliveryId, reason) {
    return this.writeControlMessage({ type: "message_rejected", deliveryId, code: "CONFLICTING_MESSAGE_ID", reason });
  }
  deferAsk(messageId) {
    return this.sendAskControl("defer", messageId);
  }
  cancelAsk(messageId) {
    return this.sendAskControl("cancel", messageId);
  }
  sendAskControl(action, messageId) {
    const requestId = randomUUID2();
    return new Promise((resolve3) => {
      const timeout = setTimeout(() => {
        this.pendingAskControls.delete(requestId);
        resolve3(false);
      }, 2e3);
      timeout.unref?.();
      this.pendingAskControls.set(requestId, { resolve: resolve3, timeout });
      if (!this.writeControlMessage({ type: action === "defer" ? "defer_ask" : "cancel_ask", requestId, messageId })) {
        clearTimeout(timeout);
        this.pendingAskControls.delete(requestId);
        resolve3(false);
      }
    });
  }
  writeControlMessage(message) {
    if (this.disconnecting) {
      return false;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return false;
    }
    try {
      writeMessage(socket, message);
      return true;
    } catch {
      return false;
    }
  }
  replayOutbox() {
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) return;
    for (const entry of this.outbox?.list() ?? []) {
      if (this.pendingSends.has(entry.message.id)) continue;
      try {
        writeMessage(socket, { type: "send", to: entry.to, message: entry.message });
      } catch {
        return;
      }
    }
  }
  updatePresence(updates) {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "presence", ...updates });
  }
};

// broker/spawn.ts
import { spawn } from "child_process";
import { existsSync as existsSync2, readFileSync as readFileSync4, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { join as join3, dirname as dirname2, extname, basename } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net2 from "net";
import { randomUUID as randomUUID3 } from "crypto";
import {
  POLICY_SEMANTICS_HASH as POLICY_SEMANTICS_HASH2,
  POLICY_SEMANTICS_VERSION as POLICY_SEMANTICS_VERSION2
} from "@dataforxyz/agent-intercom-core";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join3(dirname2(fileURLToPath(import.meta.url)), "..");
var BROKER_PID = join3(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join3(INTERCOM_DIR, "broker.spawn.lock");
function sleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function getTsxCliPath(extensionDir = EXTENSION_DIR) {
  try {
    const requireFromExtension = createRequire(import.meta.url);
    const tsxMain = requireFromExtension.resolve("tsx");
    return join3(dirname2(tsxMain), "cli.mjs");
  } catch {
    return join3(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}
function getBrokerEntryPath(moduleUrl = import.meta.url) {
  const directory = dirname2(fileURLToPath(moduleUrl));
  const bundled = join3(directory, "broker.mjs");
  return existsSync2(bundled) ? bundled : join3(directory, "broker.ts");
}
function getNodeExecutable(execPath = process.execPath, platform = process.platform) {
  const executable = basename(execPath).toLowerCase();
  if (executable === "node" || executable === "node.exe") return execPath;
  return platform === "win32" ? "node.exe" : "node";
}
function quoteWindowsArg(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
function getWindowsHiddenLauncherPath(intercomDir = INTERCOM_DIR) {
  return join3(intercomDir, "broker-launch.vbs");
}
function usesDefaultBrokerCommand(brokerCommand, brokerArgs) {
  return brokerCommand === "npx" && brokerArgs.length === 2 && brokerArgs[0] === "--no-install" && brokerArgs[1] === "tsx";
}
function getWindowsBrokerCommandLine(brokerPath, extensionDir = EXTENSION_DIR, nodePath = process.execPath, brokerCommand = "npx", brokerArgs = ["--no-install", "tsx"]) {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    if (extname(brokerPath) === ".mjs") {
      return [quoteWindowsArg(nodePath), quoteWindowsArg(brokerPath)].join(" ");
    }
    return [quoteWindowsArg(nodePath), quoteWindowsArg(getTsxCliPath(extensionDir)), quoteWindowsArg(brokerPath)].join(" ");
  }
  return [quoteWindowsArg(brokerCommand), ...brokerArgs.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}
function getWindowsHiddenLauncherScript(commandLine) {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    "Set WshShell = Nothing",
    ""
  ].join("\r\n");
}
function isBrokerHealthOkMessage(message, requestId) {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message;
  if (response.type !== "health_ok" || response.requestId !== requestId || response.protocol !== INTERCOM_PROTOCOL_NAME || response.version !== INTERCOM_PROTOCOL_VERSION || response.endpoint !== "local") return false;
  const remoteAccess = response.remoteAccess;
  if (typeof remoteAccess !== "object" || remoteAccess === null || Array.isArray(remoteAccess)) return false;
  const contract = remoteAccess;
  return contract.feature === "remote-access-v1" && contract.policySemanticsVersion === POLICY_SEMANTICS_VERSION2 && contract.policySemanticsHash === POLICY_SEMANTICS_HASH2;
}
function writeWindowsHiddenLauncher(commandLine, launcherPath = getWindowsHiddenLauncherPath()) {
  ensureIntercomRuntimeDir(dirname2(launcherPath));
  writeFileSync2(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}
function getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, extensionDir = EXTENSION_DIR, platform = process.platform, intercomDir = INTERCOM_DIR, nodePath = process.execPath) {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs)
    };
  }
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    if (extname(brokerPath) === ".mjs") {
      return {
        kind: "direct",
        command: nodePath,
        args: [brokerPath]
      };
    }
    return {
      kind: "direct",
      command: nodePath,
      args: [getTsxCliPath(extensionDir), brokerPath]
    };
  }
  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath]
  };
}
function getBrokerSpawnOptions(extensionDir = EXTENSION_DIR, env = process.env) {
  return {
    detached: true,
    stdio: "ignore",
    cwd: extensionDir,
    env: { ...env, PI_CODING_AGENT_DIR: getAgentDirPath(env), NODE_NO_WARNINGS: "1" },
    windowsHide: true
  };
}
function toError2(error) {
  return error instanceof Error ? error : new Error(String(error));
}
async function spawnBrokerIfNeeded(brokerCommand, brokerArgs) {
  ensureIntercomRuntimeDir(INTERCOM_DIR);
  if (await isBrokerRunning()) {
    return;
  }
  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }
  try {
    if (await isBrokerRunning()) {
      return;
    }
    if (await checkBrokerHealth() === "incompatible") {
      await stopBrokerProcess();
    }
    const brokerPath = getBrokerEntryPath();
    const launch = getBrokerLaunchSpec(
      brokerPath,
      brokerCommand,
      brokerArgs,
      EXTENSION_DIR,
      process.platform,
      INTERCOM_DIR,
      getNodeExecutable()
    );
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();
    await new Promise((resolve3, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };
      const onExit = (code, signal) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve3();
      }, (error) => {
        cleanup();
        reject(toError2(error));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}
async function stopBrokerProcess(pidFile = BROKER_PID, timeoutMs = 3e3) {
  if (!existsSync2(pidFile)) return;
  let pid;
  try {
    pid = Number.parseInt(readFileSync4(pidFile, "utf-8").trim(), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      return;
    }
  }
  throw new Error(`Incompatible intercom broker ${pid} did not stop within ${timeoutMs}ms`);
}
async function isBrokerRunning() {
  if (await checkSocketConnectable()) {
    return true;
  }
  if (!existsSync2(BROKER_PID)) return false;
  try {
    const pid = parseInt(readFileSync4(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    return false;
  }
}
function connectToBrokerTarget2(target) {
  return typeof target === "string" ? net2.connect(target) : net2.connect({ host: target.host, port: target.port });
}
async function checkSocketConnectable() {
  return await checkBrokerHealth() === "compatible";
}
function checkBrokerHealth() {
  return new Promise((resolve3) => {
    let target;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve3("unreachable");
      return;
    }
    const socket = connectToBrokerTarget2(target);
    const requestId = randomUUID3();
    const expectedStateId = typeof target === "string" ? void 0 : target.stateId;
    let settled = false;
    const finish = (health) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve3(health);
    };
    const onConnect = () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...expectedStateId ? { stateId: expectedStateId } : {}
        });
      } catch {
        finish("unreachable");
      }
    };
    const onError = () => finish("unreachable");
    const reader = createMessageReader((message) => {
      if (isBrokerHealthOkMessage(message, requestId)) {
        finish("compatible");
        return;
      }
      if (typeof message === "object" && message !== null && "type" in message && message.type === "health_ok" && "requestId" in message && message.requestId === requestId) {
        finish("incompatible");
        return;
      }
      finish("unreachable");
    }, () => finish("unreachable"));
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish("unreachable"), 1e3);
  });
}
function acquireSpawnLock() {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync2(BROKER_SPAWN_LOCK, `${process.pid}
${Date.now()}
`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
        }
        continue;
      }
      return false;
    }
  }
  return false;
}
function isSpawnLockStale() {
  if (!existsSync2(BROKER_SPAWN_LOCK)) {
    return false;
  }
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync4(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }
    return !Number.isFinite(createdAt) || ageMs > 1e4;
  } catch {
    return true;
  }
}
function releaseSpawnLock() {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
  }
}
async function waitForBroker(timeoutMs = 5e3) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}

// config.ts
import { existsSync as existsSync3, readFileSync as readFileSync5 } from "fs";
import { join as join4, resolve as resolve2 } from "path";
import { homedir as homedir2 } from "os";
var DEFAULT_ASK_TIMEOUT_MS = 45 * 1e3;
var MAX_ASK_TIMEOUT_MS = 120 * 1e3;
function validateAskTimeoutMs(value, name = "timeout_ms") {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  if (value > MAX_ASK_TIMEOUT_MS) {
    throw new Error(`${name} must be ${MAX_ASK_TIMEOUT_MS} ms or less; use intercom_send plus intercom_pending for longer-running work`);
  }
  return value;
}
function getAskTimeoutMs() {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }
  const value = Number(raw);
  return validateAskTimeoutMs(value, "PI_INTERCOM_ASK_TIMEOUT_MS");
}
function getConfigPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join4(homedir2(), ".pi", "agent");
  return join4(agentDir, "intercom", "opencode-config.json");
}
var defaults = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  enabled: true
};
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync3(configPath)) {
    return { ...defaults };
  }
  try {
    const raw = readFileSync5(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    const parsedConfig = parsed;
    const config = { ...defaults };
    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }
    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }
    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }
    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return { ...defaults };
  }
}

// opencode/inbound-store.ts
import { existsSync as existsSync4, readFileSync as readFileSync6 } from "fs";
import { dirname as dirname3, join as join5 } from "path";
var EMPTY_STATE = { version: 1, records: {}, delivered: [] };
var MAX_DELIVERED_IDS = 1e3;
function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "opencode";
}
function getOpenCodeInboundStatePath(sessionId, intercomDir = getIntercomDirPath()) {
  return join5(intercomDir, `opencode-inbound-${sanitizeSegment(sessionId)}.json`);
}
function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const input = value;
  if (input.version !== 1 || !input.records || typeof input.records !== "object" || Array.isArray(input.records)) {
    return structuredClone(EMPTY_STATE);
  }
  return {
    version: 1,
    records: input.records,
    delivered: Array.isArray(input.delivered) ? input.delivered.filter((id) => typeof id === "string").slice(-MAX_DELIVERED_IDS) : []
  };
}
var DurableInboundStore = class {
  path;
  state;
  constructor(path) {
    this.path = path;
    ensureIntercomRuntimeDir(dirname3(path));
    this.state = this.load();
  }
  load() {
    if (!existsSync4(this.path)) return structuredClone(EMPTY_STATE);
    try {
      return normalizeState(JSON.parse(readFileSync6(this.path, "utf8")));
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }
  save() {
    writeDurableJson(this.path, this.state);
  }
  rememberDelivered(messageId) {
    this.state.delivered = [...this.state.delivered.filter((id) => id !== messageId), messageId].slice(-MAX_DELIVERED_IDS);
  }
  enqueue(entry) {
    const messageId = entry.message.id;
    if (this.state.delivered.includes(messageId)) return "delivered";
    const existing = this.state.records[messageId];
    if (existing) return existing.injected ? "injected" : "pending";
    this.state.records[messageId] = { entry, injected: false };
    this.save();
    return "new";
  }
  pendingInjection() {
    return Object.values(this.state.records).filter((record) => !record.injected).map((record) => record.entry);
  }
  unresolvedAsks() {
    return Object.values(this.state.records).filter((record) => record.entry.message.expectsReply).map((record) => record.entry);
  }
  retainedEntries() {
    return Object.values(this.state.records).map((record) => record.entry);
  }
  markInjected(messageId) {
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
  markReplied(messageId) {
    delete this.state.records[messageId];
    this.rememberDelivered(messageId);
    this.save();
  }
};

// opencode/team.ts
import { readFile } from "node:fs/promises";
import { join as join6 } from "node:path";
var LIVE_STATES = /* @__PURE__ */ new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
var stringValue = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
var connectedTo = (sessions, target) => {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
};
async function readWorkers(agentDir) {
  try {
    const parsed = JSON.parse(await readFile(join6(agentDir, "intercom", "orchestrator", "workers.json"), "utf8"));
    return Array.isArray(parsed.workers) ? parsed.workers : [];
  } catch {
    return [];
  }
}
async function resolveIntercomTeam(input) {
  const env = input.env ?? process.env;
  const workers = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  const current = workerId ? workers.find((worker) => stringValue(worker.id) === workerId && (!runId || stringValue(worker.runId) === runId)) : void 0;
  const managerTarget = stringValue(current?.managerSessionId) ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  const teamId = managerTarget ?? input.selfId;
  const coworkers = workers.filter((worker) => worker.owned === true).filter((worker) => stringValue(worker.managerSessionId) === teamId).filter((worker) => LIVE_STATES.has(stringValue(worker.state) ?? "")).filter((worker) => stringValue(worker.id) !== workerId).map((worker) => {
    const id = stringValue(worker.id);
    if (!id) return void 0;
    const target = stringValue(worker.intercomTarget) ?? id;
    return { id, target, ...stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}, ...stringValue(worker.role) ? { role: stringValue(worker.role) } : {}, ...stringValue(worker.state) ? { state: stringValue(worker.state) } : {}, connected: connectedTo(input.sessions, target) };
  }).filter((member) => Boolean(member));
  return { teamId, self: { id: input.selfId, ...workerId ? { workerId } : {}, isManager: !managerTarget }, manager: managerTarget ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) } : { target: input.selfId, connected: true }, coworkers };
}
function formatIntercomTeam(team) {
  const lines = [`Manager: ${team.manager ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]` : "unknown"}`, `You: ${team.self.id}${team.self.isManager ? " [manager]" : ""}`];
  if (!team.coworkers.length) lines.push("Coworkers: none");
  else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}

// opencode/runtime.ts
function matchesPendingSender(entry, to) {
  return entry.from.id === to || entry.from.name?.toLowerCase() === to.toLowerCase() || entry.from.id.startsWith(to);
}
function selectPendingAsk(entries, to, which) {
  const sorted = [...entries].sort((a, b) => a.receivedAt - b.receivedAt);
  if (sorted.length === 0) throw new Error("No matching pending ask. Call intercom_pending to inspect unresolved asks.");
  const matches = to ? sorted.filter((entry) => matchesPendingSender(entry, to)) : sorted;
  if (matches.length === 0) throw new Error(`No pending ask from "${to}".`);
  if (matches.length === 1) return matches[0];
  if (!to && new Set(matches.map((entry) => entry.from.id)).size > 1) {
    throw new Error("Multiple pending asks \u2014 specify `to` using a sender from intercom_pending.");
  }
  if (!which) {
    const sender = to ? ` from "${to}"` : "";
    throw new Error(`Multiple pending asks${sender} \u2014 specify \`which\` as \`oldest\` or \`latest\`.`);
  }
  return which === "oldest" ? matches[0] : matches[matches.length - 1];
}
function pendingSelector(entries, entry) {
  const sameSender = entries.filter((candidate) => candidate.from.id === entry.from.id);
  if (sameSender.length <= 1) return void 0;
  const index = sameSender.findIndex((candidate) => candidate.message.id === entry.message.id);
  if (index === 0) return "oldest";
  if (index === sameSender.length - 1) return "latest";
  return "queued";
}
function publicPendingEntry(entry, selector) {
  return {
    from: {
      id: entry.from.id,
      name: entry.from.name,
      origin: entry.from.origin ?? "local",
      ...entry.from.remoteHostId ? { remote_host_id: entry.from.remoteHostId } : {},
      ...entry.from.parentSessionId ? { parent_session_id: entry.from.parentSessionId } : {},
      ...entry.from.generation ? { generation: entry.from.generation } : {}
    },
    received_at: entry.receivedAt,
    read: entry.read,
    text: entry.message.content.text,
    attachments: entry.message.content.attachments,
    expects_reply: entry.message.expectsReply,
    ...selector ? { selector } : {}
  };
}
function shortHash(value) {
  return createHash2("sha256").update(value).digest("hex").slice(0, 8);
}
function buildOpenCodeRuntimeIdentity(env = process.env, cwd = env.PWD || processCwd(), pid = process.pid) {
  const sessionId = env.OPENCODE_INTERCOM_SESSION_ID?.trim() || `opencode-${pid}-${shortHash(cwd)}`;
  const cwdName = basename2(cwd) || "workspace";
  const name = env.OPENCODE_INTERCOM_NAME?.trim() || env.OPENCODE_PEER_NAME?.trim() || `opencode-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.OPENCODE_INTERCOM_MODEL?.trim() || env.OPENCODE_MODEL?.trim() || "opencode",
    startedAt: Date.now()
  };
}
function formatAttachments(attachments) {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `

---
Attachment: ${attachment.name}
~~~${attachment.language}
${attachment.content}
~~~`;
    }
    return `

---
Attachment: ${attachment.name}
${attachment.content}`;
  }).join("");
}
function resolveSessionTarget(sessions, nameOrId) {
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) return byId.id;
  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName[0]) return byName[0].id;
  if (nameOrId.length >= 4) {
    const byPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
    if (byPrefix.length > 1) {
      throw new Error(`Multiple sessions match the ID prefix "${nameOrId}". Use the full session ID or a unique name.`);
    }
    if (byPrefix[0]) return byPrefix[0].id;
  }
  return null;
}
function formatSessionDisplay(session) {
  const name = session.name || session.id;
  return session.origin === "remote" ? `${name} [remote:${session.remoteHostId || "unknown-host"}]` : name;
}
function formatSessionList(sessions, currentSessionId, currentCwd) {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : void 0,
      session.cwd === currentCwd ? "same cwd" : void 0,
      session.status
    ].filter((tag) => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${formatSessionDisplay(session)} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}
function detectGitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}
function textResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...structuredContent ? { structuredContent } : {},
    ...isError ? { isError: true } : {}
  };
}
var OpenCodeIntercomRuntime = class {
  client = null;
  connectPromise = null;
  reconnectTimer = null;
  reconnectAttempt = 0;
  reconnectEnabled = true;
  identity;
  unread = [];
  unresolvedAsks = /* @__PURE__ */ new Map();
  replyWaiters = /* @__PURE__ */ new Map();
  onInboundMessage;
  onConnectionState;
  inboundStore;
  clientFactory;
  prepareConnection;
  reconnectDelays;
  onInboundActivity;
  constructor(identity, cwd, onInboundMessage, inboundStore, options = {}) {
    this.identity = identity ?? buildOpenCodeRuntimeIdentity(process.env, cwd);
    this.onInboundMessage = onInboundMessage;
    this.clientFactory = options.clientFactory ?? (() => new IntercomClient());
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      if (!config.enabled) throw new Error("Intercom disabled");
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1e3, 2e3, 5e3];
    this.onInboundActivity = options.onInboundActivity;
    this.inboundStore = inboundStore ?? new DurableInboundStore(
      process.env.OPENCODE_INTERCOM_INBOUND_STATE?.trim() || getOpenCodeInboundStatePath(this.identity.sessionId)
    );
    this.unread = this.inboundStore.retainedEntries();
    for (const entry of this.inboundStore.unresolvedAsks()) this.unresolvedAsks.set(entry.message.id, entry);
  }
  getIdentity() {
    return this.identity;
  }
  setConnectionStateHandler(handler) {
    this.onConnectionState = handler;
  }
  async connect() {
    this.reconnectEnabled = true;
    this.clearReconnectTimer();
    if (this.client?.isConnected()) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  async connectOnce() {
    await this.prepareConnection();
    const client = this.clientFactory();
    client.on("message", (from, message, deliveryId) => {
      this.handleIncomingMessage(from, message, deliveryId);
    });
    client.on("disconnected", (error) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      }
      this.replyWaiters.clear();
      if (this.client === client) this.client = null;
      this.onConnectionState?.(false, error);
      this.scheduleReconnect();
    });
    await client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      lastActivity: Date.now(),
      status: "idle"
    }, this.identity.sessionId);
    this.client = client;
    this.reconnectAttempt = 0;
    this.onConnectionState?.(true);
    for (const entry of this.inboundStore.pendingInjection()) {
      void Promise.resolve(this.onInboundMessage?.(entry)).catch((error) => {
        console.error("Failed to replay durable inbound intercom message:", error);
      });
    }
    return client;
  }
  scheduleReconnect() {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().then((client) => {
        if (!client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch((error) => {
        this.reconnectAttempt += 1;
        this.onConnectionState?.(false, error instanceof Error ? error : new Error(String(error)));
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }
  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  async disconnect() {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
      }
    }
    const client = this.client;
    this.client = null;
    if (client) await client.disconnect();
  }
  handleIncomingMessage(from, message, deliveryId) {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
        void Promise.resolve(this.onInboundActivity?.(from, message)).catch(() => void 0);
        this.replyWaiters.delete(waiter.replyTo);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.resolve(message);
        this.client?.acknowledgeMessage(deliveryId);
        return;
      }
    }
    const entry = { from, message, deliveryId, receivedAt: Date.now(), read: false };
    const disposition = this.inboundStore.enqueue(entry);
    if (disposition !== "new") {
      this.client?.acknowledgeMessage(deliveryId);
      return;
    }
    void Promise.resolve(this.onInboundActivity?.(from, message)).catch(() => void 0);
    this.unread.push(entry);
    if (message.expectsReply) {
      this.unresolvedAsks.set(message.id, entry);
    }
    this.client?.acknowledgeMessage(deliveryId);
    void Promise.resolve(this.onInboundMessage?.(entry)).catch((error) => {
      console.error("Failed to inject inbound intercom message:", error);
    });
  }
  markInboundInjected(messageId) {
    this.inboundStore.markInjected(messageId);
  }
  markInboundReplied(messageId) {
    this.inboundStore.markReplied(messageId);
    this.unresolvedAsks.delete(messageId);
  }
  waitForReply(from, replyTo, timeoutMs = getAskTimeoutMs(), signal) {
    return new Promise((resolve3, reject) => {
      if (signal?.aborted) {
        reject(new Error("intercom_ask cancelled"));
        return;
      }
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.replyWaiters.delete(replyTo);
        cleanup();
        void this.client?.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        void this.client?.deferAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1e3)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiters.set(replyTo, { from, replyTo, resolve: resolve3, reject, timeout, cleanup });
    });
  }
  async resolveTarget(to) {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }
  async whoami() {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}
name: ${this.identity.name}
cwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model }
    );
  }
  async team() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    const team = await resolveIntercomTeam({ selfId: client.sessionId ?? this.identity.sessionId, sessions });
    return textResult(formatIntercomTeam(team), team);
  }
  async status() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}
Session ID: ${client.sessionId ?? "unknown"}
Active sessions: ${sessions.length}
Unread messages: ${this.unread.filter((entry) => !entry.read).length}
Pending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size
      }
    );
  }
  async list(scope = "machine", includeSelf = false) {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot) : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }
  async sessions(includeSelf = false) {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return includeSelf ? sessions : sessions.filter((session) => session.id !== client.sessionId);
  }
  async setSummary(summary) {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }
  async send(to, message, attachments, replyTo) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const result = await client.send(sendTo, { text: message, attachments, replyTo });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, accepted: result.accepted, delivered: false, message_id: result.id, delivery_id: result.deliveryId, code: result.code, reason: result.reason }, true);
    }
    if (replyTo) this.markInboundReplied(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, accepted: result.accepted, delivered: true, message_id: result.id, delivery_id: result.deliveryId, to });
  }
  async ask(to, message, attachments, timeoutMs = getAskTimeoutMs(), signal) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const questionId = randomUUID4();
    const replyPromise = this.waitForReply(sendTo, questionId, timeoutMs, signal);
    void replyPromise.catch(() => void 0);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:
${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error) {
      client.cancelAsk(questionId);
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
  }
  async pending(markRead = false) {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
    const lines = [
      unreadMessages.length ? unreadMessages.map((entry) => `- ${formatSessionDisplay(entry.from)}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n") : "No unread messages.",
      pendingAsks.length ? `
Pending asks:
${pendingAsks.map((entry) => {
        const selector = pendingSelector(pendingAsks, entry);
        return `- ${formatSessionDisplay(entry.from)}${selector ? ` [${selector}]` : ""}: ${entry.message.content.text}`;
      }).join("\n")}` : ""
    ].filter(Boolean);
    return textResult(lines.join("\n"), {
      unread_messages: unreadMessages.map((entry) => publicPendingEntry(entry)),
      pending_asks: pendingAsks.map((entry) => publicPendingEntry(entry, pendingSelector(pendingAsks, entry)))
    });
  }
  async reply(message, to, which) {
    let target;
    try {
      target = selectPendingAsk(Array.from(this.unresolvedAsks.values()), to, which);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
    const result = await this.send(target.from.id, message, void 0, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
};

// opencode/health.ts
import { mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname4 } from "node:path";
function normalizeOpenCodeSessionStatus(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type;
  }
  return "active";
}
var OpenCodePeerHealthReporter = class {
  path;
  health;
  constructor(input) {
    this.path = input.path?.trim() || void 0;
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
      updatedAt: Date.now()
    };
    this.write();
  }
  update(patch) {
    this.health = {
      ...this.health,
      ...patch,
      updatedAt: Date.now()
    };
    this.health.ready = this.health.connected && Boolean(this.health.openCodeSessionId) && !this.health.error;
    this.write();
    return this.snapshot();
  }
  snapshot() {
    return structuredClone(this.health);
  }
  write() {
    if (!this.path) return;
    mkdirSync3(dirname4(this.path), { recursive: true, mode: 448 });
    writeDurableJson(this.path, this.health);
  }
};

// opencode/fleet.ts
import { spawn as spawn2 } from "node:child_process";
function isFleetManagementEnabled(env = process.env) {
  const enabled = env.OPENCODE_INTERCOM_FLEET === "1" || env.OPENCODE_INTERCOM_FLEET === "true";
  if (!enabled) return false;
  const ownedWorker = env.AGENT_INTERCOM_OWNED === "1";
  const allowNested = env.OPENCODE_INTERCOM_FLEET_ALLOW_NESTED === "1";
  return !ownedWorker || allowNested;
}
async function invokeAgentFleet(params, context, env = process.env) {
  const command = env.AGENT_INTERCOM_FLEET_COMMAND?.trim() || "agent-intercom-fleet";
  const timeoutMs = Number(env.AGENT_INTERCOM_FLEET_TIMEOUT_MS || 12e4);
  return new Promise((resolve3, reject) => {
    const child = spawn2(command, [], {
      cwd: context.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve3(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(new Error(`Could not start ${command}: ${error.message}`, { cause: error })));
    child.on("close", (code) => {
      let response;
      try {
        response = JSON.parse(stdout.trim());
      } catch {
        finish(new Error(`${command} returned invalid JSON: ${stderr.trim() || stdout.trim() || `exit ${code}`}`));
        return;
      }
      if (code !== 0 || response?.ok !== true) {
        finish(new Error(response?.error || stderr.trim() || `${command} exited with ${code}`));
        return;
      }
      finish(void 0, response.result);
    });
    child.stdin.end(JSON.stringify({ params, managerSessionId: context.managerSessionId, cwd: context.cwd }));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12e4);
    timer.unref?.();
  });
}

// opencode/control.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { mkdirSync as mkdirSync4, readFileSync as readFileSync7, readdirSync, renameSync as renameSync3, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join7 } from "node:path";
var CONTROL_DIR_NAME = "opencode-control";
function controlDir() {
  const directory = join7(getIntercomDirPath(), CONTROL_DIR_NAME);
  mkdirSync4(directory, { recursive: true, mode: 448 });
  return directory;
}
function safeSessionId(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function responseName(sessionId, requestId) {
  return `${safeSessionId(sessionId)}.${requestId}.response.json`;
}
function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID5()}.tmp`;
  writeFileSync3(temporary, JSON.stringify(value), { mode: 384 });
  restrictIntercomRuntimeFile(temporary);
  renameSync3(temporary, path);
  restrictIntercomRuntimeFile(path);
}
function startOpenCodeControlServer(options) {
  const directory = controlDir();
  let processing = false;
  const timer = setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      const files = readdirSync(directory).filter((file) => file.endsWith(".request.json"));
      for (const file of files) {
        const requestPath = join7(directory, file);
        let request;
        try {
          request = JSON.parse(readFileSync7(requestPath, "utf8"));
        } catch {
          continue;
        }
        if (!request?.id || !request.sessionId || !options.acceptsSession(request.sessionId)) continue;
        const responsePath = join7(directory, responseName(request.sessionId, request.id));
        let response;
        try {
          response = { ok: true, value: await options.handle(request.action) };
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        writeJsonAtomic(responsePath, response);
        rmSync(requestPath, { force: true });
      }
    } finally {
      processing = false;
    }
  }, 100);
  timer.unref();
  return () => clearInterval(timer);
}

// opencode/notice-ingress.ts
import { createHash as createHash3, randomUUID as randomUUID6 } from "node:crypto";
import { existsSync as existsSync5, readFileSync as readFileSync8 } from "node:fs";
import { dirname as dirname5, join as join8 } from "node:path";
import {
  parseDeliveryClaimRecord,
  parseNoticeRecipientIngressEnvelope,
  parseTargetLedgerLookupResult
} from "@dataforxyz/agent-intercom-core/boss";
import {
  canonicalJson,
  assertExactKeys as assertExactKeys3,
  assertRecord as assertRecord2
} from "@dataforxyz/agent-intercom-core/canonical";
var OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION = "opencode.notice-atomic-insertion.v1";
var OPENCODE_NOTICE_CURRENT_CLAIM_EVIDENCE_VERSION = "opencode.notice-current-claim-evidence.v1";
var OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE = "OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE";
var OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE = "OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE";
var INSERTION_FENCING_UNAVAILABLE = "INSERTION_FENCING_UNAVAILABLE";
var OpenCodeNoticeAuthorityUnavailableError = class extends Error {
  code = OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE;
  constructor() {
    super("OpenCode Boss notice ingress is unavailable until an authenticated Orc/Controller authority client and typed notice-to-prompt entrypoint are provided");
    this.name = "OpenCodeNoticeAuthorityUnavailableError";
  }
};
var OpenCodeNoticeCurrentClaimUnavailableError = class extends Error {
  code = OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE;
  retryable = true;
  constructor(reason, options) {
    super(`OpenCode Boss notice insertion requires a new authenticated reservation before retry: ${reason}`, options);
    this.name = "OpenCodeNoticeCurrentClaimUnavailableError";
  }
};
var OpenCodeNoticeInsertionFencingUnavailableError = class extends Error {
  code = INSERTION_FENCING_UNAVAILABLE;
  retryable = true;
  constructor() {
    super("OpenCode Boss notice insertion is unavailable without a protected authenticated atomic current-claim/deadline-bound insertion authority");
    this.name = "OpenCodeNoticeInsertionFencingUnavailableError";
  }
};
function createProductionOpenCodeNoticeRecipientIngress() {
  throw new OpenCodeNoticeAuthorityUnavailableError();
}
function emptyState() {
  return { version: 1, records: /* @__PURE__ */ Object.create(null) };
}
function collisionResistantName(value) {
  return createHash3("sha256").update(value).digest("hex");
}
function getOpenCodeNoticeIngressStatePath(sessionId, intercomDir = getIntercomDirPath()) {
  return join8(intercomDir, `opencode-notice-ingress-${collisionResistantName(sessionId)}.json`);
}
function ownRecord(value, path) {
  assertRecord2(value, path);
  return value;
}
function exactKeys(value, required, optional, path) {
  assertExactKeys3(value, required, optional, path);
}
function payload(envelope) {
  return envelope.payload;
}
function timestamp(value, path) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${path} must be a timestamp`);
  return value;
}
function nonEmptyString2(value, path) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}
function assertSame(actual, expected, field, context) {
  if (actual !== expected) throw new Error(`${context} ${field} does not match the winning claim`);
}
function assertReservationMatches(envelope, claim) {
  if (envelope.operation !== "reserve_delivery") throw new Error("Expected reserve_delivery before prompt injection");
  if (claim.state !== "reserved") throw new Error("Notice delivery claim must be reserved before prompt injection");
  if (claim.recipientContext !== "opencode") throw new Error("Notice delivery claim is not for OpenCode");
  const request = payload(envelope);
  const comparisons = [
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
    [claim.workerGeneration, request.workerGeneration, "workerGeneration"]
  ];
  for (const [actual, expected, field] of comparisons) assertSame(actual, expected, field, "Reserved notice claim");
  if (canonicalJson(claim.memberNoticeIds) !== canonicalJson(request.memberNoticeIds)) {
    throw new Error("Reserved notice claim memberNoticeIds do not match the ingress request");
  }
  if (Date.parse(timestamp(request.requestedAt, "$.payload.requestedAt")) >= Date.parse(claim.expiresAt)) {
    throw new Error("Notice reservation was requested after the winning claim expired");
  }
}
function assertWallClockFresh(claim, now) {
  if (Date.parse(claim.expiresAt) <= now) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError("the winning delivery claim is wall-clock expired");
  }
}
function atomicInsertionRequest(record, insertion, now) {
  return {
    version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
    requestNonce: randomUUID6(),
    requestedAt: new Date(now).toISOString(),
    claim: structuredClone(record.claim),
    insertion: structuredClone(insertion)
  };
}
function parseInsertionReceipt(value, path) {
  const receipt = ownRecord(value, path);
  exactKeys(receipt, ["deliveryClaimId", "claimGeneration", "targetLedgerEntryId", "insertedAt"], [], path);
  const claimGeneration = receipt.claimGeneration;
  if (!Number.isSafeInteger(claimGeneration) || claimGeneration < 0) {
    throw new Error(`${path}.claimGeneration must be a non-negative safe integer`);
  }
  return {
    deliveryClaimId: nonEmptyString2(receipt.deliveryClaimId, `${path}.deliveryClaimId`),
    claimGeneration,
    targetLedgerEntryId: nonEmptyString2(receipt.targetLedgerEntryId, `${path}.targetLedgerEntryId`),
    insertedAt: timestamp(receipt.insertedAt, `${path}.insertedAt`)
  };
}
function parseAtomicInsertionResult(value) {
  const result = ownRecord(value, "$atomicInsertionResult");
  exactKeys(
    result,
    ["version", "requestNonce", "status"],
    ["claim", "receipt"],
    "$atomicInsertionResult"
  );
  if (result.version !== OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION) {
    throw new Error("Unsupported OpenCode atomic insertion result version");
  }
  const status = result.status;
  if (status !== "inserted" && status !== "revoked" && status !== "superseded" && status !== "expired") {
    throw new Error("$atomicInsertionResult.status is invalid");
  }
  const claim = result.claim === void 0 ? void 0 : parseDeliveryClaimRecord(result.claim);
  const receipt = result.receipt === void 0 ? void 0 : parseInsertionReceipt(result.receipt, "$atomicInsertionResult.receipt");
  if (status === "inserted" ? claim === void 0 || receipt === void 0 : claim !== void 0 || receipt !== void 0) {
    throw new Error("$atomicInsertionResult claim and receipt are present exactly for inserted status");
  }
  return {
    version: OPENCODE_NOTICE_ATOMIC_INSERTION_VERSION,
    requestNonce: nonEmptyString2(result.requestNonce, "$atomicInsertionResult.requestNonce"),
    status,
    ...claim === void 0 ? {} : { claim },
    ...receipt === void 0 ? {} : { receipt }
  };
}
function assertAtomicInsertionResultMatches(record, request, result) {
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
function assertInsertionMatches(record, envelope) {
  if (envelope.operation !== "insert_or_attach") throw new Error("Expected insert_or_attach");
  const request = payload(envelope);
  const claim = record.claim;
  const comparisons = [
    [claim.deliveryClaimId, request.deliveryClaimId, "deliveryClaimId"],
    [claim.claimGeneration, request.claimGeneration, "claimGeneration"],
    [claim.deliveryGroupId, request.deliveryGroupId, "deliveryGroupId"],
    [claim.membershipRevision, request.membershipRevision, "membershipRevision"],
    [claim.effectiveDeliveryIntent, request.effectiveDeliveryIntent, "effectiveDeliveryIntent"],
    [claim.primaryNoticeId, request.primaryNoticeId, "primaryNoticeId"],
    [claim.recipientPrincipalId, request.recipientPrincipalId, "recipientPrincipalId"],
    [claim.recipientBindingEpoch, request.recipientBindingEpoch, "recipientBindingEpoch"],
    [claim.workerGeneration, request.workerGeneration, "workerGeneration"],
    [claim.ingressMode, request.ingressMode, "ingressMode"]
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
function assertLookupMatches(record, request, lookup) {
  assertSame(record.claim.deliveryClaimId, lookup.deliveryClaimId, "deliveryClaimId", "Target ledger lookup");
  assertSame(record.claim.claimGeneration, lookup.claimGeneration, "claimGeneration", "Target ledger lookup");
  const requestedAt = timestamp(payload(request).checkedAt, "$.lookup.payload.checkedAt");
  if (Date.parse(lookup.checkedAt) < Date.parse(requestedAt)) {
    throw new Error("Target ledger result predates its authenticated lookup request");
  }
}
function assertInsertionReceiptMatches(record, receipt) {
  assertSame(record.claim.deliveryClaimId, receipt.deliveryClaimId, "deliveryClaimId", "OpenCode insertion receipt");
  assertSame(record.claim.claimGeneration, receipt.claimGeneration, "claimGeneration", "OpenCode insertion receipt");
  if (!receipt.targetLedgerEntryId) throw new Error("OpenCode insertion receipt targetLedgerEntryId is required");
  const insertedAt = timestamp(receipt.insertedAt, "$.insertedAt");
  const requestedAt = timestamp(payload(record.insertion).requestedAt, "$.insertion.payload.requestedAt");
  if (Date.parse(insertedAt) < Date.parse(requestedAt)) throw new Error("OpenCode insertion receipt predates the insertion attempt");
  if (Date.parse(insertedAt) >= Date.parse(record.claim.expiresAt)) {
    throw new OpenCodeNoticeCurrentClaimUnavailableError("the insertion receipt is not strictly before the winning claim expiry");
  }
}
function assertReceiptMatches(record, envelope) {
  if (envelope.operation !== "record_receipt") throw new Error("Expected record_receipt");
  if (!record.insertion || !record.targetLedgerEntryId || !record.insertedAt) {
    throw new Error("Cannot receipt a notice without durable target-ledger insertion evidence");
  }
  const request = payload(envelope);
  const claim = record.claim;
  const comparisons = [
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
    [payload(record.insertion).resultMessageId, request.resultMessageId, "resultMessageId"]
  ];
  for (const [actual, expected, field] of comparisons) assertSame(actual, expected, field, "Notice receipt");
}
function assertDeliveredClaimMatches(record, delivered) {
  if (delivered.state !== "delivered") throw new Error("Receipt authority did not return a delivered claim");
  const receipt = payload(record.receipt);
  const immutableFields = [
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
    "ingressMode"
  ];
  for (const field of immutableFields) assertSame(record.claim[field], delivered[field], String(field), "Delivered claim");
  if (canonicalJson(record.claim.memberNoticeIds) !== canonicalJson(delivered.memberNoticeIds)) {
    throw new Error("Delivered claim memberNoticeIds changed after reservation");
  }
  const settlement = [
    [record.targetLedgerEntryId, delivered.targetLedgerEntryId, "targetLedgerEntryId"],
    [record.insertedAt, delivered.insertedAt, "insertedAt"],
    [receipt.deliveryReceiptId, delivered.deliveryReceiptId, "deliveryReceiptId"],
    [receipt.deliveredAt, delivered.deliveredAt, "deliveredAt"],
    [receipt.resultMessageId, delivered.resultMessageId, "resultMessageId"],
    [receipt.coalescedByResult, delivered.coalescedByResult, "coalescedByResult"]
  ];
  for (const [actual, expected, field] of settlement) assertSame(actual, expected, field, "Delivered claim");
}
function parseRecord(value, path) {
  const record = ownRecord(value, path);
  exactKeys(
    record,
    ["reserve", "claim", "phase"],
    ["insertion", "targetLedgerEntryId", "insertedAt", "receipt", "deliveredClaim"],
    path
  );
  const reserve = parseNoticeRecipientIngressEnvelope(record.reserve);
  const claim = parseDeliveryClaimRecord(record.claim);
  const phase = record.phase;
  if (phase !== "reserved" && phase !== "inserting" && phase !== "inserted" && phase !== "receipting" && phase !== "delivered") {
    throw new Error(`${path}.phase is invalid`);
  }
  const insertion = record.insertion === void 0 ? void 0 : parseNoticeRecipientIngressEnvelope(record.insertion);
  const targetLedgerEntryId = record.targetLedgerEntryId === void 0 ? void 0 : String(record.targetLedgerEntryId);
  if (record.targetLedgerEntryId !== void 0 && (typeof record.targetLedgerEntryId !== "string" || record.targetLedgerEntryId.length === 0)) {
    throw new Error(`${path}.targetLedgerEntryId must be a non-empty string`);
  }
  const insertedAt = record.insertedAt === void 0 ? void 0 : timestamp(record.insertedAt, `${path}.insertedAt`);
  const receipt = record.receipt === void 0 ? void 0 : parseNoticeRecipientIngressEnvelope(record.receipt);
  const deliveredClaim = record.deliveredClaim === void 0 ? void 0 : parseDeliveryClaimRecord(record.deliveredClaim);
  const parsed = {
    reserve,
    claim,
    phase,
    ...insertion === void 0 ? {} : { insertion },
    ...targetLedgerEntryId === void 0 ? {} : { targetLedgerEntryId },
    ...insertedAt === void 0 ? {} : { insertedAt },
    ...receipt === void 0 ? {} : { receipt },
    ...deliveredClaim === void 0 ? {} : { deliveredClaim }
  };
  assertReservationMatches(reserve, claim);
  if (insertion !== void 0) assertInsertionMatches(parsed, insertion);
  const hasInsertionEvidence = targetLedgerEntryId !== void 0 || insertedAt !== void 0;
  if (hasInsertionEvidence && (targetLedgerEntryId === void 0 || insertedAt === void 0)) {
    throw new Error(`${path} target ledger evidence must be present together`);
  }
  if (phase === "reserved" && (insertion !== void 0 || hasInsertionEvidence || receipt !== void 0 || deliveredClaim !== void 0)) {
    throw new Error(`${path} reserved record contains later-phase evidence`);
  }
  if (phase === "inserting" && (insertion === void 0 || hasInsertionEvidence || receipt !== void 0 || deliveredClaim !== void 0)) {
    throw new Error(`${path} inserting record has invalid evidence`);
  }
  if (phase === "inserted" && (insertion === void 0 || !hasInsertionEvidence || receipt !== void 0 || deliveredClaim !== void 0)) {
    throw new Error(`${path} inserted record has invalid evidence`);
  }
  if (phase === "receipting" && (insertion === void 0 || !hasInsertionEvidence || receipt === void 0 || deliveredClaim !== void 0)) {
    throw new Error(`${path} receipting record has invalid evidence`);
  }
  if (phase === "delivered" && (insertion === void 0 || !hasInsertionEvidence || receipt === void 0 || deliveredClaim === void 0)) {
    throw new Error(`${path} delivered record lacks settlement evidence`);
  }
  if (receipt !== void 0) assertReceiptMatches(parsed, receipt);
  if (deliveredClaim !== void 0) assertDeliveredClaimMatches(parsed, deliveredClaim);
  return parsed;
}
function parseState(value) {
  const state = ownRecord(value, "$noticeIngress");
  exactKeys(state, ["version", "records"], [], "$noticeIngress");
  if (state.version !== 1) throw new Error("Unsupported OpenCode notice ingress state version");
  const recordsValue = ownRecord(state.records, "$noticeIngress.records");
  const records = /* @__PURE__ */ Object.create(null);
  const deliveryGroups = /* @__PURE__ */ new Set();
  for (const [claimId, value2] of Object.entries(recordsValue)) {
    const record = parseRecord(value2, `$noticeIngress.records[${JSON.stringify(claimId)}]`);
    if (record.claim.deliveryClaimId !== claimId) throw new Error("Notice ingress claim key does not match its record");
    if (deliveryGroups.has(record.claim.deliveryGroupId)) throw new Error("Multiple OpenCode notice claims own one delivery group");
    deliveryGroups.add(record.claim.deliveryGroupId);
    records[claimId] = record;
  }
  return { version: 1, records };
}
function clone(record) {
  return structuredClone(record);
}
function cloneState(state) {
  return parseState(structuredClone(state));
}
function getOwnRecord(records, deliveryClaimId) {
  return Object.hasOwn(records, deliveryClaimId) ? records[deliveryClaimId] : void 0;
}
function serializableState(state) {
  const records = {};
  for (const [deliveryClaimId, record] of Object.entries(state.records)) {
    Object.defineProperty(records, deliveryClaimId, {
      value: clone(record),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return { version: 1, records };
}
function canonicalState(state) {
  return canonicalJson(serializableState(state));
}
function targetLedgerLookupEnvelope(record) {
  if (!record.insertion) throw new Error("Cannot look up a notice before insertion begins");
  const claim = record.claim;
  const requestNonce = randomUUID6();
  const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
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
      ...claim.recipientTargetSessionId === void 0 ? {} : { recipientTargetSessionId: claim.recipientTargetSessionId },
      checkedAt
    }
  });
}
var DurableOpenCodeNoticeIngressStore = class {
  path;
  state;
  persist;
  poisoned;
  constructor(path, persist = writeDurableJson) {
    this.path = path;
    ensureIntercomRuntimeDir(dirname5(path));
    this.persist = persist;
    this.state = this.load();
  }
  get(deliveryClaimId) {
    this.assertUsable();
    const record = getOwnRecord(this.state.records, deliveryClaimId);
    return record === void 0 ? void 0 : clone(record);
  }
  reserve(envelopeValue, claimValue) {
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
    if (Object.values(this.state.records).some((record2) => record2.claim.deliveryGroupId === claim.deliveryGroupId)) {
      throw new Error("A different OpenCode notice claim already owns this delivery group");
    }
    const record = { reserve: envelope, claim, phase: "reserved" };
    const next = cloneState(this.state);
    next.records[claim.deliveryClaimId] = record;
    this.commit(next);
    return clone(record);
  }
  beginInsertion(envelopeValue) {
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
    const updated = { ...record, phase: "inserting", insertion: envelope };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[claimId] = updated;
    this.commit(next);
    return clone(updated);
  }
  markInserted(deliveryClaimId, receipt) {
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
    const updated = {
      ...record,
      phase: "inserted",
      targetLedgerEntryId: receipt.targetLedgerEntryId,
      insertedAt: receipt.insertedAt
    };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[deliveryClaimId] = updated;
    this.commit(next);
    return clone(updated);
  }
  beginReceipt(envelopeValue) {
    this.assertUsable();
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    if (envelope.operation !== "record_receipt") throw new Error("Expected record_receipt");
    const claimId = payload(envelope).deliveryClaimId;
    if (typeof claimId !== "string") throw new Error("Notice receipt omitted deliveryClaimId");
    const record = getOwnRecord(this.state.records, claimId);
    if (!record || record.phase !== "inserted" && record.phase !== "receipting" && record.phase !== "delivered") {
      throw new Error("Cannot record a receipt before durable OpenCode insertion");
    }
    assertReceiptMatches(record, envelope);
    if (record.phase !== "inserted") {
      if (canonicalJson(record.receipt) !== canonicalJson(envelope)) throw new Error("Conflicting OpenCode notice receipt replay");
      return clone(record);
    }
    const updated = { ...record, phase: "receipting", receipt: envelope };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[claimId] = updated;
    this.commit(next);
    return clone(updated);
  }
  markDelivered(deliveryClaimId, claimValue) {
    this.assertUsable();
    const record = getOwnRecord(this.state.records, deliveryClaimId);
    if (!record || record.phase !== "receipting" && record.phase !== "delivered") {
      throw new Error("Cannot settle an OpenCode notice before recording its receipt request");
    }
    const deliveredClaim = parseDeliveryClaimRecord(claimValue);
    assertDeliveredClaimMatches(record, deliveredClaim);
    if (record.phase === "delivered") {
      if (canonicalJson(record.deliveredClaim) !== canonicalJson(deliveredClaim)) throw new Error("Conflicting delivered claim replay");
      return clone(record);
    }
    const updated = { ...record, phase: "delivered", deliveredClaim };
    parseRecord(updated, "$record");
    const next = cloneState(this.state);
    next.records[deliveryClaimId] = updated;
    this.commit(next);
    return clone(updated);
  }
  pending() {
    this.assertUsable();
    return Object.values(this.state.records).filter((record) => record.phase !== "delivered").map(clone);
  }
  load() {
    if (!existsSync5(this.path)) return emptyState();
    return parseState(JSON.parse(readFileSync8(this.path, "utf8")));
  }
  loadExactTarget() {
    if (!existsSync5(this.path)) throw new Error("Durable OpenCode notice ingress target is missing");
    return parseState(JSON.parse(readFileSync8(this.path, "utf8")));
  }
  commit(next) {
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
          cause: reconcileError
        });
      }
      throw persistError;
    }
    this.state = parseState(JSON.parse(stagedCanonical));
  }
  assertUsable() {
    if (this.poisoned) throw this.poisoned;
  }
};
var OpenCodeNoticeRecipientIngress = class {
  constructor(store, authority, now = () => Date.now()) {
    this.store = store;
    this.authority = authority;
    this.now = now;
    if (!authority) throw new Error("Authenticated notice authority API is required");
  }
  store;
  authority;
  now;
  async reserveBeforePrompt(envelopeValue) {
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    if (envelope.operation !== "reserve_delivery") throw new Error("Expected reserve_delivery");
    const claim = await this.authority.reserveDelivery(envelope);
    return this.store.reserve(envelope, claim);
  }
  async insertOrAttach(envelopeValue, injectPromptOrAttach) {
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
      let rawResult;
      const guardedInsertion = async () => {
        if (!authorityCallOpen || callbackCalls !== 0) throw new Error("FENCING_CALLBACK_CLOSED");
        callbackCalls = 1;
        assertWallClockFresh(prior.claim, this.now());
        const inserting2 = this.store.beginInsertion(envelope);
        if (inserting2.phase !== "inserting") throw new Error("Protected OpenCode notice insertion did not begin from its reserved phase");
        return parseInsertionReceipt(await injectPromptOrAttach(envelope), "$protectedInsertionReceipt");
      };
      try {
        authorityCallOpen = true;
        rawResult = await new Promise((resolve3, reject) => {
          try {
            protectedInsertion.call(this.authority, request, guardedInsertion).then(
              (value) => {
                authorityCallOpen = false;
                resolve3(value);
              },
              (error) => {
                authorityCallOpen = false;
                reject(error);
              }
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
      const expectedInserting = {
        ...prior,
        phase: "inserting",
        insertion: envelope
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
          targetLedgerEntryId: lookup.targetLedgerEntryId,
          insertedAt: lookup.insertedAt
        });
      }
      if (lookup.state !== "absent") {
        throw new Error(`Authenticated target ledger is ${lookup.state}; refusing ambiguous OpenCode replay`);
      }
      throw new Error(
        "Authenticated target-drained proof and generation-incremented current-claim reissue authority are unavailable; refusing OpenCode reinsertion"
      );
    }
    throw new Error("Unexpected OpenCode notice insertion state");
  }
  async recordReceipt(envelopeValue) {
    const envelope = parseNoticeRecipientIngressEnvelope(envelopeValue);
    const record = this.store.beginReceipt(envelope);
    if (record.phase === "delivered") return record;
    const deliveredClaim = await this.authority.recordReceipt(envelope);
    return this.store.markDelivered(record.claim.deliveryClaimId, deliveredClaim);
  }
};

// opencode/plugin.ts
var INJECT_LOG_PATH = "/tmp/intercom-inject.log";
function resultText(result) {
  const text = result.content.map((part) => part.text).join("\n");
  if (result.isError) {
    throw new Error(text);
  }
  return text;
}
function listScope(value) {
  if (value === void 0) return "machine";
  if (value === "machine" || value === "directory" || value === "repo") return value;
  throw new Error('scope must be one of "machine", "directory", or "repo"');
}
var OpenCodeIntercomPlugin = async ({ client, directory, serverUrl }) => {
  let activeSessionID = process.env.OPENCODE_INTERCOM_TARGET_SESSION?.trim() || process.env.OPENCODE_SESSION_ID?.trim() || void 0;
  let activeSessionStatus = "idle";
  const knownSessionIDs = /* @__PURE__ */ new Set();
  let flushingInjectQueue = false;
  const pendingInjectQueue = [];
  const deliveredMessageIDs = /* @__PURE__ */ new Set();
  let runtime;
  let healthReporter;
  const canUseTuiInjection = Boolean(process.stdin.isTTY || process.stdout.isTTY);
  const debugInject = process.env.OPENCODE_INTERCOM_DEBUG === "1";
  const fleetManagementEnabled = isFleetManagementEnabled();
  let fleetHeartbeatRunning = false;
  let fleetHeartbeat;
  function logInject(step, details) {
    if (!debugInject) {
      return;
    }
    try {
      appendFileSync(INJECT_LOG_PATH, `${JSON.stringify({ time: (/* @__PURE__ */ new Date()).toISOString(), step, ...details })}
`);
    } catch {
    }
  }
  function formatError(error) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause
      };
    }
    return { value: error };
  }
  async function logResult(step, result, details = {}) {
    const responseBody = result.response ? await result.response.clone().text().catch(() => void 0) : void 0;
    logInject(step, {
      ...details,
      ok: result.error === void 0,
      status: result.response?.status,
      data: result.data,
      error: result.error,
      responseBody
    });
  }
  function rememberBounded(values, value, limit = 4096) {
    values.add(value);
    while (values.size > limit) {
      const oldest = values.values().next().value;
      if (typeof oldest !== "string") break;
      values.delete(oldest);
    }
  }
  function setActiveSession(sessionID) {
    if (typeof sessionID === "string" && sessionID.trim()) {
      activeSessionID = sessionID;
      rememberBounded(knownSessionIDs, sessionID);
      healthReporter?.update({ openCodeSessionId: sessionID, status: activeSessionStatus });
    }
  }
  function messageMarker(messageID) {
    return `[agent-intercom-message:${messageID}]`;
  }
  function formatInboundPrompt(entry) {
    const from = formatSessionDisplay(entry.from);
    const replyHint = entry.message.expectsReply ? "\n\nThis message expects a reply. Use intercom_reply with only your reply text while this turn is active. If you reply later, use intercom_pending plus the sender and oldest/latest selector." : "";
    return [
      `Incoming intercom message from ${from} (${entry.from.model}, ${entry.from.cwd}):`,
      "",
      entry.message.content.text + formatAttachments(entry.message.content.attachments),
      replyHint,
      messageMarker(entry.message.id)
    ].join("\n");
  }
  async function resolveActiveSessionID() {
    if (activeSessionID) {
      return activeSessionID;
    }
    const sessionList = await client.session.list({ query: { directory } }).catch((error) => {
      logInject("session.list.error", { error: formatError(error) });
      return void 0;
    });
    if (sessionList) {
      await logResult("session.list", sessionList);
    }
    const sessions = sessionList?.data;
    if (!sessions?.length) {
      return void 0;
    }
    const latestSession = sessions.reduce((latest, session) => {
      if (session.time.created > latest.time.created) {
        return session;
      }
      if (session.time.created === latest.time.created && session.time.updated > latest.time.updated) {
        return session;
      }
      return latest;
    });
    setActiveSession(latestSession.id);
    logInject("session.resolve", { sessionID: latestSession.id, sessionCount: sessions.length });
    return latestSession.id;
  }
  function enqueuePendingInject(entry, reason) {
    if (deliveredMessageIDs.has(entry.message.id)) {
      logInject("queue.skip_delivered", { reason, messageID: entry.message.id });
      return;
    }
    if (pendingInjectQueue.some((queued) => queued.entry.message.id === entry.message.id)) {
      logInject("queue.skip_duplicate", { reason, messageID: entry.message.id });
      return;
    }
    pendingInjectQueue.push({ entry });
    logInject("queue.enqueue", { reason, messageID: entry.message.id, queueLength: pendingInjectQueue.length });
  }
  function markDelivered(messageID, path) {
    rememberBounded(deliveredMessageIDs, messageID);
    runtime.markInboundInjected(messageID);
    const queueIndex = pendingInjectQueue.findIndex((queued) => queued.entry.message.id === messageID);
    if (queueIndex >= 0) {
      pendingInjectQueue.splice(queueIndex, 1);
    }
    logInject("message.delivered", { messageID, path, queueLength: pendingInjectQueue.length });
  }
  async function sessionAlreadyContainsMessage(sessionID, messageID) {
    const marker = messageMarker(messageID);
    const result = await client.session.messages({
      path: { id: sessionID },
      query: { directory, limit: 200 }
    }).catch((error) => {
      logInject("session.messages.error", { sessionID, messageID, error: formatError(error) });
      return void 0;
    });
    const messages = result?.data;
    if (!messages) return false;
    return messages.some((message) => message.parts.some((part) => {
      if (part.type !== "text") return false;
      const metadata = part.metadata;
      return metadata?.intercomMessageId === messageID || part.text.includes(marker);
    }));
  }
  async function flushPendingInjectQueue(trigger) {
    if (flushingInjectQueue || !pendingInjectQueue.length) {
      return;
    }
    const sessionID = await resolveActiveSessionID();
    if (!sessionID) {
      logInject("queue.flush.skip", { trigger, reason: "no_session_id", queueLength: pendingInjectQueue.length });
      return;
    }
    flushingInjectQueue = true;
    logInject("queue.flush.start", { trigger, sessionID, queueLength: pendingInjectQueue.length });
    try {
      while (pendingInjectQueue.length) {
        const queued = pendingInjectQueue[0];
        const entry = queued.entry;
        if (deliveredMessageIDs.has(entry.message.id)) {
          pendingInjectQueue.shift();
          logInject("queue.flush.skip_delivered", { trigger, messageID: entry.message.id });
          continue;
        }
        const prompt = formatInboundPrompt(entry);
        if (await sessionAlreadyContainsMessage(sessionID, entry.message.id)) {
          markDelivered(entry.message.id, "session.messages.replay_dedupe");
          continue;
        }
        let result;
        try {
          result = await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory },
            body: {
              parts: [{ type: "text", text: prompt, metadata: { intercomMessageId: entry.message.id } }]
            }
          });
        } catch (error) {
          logInject("queue.flush.promptAsync.throw", {
            trigger,
            sessionID,
            messageID: entry.message.id,
            error: formatError(error)
          });
          break;
        }
        await logResult("queue.flush.promptAsync", result, {
          trigger,
          sessionID,
          messageID: entry.message.id
        });
        if (result.error !== void 0 || !result.response?.ok) {
          break;
        }
        markDelivered(entry.message.id, "queue.flush.promptAsync");
      }
    } finally {
      logInject("queue.flush.end", { trigger, remaining: pendingInjectQueue.length });
      flushingInjectQueue = false;
    }
  }
  async function injectInbound(entry) {
    const from = formatSessionDisplay(entry.from);
    const prompt = formatInboundPrompt(entry);
    if (deliveredMessageIDs.has(entry.message.id)) {
      logInject("inject.skip_delivered", { messageID: entry.message.id });
      return;
    }
    const busy = activeSessionStatus !== "idle";
    logInject("inject.start", {
      messageID: entry.message.id,
      from,
      activeSessionID,
      activeSessionStatus
    });
    if (busy) {
      enqueuePendingInject(entry, "session_busy_pre_tui");
    }
    logInject("inject.mode", {
      messageID: entry.message.id,
      canUseTuiInjection,
      busy
    });
    try {
      const toastResult = await client.tui.showToast({
        body: {
          title: `Intercom from ${from}`,
          message: entry.message.content.text.slice(0, 240),
          variant: entry.message.expectsReply ? "warning" : "info",
          duration: 8e3
        },
        query: { directory }
      });
      await logResult("inject.toast", toastResult, { messageID: entry.message.id });
    } catch (error) {
      logInject("inject.toast.throw", { messageID: entry.message.id, error: formatError(error) });
    }
    if (canUseTuiInjection) {
      try {
        const appended = await client.tui.appendPrompt({
          body: { text: prompt },
          query: { directory }
        });
        await logResult("inject.append", appended, { messageID: entry.message.id });
        if (appended.data === true) {
          try {
            const submitResult = await client.tui.submitPrompt({ query: { directory } });
            await logResult("inject.submit", submitResult, { messageID: entry.message.id });
            if (!busy) {
              markDelivered(entry.message.id, "tui.submit");
              return;
            }
          } catch (error) {
            logInject("inject.submit.throw", { messageID: entry.message.id, error: formatError(error) });
          }
        }
      } catch (error) {
        logInject("inject.append.throw", { messageID: entry.message.id, error: formatError(error) });
      }
    } else {
      logInject("inject.tui_skipped", { messageID: entry.message.id, reason: "headless" });
    }
    const sessionID = await resolveActiveSessionID();
    if (!sessionID) {
      logInject("inject.no_session", { messageID: entry.message.id });
      return;
    }
    logInject("inject.session_target", {
      messageID: entry.message.id,
      sessionID,
      activeSessionStatus,
      busy
    });
    try {
      if (await sessionAlreadyContainsMessage(sessionID, entry.message.id)) {
        markDelivered(entry.message.id, "session.messages.inject_dedupe");
        return;
      }
      const asyncResult = await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt, metadata: { intercomMessageId: entry.message.id } }]
        }
      });
      await logResult("inject.promptAsync", asyncResult, { messageID: entry.message.id, sessionID, busy });
      if (asyncResult.error === void 0 && asyncResult.response?.ok) {
        markDelivered(entry.message.id, "session.promptAsync");
      } else {
        enqueuePendingInject(entry, "prompt_async_error");
      }
    } catch (error) {
      logInject("inject.promptAsync.throw", {
        messageID: entry.message.id,
        sessionID,
        error: formatError(error)
      });
      enqueuePendingInject(entry, "prompt_async_throw");
    }
  }
  runtime = new OpenCodeIntercomRuntime(void 0, directory, injectInbound, void 0, {
    onInboundActivity(from) {
      if (!fleetManagementEnabled) return;
      void invokeAgentFleet({ action: "renew", id: from.id }, {
        managerSessionId: runtime.getIdentity().sessionId,
        cwd: directory
      }, { ...process.env, AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1" }).catch(() => void 0);
    }
  });
  const runtimeIdentity = runtime.getIdentity();
  healthReporter = new OpenCodePeerHealthReporter({
    path: process.env.AGENT_INTERCOM_OPENCODE_HEALTH_PATH,
    runId: process.env.AGENT_INTERCOM_RUN_ID,
    workerId: process.env.AGENT_INTERCOM_WORKER_ID,
    intercomSessionId: runtimeIdentity.sessionId,
    serverUrl: serverUrl.toString(),
    directory
  });
  runtime.setConnectionStateHandler((connected, error) => {
    healthReporter.update({
      connected,
      status: connected ? activeSessionStatus : "reconnecting",
      error: error?.message
    });
  });
  void (async () => {
    try {
      await runtime.connect();
      healthReporter.update({ connected: true, status: activeSessionStatus, error: void 0 });
      await resolveActiveSessionID();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      healthReporter.update({ connected: false, status: "error", error: message });
      console.error("Failed to start OpenCode intercom listener:", error);
    }
  })();
  if (activeSessionID) rememberBounded(knownSessionIDs, activeSessionID);
  if (fleetManagementEnabled) {
    fleetHeartbeat = setInterval(() => {
      if (fleetHeartbeatRunning) return;
      fleetHeartbeatRunning = true;
      void invokeAgentFleet({ action: "_heartbeat" }, {
        managerSessionId: runtimeIdentity.sessionId,
        cwd: directory
      }).then(async (result) => {
        const requests = Array.isArray(result?.details?.checkpointRequests) ? result.details.checkpointRequests : [];
        for (const request of requests) {
          if (typeof request?.target !== "string" || typeof request?.message !== "string") continue;
          await runtime.send(request.target, request.message);
        }
      }).catch((error) => {
        logInject("fleet.heartbeat.error", { error: formatError(error) });
      }).finally(() => {
        fleetHeartbeatRunning = false;
      });
    }, 6e4);
    fleetHeartbeat.unref?.();
  }
  const stopControlServer = startOpenCodeControlServer({
    acceptsSession: (sessionID) => knownSessionIDs.has(sessionID),
    async handle(action) {
      if (action.type === "whoami") {
        return runtime.getIdentity();
      }
      if (action.type === "list") {
        return runtime.sessions(false);
      }
      if (action.type === "send") {
        if (typeof action.to !== "string" || typeof action.message !== "string" || !action.message.trim()) {
          throw new Error("Invalid intercom send request.");
        }
        const result = await runtime.send(action.to, action.message);
        if (result.isError) throw new Error(result.content.map((part) => part.text).join("\n"));
        return result.structuredContent ?? { ok: true };
      }
      throw new Error("Unsupported OpenCode intercom action.");
    }
  });
  return {
    dispose: async () => {
      if (fleetHeartbeat) clearInterval(fleetHeartbeat);
      fleetHeartbeat = void 0;
      stopControlServer();
      healthReporter.update({ connected: false, ready: false, status: "stopped" });
      await runtime.disconnect();
    },
    tool: {
      ...fleetManagementEnabled ? {
        agent_fleet: tool({
          description: "Create, inspect, adopt, stop, and clean up systemd-owned Pi, Codex, Claude, and OpenCode coworkers. Spawn/list results include direct Intercom targets; list/status default to this manager's workers. Enabled only for an explicitly configured primary OpenCode manager.",
          args: {
            action: tool.schema.string().describe("Fleet action: spawn, list, status, stop, cleanup, doctor, versions, update, logs, renew, forget, adopt, capabilities, profiles, models, variants, or config."),
            id: tool.schema.string().optional().describe("Stable worker ID."),
            harness: tool.schema.string().optional().describe("pi, codex, claude, or opencode."),
            role: tool.schema.string().optional().describe("Worker role or configured role preset."),
            task: tool.schema.string().optional().describe("Assignment or standing mandate."),
            cwd: tool.schema.string().optional().describe("Worker working directory."),
            profile: tool.schema.string().optional().describe("Configured launch profile."),
            model: tool.schema.string().optional().describe("Harness model identifier."),
            effort: tool.schema.string().optional().describe("Normalized effort or OpenCode model variant."),
            instructions: tool.schema.string().optional().describe("Additional standing instructions."),
            fresh: tool.schema.boolean().optional().describe("Start a fresh persistent session rather than resume this worker ID."),
            all: tool.schema.boolean().optional().describe("Include workers owned by other manager sessions for list/status diagnostics."),
            execute: tool.schema.boolean().optional().describe("Actually execute cleanup or updates; false previews."),
            acknowledge: tool.schema.boolean().optional().describe("Manager acknowledgment required before deleting a stopped worker record."),
            lines: tool.schema.number().optional().describe("Journal lines for logs.")
          },
          async execute(args, context) {
            setActiveSession(context.sessionID);
            const result = await invokeAgentFleet(args, {
              managerSessionId: runtimeIdentity.sessionId,
              cwd: directory
            });
            return resultText(result);
          }
        })
      } : {},
      intercom_whoami: tool({
        description: "Show this OpenCode session's intercom identity.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.whoami());
        }
      }),
      intercom_team: tool({
        description: "Show your current manager and the live coworkers owned by that manager. No arguments are required.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.team());
        }
      }),
      intercom_status: tool({
        description: "Show local intercom connection status and pending message counts.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.status());
        }
      }),
      intercom_list: tool({
        description: "List local Pi, Codex, Claude, and OpenCode intercom sessions.",
        args: {
          scope: tool.schema.string().optional().describe('Filter sessions: "machine", "directory", or "repo".'),
          include_self: tool.schema.boolean().optional().describe("Include this OpenCode session in the result.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.list(listScope(args.scope), args.include_self ?? false));
        }
      }),
      intercom_set_summary: tool({
        description: "Publish a short discoverable status for this OpenCode session.",
        args: {
          summary: tool.schema.string().describe("Short status shown to other intercom sessions.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.setSummary(args.summary));
        }
      }),
      intercom_send: tool({
        description: "Send a non-blocking message to another local intercom session.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Message text to send.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.send(args.to, args.message));
        }
      }),
      intercom_ask: tool({
        description: "Ask another local intercom session a question only when the next step depends on its reply. Use intercom_send for assignments, progress/status checkpoints, and notifications.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Question text to send."),
          timeout_ms: tool.schema.number().optional().describe("Reply timeout in milliseconds, max 120000.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          const timeoutMs = args.timeout_ms === void 0 ? void 0 : validateAskTimeoutMs(args.timeout_ms);
          return resultText(await runtime.ask(args.to, args.message, void 0, timeoutMs));
        }
      }),
      intercom_pending: tool({
        description: "Read queued inbound intercom messages and unresolved asks.",
        args: {
          mark_read: tool.schema.boolean().optional().describe("Mark unread messages as read after returning them.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.pending(args.mark_read ?? false));
        }
      }),
      intercom_reply: tool({
        description: "Reply to a pending inbound intercom ask. Use to plus which=oldest/latest when one sender has multiple unresolved asks.",
        args: {
          message: tool.schema.string().describe("Reply text."),
          to: tool.schema.string().optional().describe("Optional sender name/id; never a message or thread ID."),
          which: tool.schema.enum(["oldest", "latest"]).optional().describe("Select the oldest or latest ask from the chosen sender.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.reply(args.message, args.to, args.which));
        }
      })
    },
    event: async ({ event }) => {
      const properties = event.properties;
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties?.info;
        setActiveSession(info?.id);
      } else {
        setActiveSession(properties?.sessionID);
      }
      if (event.type === "session.idle") {
        activeSessionStatus = "idle";
        healthReporter.update({ status: "idle", connected: true, error: void 0 });
        await runtime.setSummary("idle");
        await flushPendingInjectQueue("session.idle");
      } else if (event.type === "session.status") {
        const status = normalizeOpenCodeSessionStatus(properties?.status);
        activeSessionStatus = status;
        healthReporter.update({ status, connected: true, error: void 0 });
        await runtime.setSummary(status);
      }
    }
  };
};
var plugin_default = OpenCodeIntercomPlugin;
export {
  DurableOpenCodeNoticeIngressStore,
  OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE,
  OPENCODE_NOTICE_CURRENT_CLAIM_EVIDENCE_VERSION,
  OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE,
  OpenCodeIntercomPlugin,
  OpenCodeNoticeAuthorityUnavailableError,
  OpenCodeNoticeCurrentClaimUnavailableError,
  OpenCodeNoticeRecipientIngress,
  createProductionOpenCodeNoticeRecipientIngress,
  plugin_default as default,
  getOpenCodeNoticeIngressStatePath
};
