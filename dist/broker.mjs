// broker/broker.ts
import net from "net";
import { existsSync as existsSync2, readFileSync as readFileSync4, renameSync as renameSync2, writeFileSync as writeFileSync3, unlinkSync as unlinkSync2 } from "fs";
import { join as join2 } from "path";
import { randomUUID as randomUUID3 } from "crypto";

// node_modules/@dataforxyz/agent-intercom-core/dist/policy.js
var POLICY_SEMANTICS_VERSION = 2;
function activePrincipal(state, id) {
  return state.principals[id];
}
function isDirectParentPair(left, right) {
  return left.parentSessionId === right.id || right.parentSessionId === left.id;
}
function isAncestor(state, ancestorId, descendantId) {
  if (ancestorId === descendantId)
    return false;
  const visited = /* @__PURE__ */ new Set();
  let current = state.principals[descendantId];
  while (current?.parentSessionId && !visited.has(current.id)) {
    if (current.parentSessionId === ancestorId)
      return true;
    visited.add(current.id);
    current = state.principals[current.parentSessionId];
  }
  return false;
}
function authorize(state, actorId, action, targetId, context = {}) {
  const actor = activePrincipal(state, actorId);
  const target = activePrincipal(state, targetId);
  if (!actor || !target)
    return { allowed: false, code: "UNKNOWN_PRINCIPAL" };
  if (actor.state !== "active" || target.state !== "active")
    return { allowed: false, code: "REVOKED_PRINCIPAL" };
  if (context.actorGeneration !== void 0 && context.actorGeneration !== actor.generation || context.targetGeneration !== void 0 && context.targetGeneration !== target.generation) {
    return { allowed: false, code: "STALE_GENERATION" };
  }
  if (actor.id === target.id)
    return { allowed: true, reason: "self" };
  if (actor.kind === "local" && target.kind === "local")
    return { allowed: true, reason: "local-public" };
  if (action === "discover" || action === "send" || action === "ask" || action === "reply") {
    if (isDirectParentPair(actor, target))
      return { allowed: true, reason: "direct-parent" };
    if (isAncestor(state, actor.id, target.id) || isAncestor(state, target.id, actor.id)) {
      return { allowed: true, reason: "ancestor-chain" };
    }
  }
  if (action === "inspect_tree" || action === "revoke" || action === "adopt") {
    if (isAncestor(state, actor.id, target.id))
      return { allowed: true, reason: "ancestor-control" };
  }
  return { allowed: false, code: "POLICY_DENIED" };
}

