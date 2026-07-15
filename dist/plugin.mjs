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
  return session.trustedLocal === void 0 || typeof session.trustedLocal === "boolean";
}
var IntercomClient = class extends EventEmitter {
  socket = null;
  _sessionId = null;
  pendingSends = /* @__PURE__ */ new Map();
  pendingLists = /* @__PURE__ */ new Map();
  pendingAskControls = /* @__PURE__ */ new Map();
  outbox = null;
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
          ...sessionId ? { sessionId } : {},
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
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
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
  acknowledgeMessage(deliveryId) {
    return this.writeControlMessage({ type: "message_received", deliveryId });
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
import { existsSync as existsSync2, readFileSync as readFileSync3, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { join as join3, dirname as dirname2, extname, basename } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net2 from "net";
import { randomUUID as randomUUID3 } from "crypto";
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
  return response.type === "health_ok" && response.requestId === requestId && response.protocol === INTERCOM_PROTOCOL_NAME && response.version === INTERCOM_PROTOCOL_VERSION;
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
    pid = Number.parseInt(readFileSync3(pidFile, "utf-8").trim(), 10);
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
    const pid = parseInt(readFileSync3(BROKER_PID, "utf-8").trim(), 10);
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
    const [pidLine = "", createdAtLine = "0"] = readFileSync3(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
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
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "fs";
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
    const raw = readFileSync4(configPath, "utf-8");
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
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "fs";
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
      return normalizeState(JSON.parse(readFileSync5(this.path, "utf8")));
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

// opencode/runtime.ts
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
function formatSessionList(sessions, currentSessionId, currentCwd) {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : void 0,
      session.cwd === currentCwd ? "same cwd" : void 0,
      session.status
    ].filter((tag) => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${session.name || "unnamed"} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
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
  identity;
  unread = [];
  unresolvedAsks = /* @__PURE__ */ new Map();
  replyWaiters = /* @__PURE__ */ new Map();
  onInboundMessage;
  inboundStore;
  constructor(identity, cwd, onInboundMessage, inboundStore) {
    this.identity = identity ?? buildOpenCodeRuntimeIdentity(process.env, cwd);
    this.onInboundMessage = onInboundMessage;
    this.inboundStore = inboundStore ?? new DurableInboundStore(
      process.env.OPENCODE_INTERCOM_INBOUND_STATE?.trim() || getOpenCodeInboundStatePath(this.identity.sessionId)
    );
    this.unread = this.inboundStore.retainedEntries();
    for (const entry of this.inboundStore.unresolvedAsks()) this.unresolvedAsks.set(entry.message.id, entry);
  }
  getIdentity() {
    return this.identity;
  }
  async connect() {
    if (this.client?.isConnected()) return this.client;
    const config = loadConfig();
    if (!config.enabled) throw new Error("Intercom disabled");
    await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    const client = new IntercomClient();
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
    for (const entry of this.inboundStore.pendingInjection()) {
      void Promise.resolve(this.onInboundMessage?.(entry)).catch((error) => {
        console.error("Failed to replay durable inbound intercom message:", error);
      });
    }
    return client;
  }
  async disconnect() {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
  }
  handleIncomingMessage(from, message, deliveryId) {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
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
    const pendingAsks = Array.from(this.unresolvedAsks.values());
    const lines = [
      unreadMessages.length ? unreadMessages.map((entry) => `- ${entry.from.name || entry.from.id}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n") : "No unread messages.",
      pendingAsks.length ? `
Pending asks:
${pendingAsks.map((entry) => `- ${entry.message.id} from ${entry.from.name || entry.from.id}: ${entry.message.content.text}`).join("\n")}` : ""
    ].filter(Boolean);
    return textResult(lines.join("\n"), { unread_messages: unreadMessages, pending_asks: pendingAsks });
  }
  async reply(message, to, replyTo) {
    let target;
    if (replyTo) {
      target = this.unresolvedAsks.get(replyTo);
    } else if (to) {
      const lowerTo = to.toLowerCase();
      const matches = Array.from(this.unresolvedAsks.values()).filter(
        (entry) => entry.from.id === to || entry.from.name?.toLowerCase() === lowerTo || entry.from.id.startsWith(to)
      );
      if (matches.length > 1) {
        return textResult(`Multiple pending asks match "${to}". Call intercom_pending and reply with reply_to.`, { ok: false }, true);
      }
      target = matches[0];
    } else if (this.unresolvedAsks.size === 1) {
      target = Array.from(this.unresolvedAsks.values())[0];
    }
    if (!target) {
      return textResult("No matching pending ask. Call intercom_pending to inspect unresolved asks.", { ok: false }, true);
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
import { mkdirSync as mkdirSync4, readFileSync as readFileSync6, readdirSync, renameSync as renameSync3, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join6 } from "node:path";
var CONTROL_DIR_NAME = "opencode-control";
function controlDir() {
  const directory = join6(getIntercomDirPath(), CONTROL_DIR_NAME);
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
        const requestPath = join6(directory, file);
        let request;
        try {
          request = JSON.parse(readFileSync6(requestPath, "utf8"));
        } catch {
          continue;
        }
        if (!request?.id || !request.sessionId || !options.acceptsSession(request.sessionId)) continue;
        const responsePath = join6(directory, responseName(request.sessionId, request.id));
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
    const from = entry.from.name || entry.from.id;
    const replyHint = entry.message.expectsReply ? `

This message expects a reply. Use intercom_reply with reply_to "${entry.message.id}" after you respond.` : "";
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
    const from = entry.from.name || entry.from.id;
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
  runtime = new OpenCodeIntercomRuntime(void 0, directory, injectInbound);
  const runtimeIdentity = runtime.getIdentity();
  healthReporter = new OpenCodePeerHealthReporter({
    path: process.env.AGENT_INTERCOM_OPENCODE_HEALTH_PATH,
    runId: process.env.AGENT_INTERCOM_RUN_ID,
    workerId: process.env.AGENT_INTERCOM_WORKER_ID,
    intercomSessionId: runtimeIdentity.sessionId,
    serverUrl: serverUrl.toString(),
    directory
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
  const fleetManagementEnabled = isFleetManagementEnabled();
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
      stopControlServer();
      healthReporter.update({ connected: false, ready: false, status: "stopped" });
      await runtime.disconnect();
    },
    tool: {
      ...fleetManagementEnabled ? {
        agent_fleet: tool({
          description: "Create, inspect, adopt, stop, and clean up systemd-owned Pi, Codex, Claude, and OpenCode coworkers. Spawn/list results include direct Intercom targets; list/status default to this manager's workers. Enabled only for an explicitly configured primary OpenCode manager.",
          args: {
            action: tool.schema.string().describe("Fleet action: spawn, list, status, stop, cleanup, doctor, logs, renew, forget, adopt, capabilities, profiles, models, variants, or config."),
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
            execute: tool.schema.boolean().optional().describe("Actually execute cleanup; false previews."),
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
        description: "Ask another local intercom session a blocking question and wait briefly for a reply.",
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
        description: "Reply to a pending inbound intercom ask.",
        args: {
          message: tool.schema.string().describe("Reply text."),
          to: tool.schema.string().optional().describe("Optional sender name/id if there are multiple pending asks."),
          reply_to: tool.schema.string().optional().describe("Optional message id from intercom_pending.")
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.reply(args.message, args.to, args.reply_to));
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
  OpenCodeIntercomPlugin,
  plugin_default as default
};