// node_modules/@dataforxyz/agent-intercom-core/dist/policy-vectors.js
var localRoot = {
  id: "local-root",
  kind: "local",
  state: "active",
  generation: 1,
  policy: "local-public",
  rootSessionId: "local-root"
};
var localPeer = {
  id: "local-peer",
  kind: "local",
  state: "active",
  generation: 1,
  policy: "local-public",
  rootSessionId: "local-peer"
};
var remoteManager = {
  id: "remote-manager",
  kind: "remote",
  state: "active",
  generation: 1,
  policy: "remote-tree",
  parentSessionId: "local-root",
  rootSessionId: "local-root"
};
var remoteChild = {
  id: "remote-child",
  kind: "remote",
  state: "active",
  generation: 1,
  policy: "remote-tree",
  parentSessionId: "remote-manager",
  rootSessionId: "local-root"
};
var remoteSibling = {
  id: "remote-sibling",
  kind: "remote",
  state: "active",
  generation: 1,
  policy: "remote-tree",
  parentSessionId: "remote-manager",
  rootSessionId: "local-root"
};
var POLICY_VECTORS = [
  {
    name: "local sessions remain public",
    principals: [localRoot, localPeer],
    actorId: "local-root",
    action: "send",
    targetId: "local-peer",
    expectedAllowed: true,
    expectedReasonOrCode: "local-public"
  },
  {
    name: "remote manager can reach direct local parent",
    principals: [localRoot, remoteManager],
    actorId: "remote-manager",
    action: "send",
    targetId: "local-root",
    expectedAllowed: true,
    expectedReasonOrCode: "direct-parent"
  },
  {
    name: "local parent can reach direct remote child",
    principals: [localRoot, remoteManager],
    actorId: "local-root",
    action: "ask",
    targetId: "remote-manager",
    expectedAllowed: true,
    expectedReasonOrCode: "direct-parent"
  },
  {
    name: "remote child can reach its local root through the ancestor chain",
    principals: [localRoot, remoteManager, remoteChild],
    actorId: "remote-child",
    action: "send",
    targetId: "local-root",
    expectedAllowed: true,
    expectedReasonOrCode: "ancestor-chain"
  },
  {
    name: "remote siblings cannot communicate in phase one",
    principals: [localRoot, remoteManager, remoteChild, remoteSibling],
    actorId: "remote-child",
    action: "discover",
    targetId: "remote-sibling",
    expectedAllowed: false,
    expectedReasonOrCode: "POLICY_DENIED"
  },
  {
    name: "unrelated local session cannot discover remote principal",
    principals: [localRoot, localPeer, remoteManager],
    actorId: "local-peer",
    action: "discover",
    targetId: "remote-manager",
    expectedAllowed: false,
    expectedReasonOrCode: "POLICY_DENIED"
  },
  {
    name: "remote principal cannot reach unrelated local session",
    principals: [localRoot, localPeer, remoteManager],
    actorId: "remote-manager",
    action: "send",
    targetId: "local-peer",
    expectedAllowed: false,
    expectedReasonOrCode: "POLICY_DENIED"
  },
  {
    name: "remote manager may inspect its descendant subtree",
    principals: [localRoot, remoteManager, remoteChild],
    actorId: "remote-manager",
    action: "inspect_tree",
    targetId: "remote-child",
    expectedAllowed: true,
    expectedReasonOrCode: "ancestor-control"
  },
  {
    name: "remote child cannot revoke its ancestor",
    principals: [localRoot, remoteManager, remoteChild],
    actorId: "remote-child",
    action: "revoke",
    targetId: "remote-manager",
    expectedAllowed: false,
    expectedReasonOrCode: "POLICY_DENIED"
  },
  {
    name: "remote principal may request attenuated delegation under itself",
    principals: [localRoot, remoteManager],
    actorId: "remote-manager",
    action: "delegate_child",
    targetId: "remote-manager",
    expectedAllowed: true,
    expectedReasonOrCode: "self"
  },
  {
    name: "revoked principal cannot communicate",
    principals: [localRoot, { ...remoteManager, state: "revoked" }],
    actorId: "remote-manager",
    action: "send",
    targetId: "local-root",
    expectedAllowed: false,
    expectedReasonOrCode: "REVOKED_PRINCIPAL"
  },
  {
    name: "stale actor generation cannot send",
    principals: [localRoot, { ...remoteManager, generation: 2 }],
    actorId: "remote-manager",
    action: "send",
    targetId: "local-root",
    context: { actorGeneration: 1 },
    expectedAllowed: false,
    expectedReasonOrCode: "STALE_GENERATION"
  }
];
var POLICY_SEMANTICS_HASH = "f3b00e503631bc91123aedfbcf1df72cc9913e1893c09728b2c598f3dcdfdfe0";

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;
function writeMessage(socket, msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}
function createMessageReader(onMessage, onError, maxFrameBytes = MAX_FRAME_BYTES) {
  let buffer = Buffer.alloc(0);
  function reportMessage(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf-8"));
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
      const payload = buffer.subarray(4, 4 + length);
      buffer = Buffer.alloc(0);
      if (!reportMessage(payload)) {
        return;
      }
    }
  };
}

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
function getBrokerAskStateFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-asks.json");
}
function getBrokerAccessStateFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-access.json");
}
function getBrokerAdminCredentialFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-admin.json");
}
function getBrokerAuditFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-audit.jsonl");
}
function getRemoteGatewaySocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-remote-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "remote-gateway.sock");
}
function getBrokerSocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "broker.sock");
}
function getBrokerListenTarget(platform = process.platform, env = process.env) {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    return { transport: "tcp", host: INTERCOM_TCP_HOST, port: 0 };
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

// config.ts
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

// durable-json.ts
import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
function writeDurableJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: INTERCOM_RUNTIME_FILE_MODE });
  const fileDescriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporaryPath, filePath);
  restrictIntercomRuntimeFile(filePath);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(dirname(filePath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

// broker/ownership.ts
import { closeSync as closeSync2, constants, openSync as openSync2, readFileSync as readFileSync2, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
function ownerPid(path) {
  try {
    const pid = Number.parseInt(readFileSync2(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function acquireBrokerOwnership(path, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync2(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, INTERCOM_RUNTIME_FILE_MODE);
      try {
        writeFileSync2(fd, String(pid));
      } finally {
        closeSync2(fd);
      }
      restrictIntercomRuntimeFile(path);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existingPid = ownerPid(path);
      if (existingPid !== null && pidIsAlive(existingPid)) {
        throw new Error(`Intercom broker already owned by live process ${existingPid}`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire intercom broker ownership");
}
function releaseBrokerOwnership(path, pid = process.pid) {
  if (ownerPid(path) !== pid) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function hasBrokerOwnership(path, pid = process.pid) {
  return ownerPid(path) === pid;
}

// broker/access-registry.ts
import { createHash, randomBytes, randomUUID as randomUUID2, timingSafeEqual } from "crypto";
import { existsSync, readFileSync as readFileSync3 } from "fs";
var REMOTE_ACCESS_STATE_VERSION = 2;
var REMOTE_ACCESS_CREDENTIAL_VERSION = 1;
var DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1e3;
var DEFAULT_PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var RemoteAccessError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RemoteAccessError";
  }
  code;
};
function emptyState() {
  return { version: REMOTE_ACCESS_STATE_VERSION, principals: {}, enrollments: {} };
}
function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
function secretsMatch(secret, expectedHash) {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function newSecret() {
  return randomBytes(32).toString("base64url");
}
function requireText(value, field, maxLength = 512) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}
function boundedInteger(value, fallback, field, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error(`Invalid ${field}`);
  return resolved;
}
function parseState(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected object");
  const state = raw;
  if (state.version !== 1 && state.version !== REMOTE_ACCESS_STATE_VERSION) throw new Error("unsupported version");
  if (typeof state.principals !== "object" || state.principals === null || Array.isArray(state.principals)) throw new Error("invalid principals");
  if (typeof state.enrollments !== "object" || state.enrollments === null || Array.isArray(state.enrollments)) throw new Error("invalid enrollments");
  if (state.adminCredentialHash !== void 0 && typeof state.adminCredentialHash !== "string") throw new Error("invalid admin credential hash");
  const principals = {};
  for (const [id, value] of Object.entries(state.principals)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid principal ${id}`);
    const principal = value;
    if (principal.id !== id || typeof principal.name !== "string" || typeof principal.credentialHash !== "string" || typeof principal.parentSessionId !== "string" || typeof principal.rootSessionId !== "string" || typeof principal.remoteHostId !== "string" || typeof principal.generation !== "number" || principal.state !== "active" && principal.state !== "revoked" || typeof principal.expiresAt !== "number" || typeof principal.createdAt !== "number" || typeof principal.updatedAt !== "number") throw new Error(`invalid principal ${id}`);
    const depth = boundedInteger(principal.depth, 1, "principal depth", 1, 32);
    const maxDepth = boundedInteger(principal.maxDepth, depth, "maximum delegation depth", depth, 32);
    const maxChildren = boundedInteger(principal.maxChildren, 0, "maximum child count", 0, 128);
    principals[id] = {
      ...principal,
      policy: "remote-tree",
      canDelegate: principal.canDelegate === true,
      depth,
      maxDepth,
      maxChildren
    };
  }
  const enrollments = {};
  for (const [hash, value] of Object.entries(state.enrollments)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid enrollment ${hash}`);
    const enrollment = value;
    const template = enrollment.template;
    if (!template || typeof template !== "object") throw new Error(`invalid enrollment ${hash}`);
    const depth = boundedInteger(template.depth, 1, "enrollment depth", 1, 32);
    enrollments[hash] = {
      ...enrollment,
      template: {
        ...template,
        canDelegate: template.canDelegate === true,
        depth,
        maxDepth: boundedInteger(template.maxDepth, depth, "enrollment maximum depth", depth, 32),
        maxChildren: boundedInteger(template.maxChildren, 0, "enrollment maximum children", 0, 128)
      }
    };
  }
  return {
    version: REMOTE_ACCESS_STATE_VERSION,
    ...typeof state.adminCredentialHash === "string" ? { adminCredentialHash: state.adminCredentialHash } : {},
    principals,
    enrollments
  };
}
var RemoteAccessRegistry = class {
  constructor(statePath, now = Date.now) {
    this.statePath = statePath;
    this.now = now;
    this.state = this.load();
  }
  statePath;
  now;
  state;
  snapshot() {
    return structuredClone(this.state);
  }
  ensureAdminCredential(credentialPath) {
    if (existsSync(credentialPath)) {
      const parsed = JSON.parse(readFileSync3(credentialPath, "utf8"));
      if (parsed.version === REMOTE_ACCESS_CREDENTIAL_VERSION && typeof parsed.adminToken === "string" && parsed.adminToken.length >= 32) {
        const hash = hashSecret(parsed.adminToken);
        if (this.state.adminCredentialHash !== hash) {
          this.state.adminCredentialHash = hash;
          this.persist();
        }
        restrictIntercomRuntimeFile(credentialPath);
        return parsed.adminToken;
      }
    }
    const adminToken = newSecret();
    writeDurableJson(credentialPath, { version: REMOTE_ACCESS_CREDENTIAL_VERSION, adminToken });
    this.state.adminCredentialHash = hashSecret(adminToken);
    this.persist();
    return adminToken;
  }
  authenticateAdmin(adminToken) {
    return typeof this.state.adminCredentialHash === "string" && secretsMatch(adminToken, this.state.adminCredentialHash);
  }
  issueEnrollment(template, ttlMs = DEFAULT_ENROLLMENT_TTL_MS) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1e3) throw new Error("Invalid enrollment TTL");
    const now = this.now();
    const enrollmentToken = newSecret();
    const tokenHash = hashSecret(enrollmentToken);
    const expiresAt = now + ttlMs;
    const principalExpiresAt = template.expiresAt ?? now + DEFAULT_PRINCIPAL_TTL_MS;
    if (!Number.isSafeInteger(principalExpiresAt) || principalExpiresAt <= now) throw new Error("Invalid principal expiry");
    const depth = boundedInteger(template.depth, 1, "principal depth", 1, 32);
    const maxDepth = boundedInteger(template.maxDepth, depth, "maximum delegation depth", depth, 32);
    const maxChildren = boundedInteger(template.maxChildren, 0, "maximum child count", 0, 128);
    const canDelegate = template.canDelegate === true;
    if (canDelegate && (maxDepth <= depth || maxChildren === 0)) throw new Error("Delegating principals require remaining depth and child capacity");
    const normalized = {
      name: requireText(template.name, "principal name", 256),
      parentSessionId: requireText(template.parentSessionId, "parent session ID"),
      rootSessionId: requireText(template.rootSessionId, "root session ID"),
      remoteHostId: requireText(template.remoteHostId, "remote host ID", 256),
      expiresAt: principalExpiresAt,
      canDelegate,
      depth,
      maxDepth,
      maxChildren
    };
    this.pruneExpiredEnrollments(now);
    this.state.enrollments[tokenHash] = { tokenHash, template: normalized, expiresAt, createdAt: now };
    this.persist();
    return { enrollmentToken, expiresAt };
  }
  issueChildEnrollment(parentSessionId, parentGeneration, request, ttlMs = DEFAULT_ENROLLMENT_TTL_MS) {
    const parent = this.validatePrincipal(parentSessionId, parentGeneration);
    if (!parent.canDelegate) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent principal cannot delegate children");
    const now = this.now();
    const activeChildren = Object.values(this.state.principals).filter(
      (principal) => principal.parentSessionId === parent.id && principal.state === "active" && principal.expiresAt > now
    ).length;
    const pendingChildren = Object.values(this.state.enrollments).filter(
      (enrollment) => enrollment.template.parentSessionId === parent.id && enrollment.expiresAt > now
    ).length;
    if (activeChildren + pendingChildren >= parent.maxChildren) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent child limit is exhausted");
    const depth = parent.depth + 1;
    if (depth > parent.maxDepth) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent delegation depth is exhausted");
    const maxDepth = boundedInteger(request.maxDepth, depth, "child maximum depth", depth, parent.maxDepth);
    const maxChildren = boundedInteger(request.maxChildren, 0, "child maximum count", 0, parent.maxChildren);
    const canDelegate = request.canDelegate === true;
    if (canDelegate && (maxDepth <= depth || maxChildren === 0)) throw new Error("Delegating child requires remaining depth and child capacity");
    const expiresAt = request.expiresAt ?? parent.expiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > parent.expiresAt) {
      throw new Error("Child expiry must not exceed the parent expiry");
    }
    return this.issueEnrollment({
      name: request.name,
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId,
      remoteHostId: parent.remoteHostId,
      expiresAt,
      canDelegate,
      depth,
      maxDepth,
      maxChildren
    }, ttlMs);
  }
  consumeEnrollment(enrollmentToken) {
    const now = this.now();
    const tokenHash = hashSecret(enrollmentToken);
    const enrollment = this.state.enrollments[tokenHash];
    if (!enrollment) throw new RemoteAccessError("INVALID_ENROLLMENT", "Enrollment credential is invalid or already consumed");
    delete this.state.enrollments[tokenHash];
    if (enrollment.expiresAt <= now) {
      this.persist();
      throw new RemoteAccessError("INVALID_ENROLLMENT", "Enrollment credential has expired");
    }
    const sessionCredential = newSecret();
    const id = randomUUID2();
    const principal = {
      id,
      name: enrollment.template.name,
      credentialHash: hashSecret(sessionCredential),
      parentSessionId: enrollment.template.parentSessionId,
      rootSessionId: enrollment.template.rootSessionId,
      remoteHostId: enrollment.template.remoteHostId,
      generation: 1,
      policy: "remote-tree",
      canDelegate: enrollment.template.canDelegate === true,
      depth: enrollment.template.depth,
      maxDepth: enrollment.template.maxDepth,
      maxChildren: enrollment.template.maxChildren,
      state: "active",
      expiresAt: enrollment.template.expiresAt,
      createdAt: now,
      updatedAt: now
    };
    this.state.principals[id] = principal;
    this.persist();
    return { principal: structuredClone(principal), sessionCredential };
  }
  authenticateSession(sessionId, generation, sessionCredential) {
    const principal = this.state.principals[sessionId];
    if (!principal || !secretsMatch(sessionCredential, principal.credentialHash)) {
      throw new RemoteAccessError("INVALID_CREDENTIAL", "Session credential is invalid");
    }
    return this.validatePrincipal(sessionId, generation);
  }
  validatePrincipal(sessionId, generation) {
    const principal = this.state.principals[sessionId];
    if (!principal) throw new RemoteAccessError("INVALID_CREDENTIAL", "Remote principal does not exist");
    if (principal.state !== "active") throw new RemoteAccessError("REVOKED_CREDENTIAL", "Session credential is revoked");
    if (principal.expiresAt <= this.now()) throw new RemoteAccessError("EXPIRED_CREDENTIAL", "Session credential has expired");
    if (principal.generation !== generation) throw new RemoteAccessError("STALE_GENERATION", "Session credential generation is stale");
    return structuredClone(principal);
  }
  inspectSubtree(principalId) {
    const result = [];
    const queue = [principalId];
    const seen = /* @__PURE__ */ new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = this.state.principals[id];
      if (!principal) continue;
      const { credentialHash: _credentialHash, ...metadata } = principal;
      result.push(structuredClone(metadata));
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    return result;
  }
  adoptSubtree(principalId, newParentSessionId, newRootSessionId) {
    const principal = this.state.principals[principalId];
    if (!principal) throw new Error("Unknown adopted principal");
    if (principalId === newParentSessionId) throw new Error("Adoption would create an ownership cycle");
    let ancestor = this.state.principals[newParentSessionId];
    const seen = /* @__PURE__ */ new Set();
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === principalId) throw new Error("Adoption would create an ownership cycle");
      seen.add(ancestor.id);
      ancestor = this.state.principals[ancestor.parentSessionId];
    }
    const ids = this.subtreePrincipalIds(principalId);
    const now = this.now();
    principal.parentSessionId = requireText(newParentSessionId, "new parent session ID");
    for (const id of ids) {
      const changed = this.state.principals[id];
      changed.rootSessionId = requireText(newRootSessionId, "new root session ID");
      changed.generation += 1;
      changed.updatedAt = now;
    }
    const changedIds = new Set(ids);
    for (const [hash, enrollment] of Object.entries(this.state.enrollments)) {
      if (changedIds.has(enrollment.template.parentSessionId)) delete this.state.enrollments[hash];
    }
    this.persist();
    return ids.map((id) => structuredClone(this.state.principals[id]));
  }
  expirePrincipals(now = this.now()) {
    const changed = /* @__PURE__ */ new Map();
    const expiredRoots = Object.values(this.state.principals).filter((principal) => principal.state === "active" && principal.expiresAt <= now).sort((left, right) => left.depth - right.depth);
    for (const principal of expiredRoots) {
      if (changed.has(principal.id)) continue;
      for (const revoked of this.revoke(principal.id)) changed.set(revoked.id, revoked);
    }
    return [...changed.values()];
  }
  revoke(principalId) {
    const now = this.now();
    const queue = [principalId];
    const seen = /* @__PURE__ */ new Set();
    const changed = [];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = this.state.principals[id];
      if (!principal) continue;
      principal.state = "revoked";
      principal.generation += 1;
      principal.updatedAt = now;
      changed.push(structuredClone(principal));
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    if (changed.length) this.persist();
    return changed;
  }
  subtreePrincipalIds(principalId) {
    const result = [];
    const queue = [principalId];
    const seen = /* @__PURE__ */ new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id) || !this.state.principals[id]) continue;
      seen.add(id);
      result.push(id);
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    return result;
  }
  pruneExpiredEnrollments(now = this.now()) {
    for (const [hash, enrollment] of Object.entries(this.state.enrollments)) {
      if (enrollment.expiresAt <= now) delete this.state.enrollments[hash];
    }
  }
  load() {
    if (!existsSync(this.statePath)) return emptyState();
    try {
      return parseState(JSON.parse(readFileSync3(this.statePath, "utf8")));
    } catch (error) {
      throw new Error(`Invalid remote access registry at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  persist() {
    writeDurableJson(this.statePath, this.state);
  }
};

// broker/authorization.ts
function policyPrincipalForSession(session) {
  if (session.origin === "remote") {
    if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
      throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
    }
    return {
      id: session.id,
      kind: "remote",
      state: "active",
      generation: session.generation,
      policy: "remote-tree",
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId
    };
  }
  return {
    id: session.id,
    kind: "local",
    state: "active",
    generation: 1,
    policy: "local-public",
    rootSessionId: session.id
  };
}
function policyStateForSessions(sessions) {
  const principals = {};
  for (const session of sessions) principals[session.id] = policyPrincipalForSession(session);
  return { principals };
}
function authorizeSessionAction(sessions, actorId, action, targetId) {
  const state = policyStateForSessions(sessions);
  const actor = state.principals[actorId];
  const target = state.principals[targetId];
  return authorize(state, actorId, action, targetId, {
    actorGeneration: actor?.generation,
    targetGeneration: target?.generation
  });
}
function visibleSessions(sessions, actorId) {
  const values = Array.from(sessions);
  return values.filter((target) => authorizeSessionAction(values, actorId, "discover", target.id).allowed);
}

// broker/audit.ts
import { closeSync as closeSync3, fsyncSync as fsyncSync2, openSync as openSync3, writeSync } from "fs";
var BROKER_AUDIT_VERSION = 1;
var BrokerAuditLog = class {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
  }
  path;
  now;
  record(entry) {
    const line = `${JSON.stringify({
      version: BROKER_AUDIT_VERSION,
      timestamp: this.now(),
      ...entry
    })}
`;
    const descriptor = openSync3(this.path, "a", INTERCOM_RUNTIME_FILE_MODE);
    try {
      writeSync(descriptor, line, void 0, "utf8");
      fsyncSync2(descriptor);
    } finally {
      closeSync3(descriptor);
    }
    restrictIntercomRuntimeFile(this.path);
  }
  tryRecord(entry) {
    try {
      this.record(entry);
    } catch (error) {
      console.error("Failed to append Agent Intercom broker audit event:", error);
    }
  }
};

// broker/broker.ts
var INTERCOM_DIR = getIntercomDirPath();
var LISTEN_TARGET = getBrokerListenTarget();
var REMOTE_LISTEN_TARGET = getRemoteGatewaySocketPath();
var PID_PATH = join2(INTERCOM_DIR, "broker.pid");
var OWNER_PATH = join2(INTERCOM_DIR, "broker.owner");
var PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
var ASK_STATE_PATH = getBrokerAskStateFilePath(INTERCOM_DIR);
var ACCESS_STATE_PATH = getBrokerAccessStateFilePath(INTERCOM_DIR);
var ADMIN_CREDENTIAL_PATH = getBrokerAdminCredentialFilePath(INTERCOM_DIR);
var AUDIT_PATH = getBrokerAuditFilePath(INTERCOM_DIR);
var BROKER_STATE_ID = randomUUID3();
var MAX_SESSIONS = 128;
var MAX_UNREGISTERED_CONNECTIONS = 32;
var REGISTRATION_TIMEOUT_MS = 1e3;
var RATE_LIMIT_CAPACITY = 240;
var RATE_LIMIT_REFILL_PER_SECOND = 120;
var REMOTE_RATE_LIMIT_CAPACITY = 60;
var REMOTE_RATE_LIMIT_REFILL_PER_SECOND = 30;
var REMOTE_EXPIRY_SWEEP_MS = Math.max(50, Number.parseInt(process.env.PI_INTERCOM_REMOTE_EXPIRY_SWEEP_MS ?? "1000", 10) || 1e3);
var PRESENCE_HEARTBEAT_MS = 1e3;
var DELIVERY_ACK_TIMEOUT_MS = 8e3;
var RECENT_DELIVERY_TTL_MS = 10 * 60 * 1e3;
var MAX_PENDING_DELIVERIES = 1024;
var MAX_PENDING_DELIVERIES_PER_SESSION = 64;
var MAX_PENDING_ASKS_PER_SESSION = 64;
var RATE_LIMIT_BYTES_PER_TOKEN = 8 * 1024;
var MAX_MESSAGE_TEXT_BYTES = 256 * 1024;
var MAX_ATTACHMENT_CONTENT_BYTES = 512 * 1024;
var MAX_ATTACHMENTS = 16;
var MAX_MESSAGE_ID_LENGTH = 256;
var MAX_TARGET_LENGTH = 512;
var MAX_SESSION_NAME_LENGTH = 256;
var MAX_SESSION_CWD_LENGTH = 4096;
var MAX_SESSION_MODEL_LENGTH = 512;
var MAX_SESSION_STATUS_LENGTH = 512;
function isAttachment(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") {
    return false;
  }
  if (typeof attachment.name !== "string" || attachment.name.length > 256 || typeof attachment.content !== "string" || Buffer.byteLength(attachment.content, "utf-8") > MAX_ATTACHMENT_CONTENT_BYTES) {
    return false;
  }
  return attachment.language === void 0 || typeof attachment.language === "string";
}
function isMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value;
  if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > MAX_MESSAGE_ID_LENGTH || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    return false;
  }
  if (message.replyTo !== void 0 && (typeof message.replyTo !== "string" || message.replyTo.length === 0 || message.replyTo.length > MAX_MESSAGE_ID_LENGTH)) {
    return false;
  }
  if (message.expectsReply !== void 0 && typeof message.expectsReply !== "boolean") {
    return false;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  const content = message.content;
  if (typeof content.text !== "string" || Buffer.byteLength(content.text, "utf-8") > MAX_MESSAGE_TEXT_BYTES) {
    return false;
  }
  return content.attachments === void 0 || Array.isArray(content.attachments) && content.attachments.length <= MAX_ATTACHMENTS && content.attachments.every(isAttachment);
}
function isSessionId(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isSessionRegistration(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const session = value;
  if (typeof session.cwd !== "string" || session.cwd.length === 0 || session.cwd.length > MAX_SESSION_CWD_LENGTH || typeof session.model !== "string" || session.model.length === 0 || session.model.length > MAX_SESSION_MODEL_LENGTH || typeof session.pid !== "number" || !Number.isFinite(session.pid) || typeof session.startedAt !== "number" || !Number.isFinite(session.startedAt) || typeof session.lastActivity !== "number" || !Number.isFinite(session.lastActivity)) {
    return false;
  }
  if (session.name !== void 0 && (typeof session.name !== "string" || session.name.length > MAX_SESSION_NAME_LENGTH)) {
    return false;
  }
  return session.status === void 0 || typeof session.status === "string" && session.status.length <= MAX_SESSION_STATUS_LENGTH;
}
var IntercomBroker = class {
  sessions = /* @__PURE__ */ new Map();
  askEdges = /* @__PURE__ */ new Map();
  pendingDeliveries = /* @__PURE__ */ new Map();
  pendingDeliveryKeys = /* @__PURE__ */ new Map();
  recentDeliveries = /* @__PURE__ */ new Map();
  connections = /* @__PURE__ */ new Set();
  unregisteredConnections = /* @__PURE__ */ new Set();
  server;
  remoteServer = null;
  shutdownTimer = null;
  expiryTimer = null;
  askTimeoutMs = getAskTimeoutMs();
  accessRegistry;
  audit;
  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    acquireBrokerOwnership(OWNER_PATH);
    this.accessRegistry = new RemoteAccessRegistry(ACCESS_STATE_PATH);
    this.audit = new BrokerAuditLog(AUDIT_PATH);
    this.accessRegistry.ensureAdminCredential(ADMIN_CREDENTIAL_PATH);
    this.loadAskEdges();
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      for (const socketPath of [LISTEN_TARGET, REMOTE_LISTEN_TARGET]) {
        try {
          unlinkSync2(socketPath);
        } catch {
        }
      }
    }
    this.server = net.createServer((socket) => this.handleConnection(socket, "local"));
    if (process.platform !== "win32" && typeof LISTEN_TARGET === "string") {
      this.remoteServer = net.createServer((socket) => this.handleConnection(socket, "remote"));
    }
  }
  start() {
    let localListening = false;
    let remoteListening = this.remoteServer === null;
    const announceWhenReady = () => {
      if (!localListening || !remoteListening) return;
      writeFileSync3(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid}, remote-access-v1)`);
    };
    const onLocalListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        restrictIntercomRuntimeFile(LISTEN_TARGET);
      } else {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Intercom TCP broker started without a TCP address");
        }
        const endpoint = {
          transport: "tcp",
          host: LISTEN_TARGET.host,
          port: address.port,
          stateId: BROKER_STATE_ID
        };
        writeFileSync3(PORT_PATH, `${JSON.stringify(endpoint)}
`, { mode: INTERCOM_RUNTIME_FILE_MODE });
        restrictIntercomRuntimeFile(PORT_PATH);
      }
      localListening = true;
      announceWhenReady();
    };
    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onLocalListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onLocalListening);
    }
    if (this.remoteServer) {
      this.remoteServer.listen(REMOTE_LISTEN_TARGET, () => {
        restrictIntercomRuntimeFile(REMOTE_LISTEN_TARGET);
        remoteListening = true;
        announceWhenReady();
      });
    }
    this.expiryTimer = setInterval(() => this.reconcileExpiredPrincipals(), REMOTE_EXPIRY_SWEEP_MS);
    this.expiryTimer.unref?.();
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }
  handleConnection(socket, origin) {
    this.connections.add(socket);
    let sessionId = null;
    let registrationTimeout = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionId) {
          socket.destroy();
        }
      }, REGISTRATION_TIMEOUT_MS);
      registrationTimeout.unref?.();
    };
    const clearRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
        registrationTimeout = null;
      }
      this.unregisteredConnections.delete(socket);
    };
    armRegistrationTimeout();
    const connection = {
      socket,
      origin,
      tokens: origin === "remote" ? REMOTE_RATE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY,
      refillPerSecond: origin === "remote" ? REMOTE_RATE_LIMIT_REFILL_PER_SECOND : RATE_LIMIT_REFILL_PER_SECOND,
      lastRefillAt: Date.now()
    };
    const reader = createMessageReader((msg) => {
      const byteCost = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(msg), "utf-8") / RATE_LIMIT_BYTES_PER_TOKEN));
      if (!this.consumeToken(connection, byteCost)) {
        this.sendError(socket, "RATE_LIMITED", "Intercom broker rate limit exceeded");
        socket.destroy(new Error("Intercom broker rate limit exceeded"));
        return;
      }
      try {
        this.handleMessage(socket, origin, msg, sessionId, (id) => {
          sessionId = id;
          if (id) {
            clearRegistrationTimeout();
          } else {
            armRegistrationTimeout();
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "Invalid intercom TCP endpoint credentials") {
          socket.destroy();
          return;
        }
        this.sendError(socket, "INVALID_REQUEST", reason);
        socket.end();
      }
    }, (error) => {
      socket.destroy(error);
    });
    socket.on("data", reader);
    socket.on("close", () => {
      clearRegistrationTimeout();
      this.connections.delete(socket);
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing?.socket === socket) {
          if (existing.info.origin === "remote") {
            this.audit.tryRecord({
              event: "remote_disconnect",
              outcome: "observed",
              actorId: sessionId,
              remoteHostId: existing.info.remoteHostId,
              generation: existing.info.generation,
              reason: "SOCKET_CLOSED"
            });
          }
          this.broadcastVisible({ type: "session_left", sessionId }, existing.info, sessionId);
          this.sessions.delete(sessionId);
          this.clearPendingDeliveriesForSession(sessionId, socket);
          this.deferAskEdgesForSession(sessionId);
          this.scheduleShutdownCheck();
        }
      }
    });
    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }
  evictOldestUnregisteredConnections(currentSocket) {
    while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
      const [oldest] = this.unregisteredConnections;
      if (!oldest) {
        return;
      }
      if (oldest === currentSocket && this.unregisteredConnections.size === 1) {
        return;
      }
      this.unregisteredConnections.delete(oldest);
      oldest.destroy();
    }
  }
  consumeToken(connection, cost = 1, now = Date.now()) {
    const elapsedMs = now - connection.lastRefillAt;
    if (elapsedMs > 0) {
      connection.tokens = Math.min(
        connection.origin === "remote" ? REMOTE_RATE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * connection.refillPerSecond / 1e3
      );
      connection.lastRefillAt = now;
    }
    if (connection.tokens < cost) {
      return false;
    }
    connection.tokens -= cost;
    return true;
  }
  sendError(socket, code, error) {
    writeMessage(socket, { type: "error", code, error });
  }
  sendDeliveryFailure(socket, messageId, accepted, code, reason) {
    writeMessage(socket, { type: "delivery_failed", messageId, accepted, code, reason });
  }
  scheduleShutdownCheck() {
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5e3);
  }
  handleMessage(socket, origin, msg, currentId, setId) {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }
    const clientMessage = msg;
    const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
    const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;
    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string") {
        throw new Error("Invalid health message");
      }
      if (requiresEndpointAuth && !hasEndpointAuth) {
        throw new Error("Invalid intercom TCP endpoint credentials");
      }
      writeMessage(socket, {
        type: "health_ok",
        requestId: clientMessage.requestId,
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
        endpoint: origin,
        remoteAccess: this.remoteAccessContract()
      });
      return;
    }
    if (clientMessage.type === "access_control") {
      if (currentId !== null) {
        this.sendError(socket, "ACCESS_DENIED", "Remote access control requires a short-lived control connection");
        socket.end();
        return;
      }
      if (origin === "local") this.handleAccessControl(socket, clientMessage);
      else this.handleRemoteAccessControl(socket, clientMessage);
      return;
    }
    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }
    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }
    if (currentId && !this.isCurrentPrincipal(currentId)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote session authorization is no longer valid");
      socket.destroy();
      return;
    }
    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }
        if (clientMessage.protocol !== INTERCOM_PROTOCOL_NAME || clientMessage.version !== INTERCOM_PROTOCOL_VERSION) {
          this.sendError(
            socket,
            "PROTOCOL_MISMATCH",
            `Unsupported intercom protocol; expected ${INTERCOM_PROTOCOL_NAME} v${INTERCOM_PROTOCOL_VERSION}`
          );
          socket.end();
          break;
        }
        if (currentId) {
          throw new Error("Received duplicate register message");
        }
        let id;
        let remotePrincipal;
        let issuedSessionCredential;
        let enrollmentConsumed = false;
        if (origin === "remote") {
          if (this.sessions.size >= MAX_SESSIONS) {
            this.sendError(socket, "TOO_MANY_SESSIONS", "Too many registered intercom sessions");
            socket.destroy();
            break;
          }
          const access = clientMessage.access;
          if (typeof access !== "object" || access === null || Array.isArray(access)) {
            this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "MISSING_CREDENTIAL" });
            this.sendError(socket, "ACCESS_DENIED", "Remote registration requires an access credential");
            socket.end();
            break;
          }
          const fields = access;
          try {
            if (typeof fields.enrollmentToken === "string") {
              const consumed = this.accessRegistry.consumeEnrollment(fields.enrollmentToken);
              remotePrincipal = consumed.principal;
              issuedSessionCredential = consumed.sessionCredential;
              enrollmentConsumed = true;
            } else if (typeof fields.sessionCredential === "string" && typeof fields.sessionId === "string" && typeof fields.generation === "number" && Number.isSafeInteger(fields.generation)) {
              remotePrincipal = this.accessRegistry.authenticateSession(fields.sessionId, fields.generation, fields.sessionCredential);
            } else {
              throw new Error("Invalid remote access credential shape");
            }
          } catch {
            this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "INVALID_CREDENTIAL" });
            this.sendError(socket, "ACCESS_DENIED", "Remote registration credential was rejected");
            socket.end();
            break;
          }
          id = remotePrincipal.id;
          if (this.sessions.has(id)) {
            this.audit.tryRecord({
              event: "credential_reuse_denied",
              outcome: "denied",
              actorId: id,
              remoteHostId: remotePrincipal.remoteHostId,
              generation: remotePrincipal.generation,
              reason: "ALREADY_ACTIVE"
            });
            this.sendError(socket, "ACCESS_DENIED", "Remote session credential is already active");
            socket.end();
            break;
          }
        } else {
          id = randomUUID3();
          if (clientMessage.sessionId !== void 0) {
            if (!isSessionId(clientMessage.sessionId)) {
              throw new Error("Invalid register sessionId");
            }
            id = clientMessage.sessionId;
          }
          const previous = this.sessions.get(id);
          if (!previous && this.sessions.size >= MAX_SESSIONS) {
            this.sendError(socket, "TOO_MANY_SESSIONS", "Too many registered intercom sessions");
            socket.destroy();
            break;
          }
          if (previous) {
            this.clearPendingDeliveriesForSession(id, previous.socket);
            this.deferAskEdgesForSession(id);
            previous.socket.end();
          }
        }
        setId(id);
        const session = clientMessage.session;
        const info = remotePrincipal ? {
          id,
          name: remotePrincipal.name,
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...session.status !== void 0 ? { status: session.status } : {},
          trustedLocal: false,
          origin: "remote",
          remoteHostId: remotePrincipal.remoteHostId,
          parentSessionId: remotePrincipal.parentSessionId,
          rootSessionId: remotePrincipal.rootSessionId,
          generation: remotePrincipal.generation,
          canDelegate: remotePrincipal.canDelegate,
          depth: remotePrincipal.depth,
          maxDepth: remotePrincipal.maxDepth,
          maxChildren: remotePrincipal.maxChildren
        } : {
          id,
          ...session.name !== void 0 ? { name: session.name } : {},
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...session.status !== void 0 ? { status: session.status } : {},
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
          origin: "local"
        };
        if (remotePrincipal) {
          this.audit.record({
            event: enrollmentConsumed ? "enrollment_consumed" : "remote_reconnect",
            outcome: "allowed",
            actorId: id,
            targetId: remotePrincipal.parentSessionId,
            remoteHostId: remotePrincipal.remoteHostId,
            generation: remotePrincipal.generation
          });
          this.audit.record({
            event: "remote_connect",
            outcome: "allowed",
            actorId: id,
            targetId: remotePrincipal.parentSessionId,
            remoteHostId: remotePrincipal.remoteHostId,
            generation: remotePrincipal.generation
          });
        }
        this.sessions.set(id, { socket, info, lastPresenceBroadcastAt: Date.now() });
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }
        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION,
          ...remotePrincipal ? {
            remoteAccess: this.remoteAccessContract(),
            access: {
              origin: "remote",
              remoteHostId: remotePrincipal.remoteHostId,
              parentSessionId: remotePrincipal.parentSessionId,
              rootSessionId: remotePrincipal.rootSessionId,
              generation: remotePrincipal.generation,
              canDelegate: remotePrincipal.canDelegate,
              depth: remotePrincipal.depth,
              maxDepth: remotePrincipal.maxDepth,
              maxChildren: remotePrincipal.maxChildren,
              ...issuedSessionCredential ? { sessionCredential: issuedSessionCredential } : {}
            }
          } : {}
        });
        this.broadcastVisible({ type: "session_joined", session: info }, info, id);
        break;
      }
      case "unregister": {
        if (!currentId) {
          throw new Error("Received unregister before register");
        }
        if (clientMessage.preserveAsks !== void 0 && typeof clientMessage.preserveAsks !== "boolean") {
          throw new Error("Invalid unregister preserveAsks value");
        }
        const existing = this.sessions.get(currentId);
        if (existing?.socket === socket) {
          if (existing.info.origin === "remote") {
            this.audit.tryRecord({
              event: "remote_disconnect",
              outcome: "observed",
              actorId: currentId,
              remoteHostId: existing.info.remoteHostId,
              generation: existing.info.generation,
              reason: "UNREGISTERED"
            });
          }
          this.broadcastVisible({ type: "session_left", sessionId: currentId }, existing.info, currentId);
          this.sessions.delete(currentId);
          this.clearPendingDeliveriesForSession(currentId, socket);
          if (clientMessage.preserveAsks) {
            this.deferAskEdgesForSession(currentId);
          } else {
            this.clearAskEdgesForSession(currentId, "session_disconnected");
          }
          this.scheduleShutdownCheck();
        }
        setId(null);
        break;
      }
      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }
        const allSessions = Array.from(this.sessions.values(), (session) => session.info);
        const sessions = visibleSessions(allSessions, currentId);
        const actor = this.sessions.get(currentId);
        if (actor?.info.origin === "remote" && sessions.length < allSessions.length) {
          this.audit.tryRecord({
            event: "remote_visibility_filtered",
            outcome: "observed",
            actorId: currentId,
            remoteHostId: actor.info.remoteHostId,
            generation: actor.info.generation,
            visibleCount: sessions.length,
            hiddenCount: allSessions.length - sessions.length
          });
        }
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }
      case "send": {
        if (!currentId) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = typeof message === "object" && message !== null && "id" in message && typeof message.id === "string" && message.id.length > 0 && message.id.length <= MAX_MESSAGE_ID_LENGTH ? message.id : "unknown";
        if (typeof clientMessage.to !== "string" || clientMessage.to.length === 0 || clientMessage.to.length > MAX_TARGET_LENGTH || !isMessage(message)) {
          this.sendDeliveryFailure(socket, messageId, false, "INVALID_MESSAGE", "Invalid message format");
          break;
        }
        const action = message.replyTo ? "reply" : message.expectsReply ? "ask" : "send";
        this.pruneRecentDeliveries();
        const deliveryKey = this.deliveryKey(currentId, message.id);
        const fingerprint = JSON.stringify({
          to: clientMessage.to,
          replyTo: message.replyTo,
          expectsReply: message.expectsReply,
          content: message.content
        });
        const recent = this.recentDeliveries.get(deliveryKey);
        if (recent) {
          if (recent.fingerprint !== fingerprint) {
            this.sendDeliveryFailure(socket, message.id, false, "DUPLICATE_MESSAGE_ID", "Message ID was already used with a different payload");
            break;
          }
          const actor = this.sessions.get(currentId);
          const target = this.sessions.get(recent.to);
          const authorizationStillValid = Boolean(
            actor && target && (actor.info.generation ?? 1) === recent.fromGeneration && (target.info.generation ?? 1) === recent.toGeneration && this.isAuthorized(currentId, recent.action, recent.to)
          );
          if (recent.retryable || !authorizationStillValid) {
            this.recentDeliveries.delete(deliveryKey);
          } else {
            if (recent.response.type === "delivered") {
              writeMessage(socket, {
                type: "delivery_accepted",
                messageId: message.id,
                deliveryId: recent.response.deliveryId
              });
            }
            writeMessage(socket, recent.response);
            break;
          }
        }
        const existingDeliveryId = this.pendingDeliveryKeys.get(deliveryKey);
        if (existingDeliveryId) {
          const existing = this.pendingDeliveries.get(existingDeliveryId);
          if (!existing || existing.fingerprint !== fingerprint) {
            this.sendDeliveryFailure(socket, message.id, false, "DUPLICATE_MESSAGE_ID", "Message ID is already pending with a different payload");
            break;
          }
          const actor = this.sessions.get(existing.from);
          const target = this.sessions.get(existing.to);
          if (actor && target && (actor.info.generation ?? 1) === existing.fromGeneration && (target.info.generation ?? 1) === existing.toGeneration && this.isAuthorized(existing.from, existing.action, existing.to)) {
            writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId: existing.id });
            break;
          }
          this.failPendingDelivery(existing.id, "SESSION_NOT_FOUND", "Delivery authorization changed while pending");
        }
        if (this.pendingDeliveries.size >= MAX_PENDING_DELIVERIES || this.countPendingDeliveriesFrom(currentId) >= MAX_PENDING_DELIVERIES_PER_SESSION) {
          this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_DELIVERIES", "Too many messages are waiting for receiver acknowledgement");
          break;
        }
        const candidates = this.findSessions(clientMessage.to);
        const targets = candidates.filter((target) => this.isAuthorized(currentId, action, target.info.id));
        if (candidates.length > 0 && targets.length === 0) {
          const actor = this.sessions.get(currentId);
          this.audit.tryRecord({
            event: "remote_delivery_denied",
            outcome: "denied",
            actorId: currentId,
            targetId: candidates.length === 1 ? candidates[0].info.id : void 0,
            remoteHostId: actor?.info.remoteHostId ?? candidates.find((candidate) => candidate.info.remoteHostId)?.info.remoteHostId,
            generation: actor?.info.generation,
            reason: "POLICY_DENIED"
          });
        }
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession || fromSession.socket !== socket) {
            this.sendDeliveryFailure(socket, message.id, false, "SENDER_NOT_FOUND", "Sender session not found");
            break;
          }
          const target = targets[0];
          const replyEdge = message.replyTo ? this.askEdges.get(this.askKey(target.info.id, message.replyTo)) : void 0;
          if (message.replyTo && !replyEdge) {
            this.sendDeliveryFailure(socket, message.id, false, "INVALID_REPLY_TARGET", "Reply target does not match a pending ask");
            break;
          }
          if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.info.id)) {
            this.sendDeliveryFailure(socket, message.id, false, "INVALID_REPLY_TARGET", "Reply target does not match the pending ask");
            break;
          }
          if (message.expectsReply) {
            const existingAsk = Array.from(this.askEdges.values()).find(
              (edge) => edge.from === currentId && edge.to === target.info.id
            );
            if (existingAsk) {
              this.sendDeliveryFailure(socket, message.id, false, "ASK_ALREADY_PENDING", "Another ask to this session is still unresolved. Wait for its reply or use intercom_send for a non-blocking follow-up.");
              break;
            }
            const reverseEdge = Array.from(this.askEdges.values()).find(
              (edge) => edge.state === "blocking" && !(message.replyTo === edge.messageId && target.info.id === edge.from) && edge.from === target.info.id && edge.to === currentId
            );
            if (reverseEdge) {
              this.sendDeliveryFailure(socket, message.id, false, "MUTUAL_ASK", "Mutual ask refused: target session is already waiting for a reply from this session.");
              break;
            }
            if (this.countAskEdgesFrom(currentId) >= MAX_PENDING_ASKS_PER_SESSION) {
              this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_ASKS", "Too many asks are already waiting for replies");
              break;
            }
            this.addAskEdge(message.id, currentId, target.info.id);
          }
          const deliveryId = randomUUID3();
          const timeout = setTimeout(() => {
            this.failPendingDelivery(deliveryId, "DELIVERY_TIMEOUT", "Recipient did not acknowledge the message in time");
          }, DELIVERY_ACK_TIMEOUT_MS);
          timeout.unref?.();
          const pending = {
            id: deliveryId,
            key: deliveryKey,
            fingerprint,
            message,
            from: currentId,
            to: target.info.id,
            senderSocket: socket,
            recipientSocket: target.socket,
            action,
            fromGeneration: fromSession.info.generation ?? 1,
            toGeneration: target.info.generation ?? 1,
            timeout
          };
          this.pendingDeliveries.set(deliveryId, pending);
          this.pendingDeliveryKeys.set(deliveryKey, deliveryId);
          writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId });
          writeMessage(target.socket, {
            type: "message",
            deliveryId,
            from: fromSession.info,
            message
          });
          break;
        }
        if (targets.length > 1) {
          this.sendDeliveryFailure(socket, message.id, false, "AMBIGUOUS_TARGET", `Multiple sessions named "${clientMessage.to}" are connected. Use the session ID instead.`);
          break;
        }
        this.sendDeliveryFailure(socket, message.id, false, "SESSION_NOT_FOUND", "Session not found");
        break;
      }
      case "message_received": {
        if (!currentId) {
          throw new Error("Received message_received before register");
        }
        if (typeof clientMessage.deliveryId !== "string") {
          throw new Error("Invalid message_received message");
        }
        this.acknowledgePendingDelivery(clientMessage.deliveryId, currentId, socket);
        break;
      }
      case "message_rejected": {
        if (!currentId) {
          throw new Error("Received message_rejected before register");
        }
        if (typeof clientMessage.deliveryId !== "string" || clientMessage.code !== "CONFLICTING_MESSAGE_ID" || typeof clientMessage.reason !== "string" || clientMessage.reason.length > 1024) {
          throw new Error("Invalid message_rejected message");
        }
        const pending = this.pendingDeliveries.get(clientMessage.deliveryId);
        if (pending?.to === currentId && pending.recipientSocket === socket) {
          this.failPendingDelivery(clientMessage.deliveryId, clientMessage.code, clientMessage.reason);
        }
        break;
      }
      case "defer_ask": {
        if (!currentId) {
          throw new Error("Received defer_ask before register");
        }
        if (typeof clientMessage.messageId !== "string" || clientMessage.messageId.length > MAX_MESSAGE_ID_LENGTH || typeof clientMessage.requestId !== "string" || clientMessage.requestId.length > MAX_MESSAGE_ID_LENGTH) {
          throw new Error("Invalid defer_ask message");
        }
        const edge = this.askEdges.get(this.askKey(currentId, clientMessage.messageId));
        const applied = Boolean(edge?.from === currentId);
        if (edge?.from === currentId && edge.state === "blocking") {
          edge.state = "deferred";
          this.persistAskEdges();
          this.notifyAskDeferred(edge);
        }
        writeMessage(socket, { type: "ask_control_result", requestId: clientMessage.requestId, action: "defer", messageId: clientMessage.messageId, applied });
        break;
      }
      case "cancel_ask": {
        if (!currentId) {
          throw new Error("Received cancel_ask before register");
        }
        if (typeof clientMessage.messageId !== "string" || clientMessage.messageId.length > MAX_MESSAGE_ID_LENGTH || typeof clientMessage.requestId !== "string" || clientMessage.requestId.length > MAX_MESSAGE_ID_LENGTH) {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentId);
        const edgeKey = this.askKey(currentId, clientMessage.messageId);
        const edge = this.askEdges.get(edgeKey);
        const applied = Boolean(session?.socket === socket && edge?.from === currentId);
        if (applied) {
          this.removeAskEdge(edgeKey, "cancelled", true);
        }
        writeMessage(socket, { type: "ask_control_result", requestId: clientMessage.requestId, action: "cancel", messageId: clientMessage.messageId, applied });
        break;
      }
      case "presence": {
        if (!currentId) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentId);
        if (session?.socket === socket) {
          let changed = false;
          if (clientMessage.name !== void 0) {
            if (typeof clientMessage.name !== "string" || clientMessage.name.length > MAX_SESSION_NAME_LENGTH) {
              throw new Error("Invalid presence name");
            }
            if (session.info.origin !== "remote" && session.info.name !== clientMessage.name) {
              session.info.name = clientMessage.name;
              changed = true;
            }
          }
          if (clientMessage.status !== void 0) {
            if (typeof clientMessage.status !== "string" || clientMessage.status.length > MAX_SESSION_STATUS_LENGTH) {
              throw new Error("Invalid presence status");
            }
            if (session.info.status !== clientMessage.status) {
              session.info.status = clientMessage.status;
              changed = true;
            }
          }
          if (clientMessage.model !== void 0) {
            if (typeof clientMessage.model !== "string" || clientMessage.model.length > MAX_SESSION_MODEL_LENGTH) {
              throw new Error("Invalid presence model");
            }
            if (session.info.model !== clientMessage.model) {
              session.info.model = clientMessage.model;
              changed = true;
            }
          }
          const now = Date.now();
          session.info.lastActivity = now;
          if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
            session.lastPresenceBroadcastAt = now;
            this.broadcastVisible({ type: "presence_update", session: session.info }, session.info, currentId);
          }
        }
        break;
      }
      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }
  remoteAccessContract() {
    return {
      feature: "remote-access-v1",
      policySemanticsVersion: POLICY_SEMANTICS_VERSION,
      policySemanticsHash: POLICY_SEMANTICS_HASH
    };
  }
  handleAccessControl(socket, message) {
    if (typeof message.requestId !== "string" || message.requestId.length > MAX_MESSAGE_ID_LENGTH || typeof message.adminToken !== "string" || !this.accessRegistry.authenticateAdmin(message.adminToken)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote access control credential or request was rejected");
      socket.end();
      return;
    }
    if (message.action === "inspect_tree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid remote principal ID");
        socket.end();
        return;
      }
      const principals = this.accessRegistry.inspectSubtree(message.principalId).map((principal) => this.principalSummary(principal));
      this.audit.record({
        event: "tree_inspected",
        outcome: "allowed",
        actorId: "local-admin",
        targetId: message.principalId,
        visibleCount: principals.length
      });
      writeMessage(socket, { type: "access_control_result", requestId: message.requestId, action: "inspect_tree", principals });
      socket.end();
      return;
    }
    if (message.action === "adopt_subtree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId) || typeof message.newParentSessionId !== "string" || !isSessionId(message.newParentSessionId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid adoption request");
        socket.end();
        return;
      }
      const localParent = this.sessions.get(message.newParentSessionId);
      const remoteParent = this.accessRegistry.snapshot().principals[message.newParentSessionId];
      if ((!localParent || localParent.info.origin === "remote") && (!remoteParent || remoteParent.state !== "active")) {
        this.sendError(socket, "ACCESS_DENIED", "Adoption parent must be an active local or remote principal");
        socket.end();
        return;
      }
      const newRootSessionId = localParent?.info.origin === "local" ? localParent.info.id : remoteParent.rootSessionId;
      const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
      let changed;
      try {
        changed = this.accessRegistry.adoptSubtree(message.principalId, message.newParentSessionId, newRootSessionId);
      } catch {
        this.sendError(socket, "ACCESS_DENIED", "Adoption would violate the ownership tree");
        socket.end();
        return;
      }
      this.disconnectTransitionedPrincipals(changed, priorSessions, "principal_adopted");
      writeMessage(socket, {
        type: "access_control_result",
        requestId: message.requestId,
        action: "adopt_subtree",
        principals: changed.map((principal) => this.principalSummary(principal))
      });
      socket.end();
      return;
    }
    if (message.action === "revoke_subtree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid remote principal ID");
        socket.end();
        return;
      }
      const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
      const changed = this.accessRegistry.revoke(message.principalId);
      this.disconnectTransitionedPrincipals(changed, priorSessions);
      writeMessage(socket, {
        type: "access_control_result",
        requestId: message.requestId,
        action: "revoke_subtree",
        changedPrincipalIds: changed.map((principal) => principal.id)
      });
      socket.end();
      return;
    }
    if (message.action !== "issue_enrollment" || typeof message.enrollment !== "object" || message.enrollment === null || Array.isArray(message.enrollment)) {
      this.sendError(socket, "INVALID_REQUEST", "Unknown remote access control action");
      socket.end();
      return;
    }
    const enrollment = message.enrollment;
    if (typeof enrollment.name !== "string" || typeof enrollment.parentSessionId !== "string" || typeof enrollment.rootSessionId !== "string" || typeof enrollment.remoteHostId !== "string" || enrollment.ttlMs !== void 0 && (typeof enrollment.ttlMs !== "number" || !Number.isSafeInteger(enrollment.ttlMs)) || enrollment.expiresAt !== void 0 && (typeof enrollment.expiresAt !== "number" || !Number.isSafeInteger(enrollment.expiresAt)) || enrollment.canDelegate !== void 0 && typeof enrollment.canDelegate !== "boolean" || enrollment.maxDepth !== void 0 && (typeof enrollment.maxDepth !== "number" || !Number.isSafeInteger(enrollment.maxDepth)) || enrollment.maxChildren !== void 0 && (typeof enrollment.maxChildren !== "number" || !Number.isSafeInteger(enrollment.maxChildren))) {
      this.sendError(socket, "INVALID_REQUEST", "Invalid remote enrollment request");
      socket.end();
      return;
    }
    const parent = this.sessions.get(enrollment.parentSessionId);
    if (!parent || parent.info.origin === "remote" || enrollment.rootSessionId !== parent.info.id) {
      this.sendError(socket, "ACCESS_DENIED", "Enrollment parent must be an active local root session");
      socket.end();
      return;
    }
    const issued = this.accessRegistry.issueEnrollment({
      name: enrollment.name,
      parentSessionId: parent.info.id,
      rootSessionId: parent.info.id,
      remoteHostId: enrollment.remoteHostId,
      ...enrollment.expiresAt !== void 0 ? { expiresAt: enrollment.expiresAt } : {},
      ...enrollment.canDelegate !== void 0 ? { canDelegate: enrollment.canDelegate } : {},
      ...enrollment.maxDepth !== void 0 ? { maxDepth: enrollment.maxDepth } : {},
      ...enrollment.maxChildren !== void 0 ? { maxChildren: enrollment.maxChildren } : {}
    }, enrollment.ttlMs);
    this.audit.record({
      event: "enrollment_issued",
      outcome: "allowed",
      actorId: parent.info.id,
      targetId: enrollment.name,
      remoteHostId: enrollment.remoteHostId,
      reason: `expires:${issued.expiresAt}`
    });
    writeMessage(socket, {
      type: "access_control_result",
      requestId: message.requestId,
      action: "issue_enrollment",
      enrollmentToken: issued.enrollmentToken,
      expiresAt: issued.expiresAt
    });
    socket.end();
  }
  handleRemoteAccessControl(socket, message) {
    if (typeof message.requestId !== "string" || message.requestId.length > MAX_MESSAGE_ID_LENGTH || typeof message.access !== "object" || message.access === null || Array.isArray(message.access)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote control request was rejected");
      socket.end();
      return;
    }
    const access = message.access;
    if (typeof access.sessionCredential !== "string" || typeof access.sessionId !== "string" || typeof access.generation !== "number" || !Number.isSafeInteger(access.generation)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote control credential was rejected");
      socket.end();
      return;
    }
    let parent;
    try {
      parent = this.accessRegistry.authenticateSession(access.sessionId, access.generation, access.sessionCredential);
    } catch {
      this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "INVALID_CONTROL_CREDENTIAL" });
      this.sendError(socket, "ACCESS_DENIED", "Remote control credential was rejected");
      socket.end();
      return;
    }
    const policyState = this.registryPolicyState();
    if (message.action === "inspect_tree") {
      const targetId = typeof message.principalId === "string" ? message.principalId : parent.id;
      const inspection = authorize(policyState, parent.id, "inspect_tree", targetId, { actorGeneration: parent.generation });
      if (!inspection.allowed) {
        this.sendError(socket, "ACCESS_DENIED", "Remote tree inspection policy denied the request");
        socket.end();
        return;
      }
      const principals = this.accessRegistry.inspectSubtree(targetId).filter((candidate) => authorize(policyState, parent.id, "inspect_tree", candidate.id, { actorGeneration: parent.generation }).allowed).map((candidate) => this.principalSummary(candidate));
      this.audit.record({
        event: "tree_inspected",
        outcome: "allowed",
        actorId: parent.id,
        targetId,
        remoteHostId: parent.remoteHostId,
        generation: parent.generation,
        visibleCount: principals.length
      });
      writeMessage(socket, { type: "access_control_result", requestId: message.requestId, action: "inspect_tree", principals });
      socket.end();
      return;
    }
    if (message.action !== "issue_child_enrollment" || typeof message.enrollment !== "object" || message.enrollment === null || Array.isArray(message.enrollment)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote control action was rejected");
      socket.end();
      return;
    }
    const enrollment = message.enrollment;
    if (typeof enrollment.name !== "string" || enrollment.ttlMs !== void 0 && (typeof enrollment.ttlMs !== "number" || !Number.isSafeInteger(enrollment.ttlMs)) || enrollment.expiresAt !== void 0 && (typeof enrollment.expiresAt !== "number" || !Number.isSafeInteger(enrollment.expiresAt)) || enrollment.canDelegate !== void 0 && typeof enrollment.canDelegate !== "boolean" || enrollment.maxDepth !== void 0 && (typeof enrollment.maxDepth !== "number" || !Number.isSafeInteger(enrollment.maxDepth)) || enrollment.maxChildren !== void 0 && (typeof enrollment.maxChildren !== "number" || !Number.isSafeInteger(enrollment.maxChildren))) {
      this.sendError(socket, "ACCESS_DENIED", "Remote delegation request was rejected");
      socket.end();
      return;
    }
    const delegation = authorize(policyState, parent.id, "delegate_child", parent.id, {
      actorGeneration: parent.generation,
      targetGeneration: parent.generation
    });
    if (!delegation.allowed) {
      this.sendError(socket, "ACCESS_DENIED", "Remote delegation policy denied the request");
      socket.end();
      return;
    }
    let issued;
    try {
      issued = this.accessRegistry.issueChildEnrollment(parent.id, parent.generation, {
        name: enrollment.name,
        ...enrollment.expiresAt !== void 0 ? { expiresAt: enrollment.expiresAt } : {},
        ...enrollment.canDelegate !== void 0 ? { canDelegate: enrollment.canDelegate } : {},
        ...enrollment.maxDepth !== void 0 ? { maxDepth: enrollment.maxDepth } : {},
        ...enrollment.maxChildren !== void 0 ? { maxChildren: enrollment.maxChildren } : {}
      }, enrollment.ttlMs);
    } catch {
      this.sendError(socket, "ACCESS_DENIED", "Remote delegation limits denied the request");
      socket.end();
      return;
    }
    this.audit.record({
      event: "enrollment_issued",
      outcome: "allowed",
      actorId: parent.id,
      targetId: enrollment.name,
      remoteHostId: parent.remoteHostId,
      generation: parent.generation,
      reason: `delegated-expires:${issued.expiresAt}`
    });
    writeMessage(socket, {
      type: "access_control_result",
      requestId: message.requestId,
      action: "issue_child_enrollment",
      enrollmentToken: issued.enrollmentToken,
      expiresAt: issued.expiresAt,
      parentSessionId: parent.id
    });
    socket.end();
  }
  registryPolicyState() {
    const records = this.accessRegistry.snapshot().principals;
    const principals = {};
    for (const record of Object.values(records)) {
      principals[record.id] = {
        id: record.id,
        kind: "remote",
        state: record.state,
        generation: record.generation,
        policy: "remote-tree",
        parentSessionId: record.parentSessionId,
        rootSessionId: record.rootSessionId
      };
      if (!principals[record.rootSessionId]) {
        principals[record.rootSessionId] = {
          id: record.rootSessionId,
          kind: "local",
          state: "active",
          generation: 1,
          policy: "local-public",
          rootSessionId: record.rootSessionId
        };
      }
    }
    return { principals };
  }
  principalSummary(principal) {
    return { ...principal, connected: this.sessions.has(principal.id) };
  }
  reconcileExpiredPrincipals() {
    const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
    const changed = this.accessRegistry.expirePrincipals();
    if (changed.length > 0) this.disconnectTransitionedPrincipals(changed, priorSessions, "principal_expired");
  }
  disconnectTransitionedPrincipals(changed, priorSessions, auditEvent = "principal_revoked") {
    const changedIds = new Set(changed.map((principal) => principal.id));
    for (const principal of changed) {
      const live = this.sessions.get(principal.id);
      if (!live) {
        this.audit.record({
          event: auditEvent,
          outcome: "allowed",
          actorId: principal.id,
          remoteHostId: principal.remoteHostId,
          generation: principal.generation,
          reason: "OFFLINE"
        });
        continue;
      }
      const subject = priorSessions.find((session) => session.id === principal.id) ?? live.info;
      for (const [recipientId, recipient] of this.sessions) {
        if (recipientId !== principal.id && !changedIds.has(recipientId) && authorizeSessionAction(priorSessions, recipientId, "discover", principal.id).allowed) {
          writeMessage(recipient.socket, { type: "session_left", sessionId: principal.id });
        }
      }
      this.clearPendingDeliveriesForSession(principal.id, live.socket);
      this.clearAskEdgesForSession(principal.id, "authorization_revoked");
      this.sessions.delete(principal.id);
      for (const [key, recent] of this.recentDeliveries) {
        if (recent.from === principal.id || recent.to === principal.id) this.recentDeliveries.delete(key);
      }
      this.audit.record({
        event: auditEvent,
        outcome: "allowed",
        actorId: principal.id,
        targetId: subject.parentSessionId,
        remoteHostId: principal.remoteHostId,
        generation: principal.generation,
        reason: "DISCONNECTED"
      });
      live.socket.destroy();
    }
    if (changed.length > 0) this.scheduleShutdownCheck();
  }
  isCurrentPrincipal(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.info.origin !== "remote") return true;
    try {
      this.accessRegistry.validatePrincipal(sessionId, session.info.generation ?? 0);
      return true;
    } catch {
      return false;
    }
  }
  isAuthorized(actorId, action, targetId) {
    if (!this.isCurrentPrincipal(actorId) || !this.isCurrentPrincipal(targetId)) return false;
    return authorizeSessionAction(
      Array.from(this.sessions.values(), (session) => session.info),
      actorId,
      action,
      targetId
    ).allowed;
  }
  broadcastVisible(message, subject, exclude) {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && this.isAuthorized(id, "discover", subject.id)) {
        writeMessage(session.socket, message);
      }
    }
  }
  askKey(fromSessionId, messageId) {
    return `${fromSessionId}\0${messageId}`;
  }
  deliveryKey(fromSessionId, messageId) {
    return `${fromSessionId}\0${messageId}`;
  }
  addAskEdge(messageId, from, to) {
    const key = this.askKey(from, messageId);
    const previous = this.askEdges.get(key);
    if (previous) {
      clearTimeout(previous.timeout);
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + this.askTimeoutMs;
    this.askEdges.set(key, {
      messageId,
      from,
      to,
      createdAt,
      expiresAt,
      state: "blocking",
      timeout: this.scheduleAskExpiry(key, expiresAt)
    });
    this.persistAskEdges();
  }
  removeAskEdge(key, reason, notifyRecipient = false) {
    const edge = this.askEdges.get(key);
    if (!edge) {
      return;
    }
    clearTimeout(edge.timeout);
    this.askEdges.delete(key);
    this.persistAskEdges();
    if (reason && notifyRecipient) {
      this.notifyAskCancelled(edge.to, edge.messageId, edge.from, reason);
    }
  }
  notifyAskDeferred(edge) {
    const recipient = this.sessions.get(edge.to);
    if (recipient) {
      writeMessage(recipient.socket, {
        type: "ask_deferred",
        messageId: edge.messageId,
        fromSessionId: edge.from
      });
    }
  }
  notifyAskCancelled(sessionId, messageId, fromSessionId, reason) {
    const session = this.sessions.get(sessionId);
    if (session) {
      writeMessage(session.socket, { type: "ask_cancelled", messageId, fromSessionId, reason });
    }
  }
  clearAskEdgesForSession(sessionId, reason) {
    let changed = false;
    for (const [key, edge] of this.askEdges) {
      if (edge.from === sessionId || edge.to === sessionId) {
        clearTimeout(edge.timeout);
        this.askEdges.delete(key);
        changed = true;
        if (edge.from === sessionId) {
          this.notifyAskCancelled(edge.to, edge.messageId, edge.from, reason);
        } else {
          this.notifyAskCancelled(edge.from, edge.messageId, edge.to, reason);
        }
      }
    }
    if (changed) {
      this.persistAskEdges();
    }
  }
  deferAskEdgesForSession(sessionId) {
    let changed = false;
    for (const edge of this.askEdges.values()) {
      if ((edge.from === sessionId || edge.to === sessionId) && edge.state === "blocking") {
        edge.state = "deferred";
        changed = true;
        if (edge.from === sessionId) {
          this.notifyAskDeferred(edge);
        }
      }
    }
    if (changed) {
      this.persistAskEdges();
    }
  }
  scheduleAskExpiry(key, expiresAt) {
    const delay = Math.max(1, Math.min(expiresAt - Date.now(), 2147483647));
    const timeout = setTimeout(() => {
      if (expiresAt > Date.now()) {
        const edge = this.askEdges.get(key);
        if (edge) {
          clearTimeout(edge.timeout);
          edge.timeout = this.scheduleAskExpiry(key, expiresAt);
        }
        return;
      }
      this.removeAskEdge(key, "expired", true);
    }, delay);
    timeout.unref?.();
    return timeout;
  }
  loadAskEdges() {
    if (!existsSync2(ASK_STATE_PATH)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync4(ASK_STATE_PATH, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("expected an object");
      }
      const state = parsed;
      if (state.version !== 1) {
        throw new Error("unsupported state version");
      }
      const edges = state.edges;
      if (!Array.isArray(edges)) {
        throw new Error("expected an edges array");
      }
      const now = Date.now();
      for (const candidate of edges) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
          continue;
        }
        const edge = candidate;
        if (typeof edge.messageId !== "string" || edge.messageId.length === 0 || edge.messageId.length > MAX_MESSAGE_ID_LENGTH || !isSessionId(edge.from) || !isSessionId(edge.to) || typeof edge.createdAt !== "number" || !Number.isFinite(edge.createdAt) || typeof edge.expiresAt !== "number" || !Number.isFinite(edge.expiresAt) || edge.expiresAt <= now || edge.state !== "blocking" && edge.state !== "deferred") {
          continue;
        }
        const key = this.askKey(edge.from, edge.messageId);
        this.askEdges.set(key, {
          messageId: edge.messageId,
          from: edge.from,
          to: edge.to,
          createdAt: edge.createdAt,
          expiresAt: edge.expiresAt,
          state: "deferred",
          timeout: this.scheduleAskExpiry(key, edge.expiresAt)
        });
      }
      this.persistAskEdges();
    } catch (error) {
      console.error(`Failed to load persisted ask state at ${ASK_STATE_PATH}:`, error);
      for (const edge of this.askEdges.values()) {
        clearTimeout(edge.timeout);
      }
      this.askEdges.clear();
      try {
        const corruptPath = `${ASK_STATE_PATH}.corrupt-${Date.now()}`;
        renameSync2(ASK_STATE_PATH, corruptPath);
        restrictIntercomRuntimeFile(corruptPath);
      } catch {
      }
    }
  }
  persistAskEdges() {
    const edges = Array.from(this.askEdges.values(), (edge) => ({
      messageId: edge.messageId,
      from: edge.from,
      to: edge.to,
      createdAt: edge.createdAt,
      expiresAt: edge.expiresAt,
      state: edge.state
    }));
    writeDurableJson(ASK_STATE_PATH, { version: 1, edges });
  }
  countAskEdgesFrom(sessionId) {
    let count = 0;
    for (const edge of this.askEdges.values()) {
      if (edge.from === sessionId) {
        count += 1;
      }
    }
    return count;
  }
  countPendingDeliveriesFrom(sessionId) {
    let count = 0;
    for (const delivery of this.pendingDeliveries.values()) {
      if (delivery.from === sessionId) {
        count += 1;
      }
    }
    return count;
  }
  acknowledgePendingDelivery(deliveryId, sessionId, socket) {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending || pending.to !== sessionId || pending.recipientSocket !== socket) {
      return;
    }
    const sender = this.sessions.get(pending.from);
    const recipient = this.sessions.get(pending.to);
    if (!sender || !recipient || (sender.info.generation ?? 1) !== pending.fromGeneration || (recipient.info.generation ?? 1) !== pending.toGeneration || !this.isAuthorized(pending.from, pending.action, pending.to)) {
      this.failPendingDelivery(deliveryId, "SESSION_NOT_FOUND", "Delivery authorization changed before acknowledgement");
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.replyTo) {
      this.removeAskEdge(this.askKey(pending.to, pending.message.replyTo));
    }
    const response = { type: "delivered", messageId: pending.message.id, deliveryId };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      from: pending.from,
      to: pending.to,
      action: pending.action,
      fromGeneration: pending.fromGeneration,
      toGeneration: pending.toGeneration,
      retryable: false,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS
    });
    if (sender.socket === pending.senderSocket) {
      writeMessage(sender.socket, response);
    }
  }
  failPendingDelivery(deliveryId, code, reason) {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.expectsReply) {
      this.removeAskEdge(this.askKey(pending.from, pending.message.id), "delivery_failed", true);
    }
    const response = {
      type: "delivery_failed",
      messageId: pending.message.id,
      accepted: true,
      code,
      reason
    };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      from: pending.from,
      to: pending.to,
      action: pending.action,
      fromGeneration: pending.fromGeneration,
      toGeneration: pending.toGeneration,
      retryable: true,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS
    });
    const sender = this.sessions.get(pending.from);
    if (sender?.socket === pending.senderSocket) {
      writeMessage(sender.socket, response);
    }
  }
  clearPendingDeliveriesForSession(sessionId, socket) {
    for (const delivery of Array.from(this.pendingDeliveries.values())) {
      if (delivery.to === sessionId && delivery.recipientSocket === socket) {
        this.failPendingDelivery(delivery.id, "RECIPIENT_DISCONNECTED", "Recipient disconnected before acknowledging the message");
      } else if (delivery.from === sessionId && delivery.senderSocket === socket) {
        this.failPendingDelivery(delivery.id, "SENDER_DISCONNECTED", "Sender disconnected before delivery was acknowledged");
      }
    }
  }
  pruneRecentDeliveries(now = Date.now()) {
    for (const [key, delivery] of this.recentDeliveries) {
      if (delivery.expiresAt <= now) {
        this.recentDeliveries.delete(key);
      }
    }
  }
  findSessions(nameOrId) {
    const byId = this.sessions.get(nameOrId);
    if (byId) {
      return [byId];
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter((session) => session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) {
      return byName;
    }
    return Array.from(this.sessions.entries()).filter(([id]) => id.startsWith(nameOrId)).map(([, session]) => session);
  }
  shutdown() {
    console.log("Broker shutting down");
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    for (const delivery of this.pendingDeliveries.values()) {
      clearTimeout(delivery.timeout);
    }
    this.pendingDeliveries.clear();
    this.pendingDeliveryKeys.clear();
    for (const edge of this.askEdges.values()) {
      clearTimeout(edge.timeout);
    }
    this.askEdges.clear();
    const ownsBroker = hasBrokerOwnership(OWNER_PATH);
    if (ownsBroker && typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      for (const socketPath of [LISTEN_TARGET, REMOTE_LISTEN_TARGET]) {
        try {
          unlinkSync2(socketPath);
        } catch {
        }
      }
    }
    if (ownsBroker) {
      try {
        unlinkSync2(PORT_PATH);
      } catch {
      }
      try {
        unlinkSync2(PID_PATH);
      } catch {
      }
      releaseBrokerOwnership(OWNER_PATH);
    }
    this.server.close();
    this.remoteServer?.close();
    process.exit(0);
  }
};
new IntercomBroker().start();
