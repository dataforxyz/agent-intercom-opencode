// broker/broker.ts
import net from "net";
import { existsSync, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync3, unlinkSync as unlinkSync2 } from "fs";
import { join as join2 } from "path";
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

// broker/broker.ts
var INTERCOM_DIR = getIntercomDirPath();
var LISTEN_TARGET = getBrokerListenTarget();
var PID_PATH = join2(INTERCOM_DIR, "broker.pid");
var OWNER_PATH = join2(INTERCOM_DIR, "broker.owner");
var PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
var ASK_STATE_PATH = getBrokerAskStateFilePath(INTERCOM_DIR);
var BROKER_STATE_ID = randomUUID2();
var MAX_SESSIONS = 128;
var MAX_UNREGISTERED_CONNECTIONS = 32;
var REGISTRATION_TIMEOUT_MS = 1e3;
var RATE_LIMIT_CAPACITY = 240;
var RATE_LIMIT_REFILL_PER_SECOND = 120;
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
  shutdownTimer = null;
  askTimeoutMs = getAskTimeoutMs();
  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    acquireBrokerOwnership(OWNER_PATH);
    this.loadAskEdges();
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      try {
        unlinkSync2(LISTEN_TARGET);
      } catch {
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }
  start() {
    const onListening = () => {
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
      writeFileSync3(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid})`);
    };
    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onListening);
    }
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }
  handleConnection(socket) {
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
      tokens: RATE_LIMIT_CAPACITY,
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
        this.handleMessage(socket, msg, sessionId, (id) => {
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
          this.sessions.delete(sessionId);
          this.clearPendingDeliveriesForSession(sessionId, socket);
          this.deferAskEdgesForSession(sessionId);
          this.broadcast({ type: "session_left", sessionId }, sessionId);
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
        RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * RATE_LIMIT_REFILL_PER_SECOND / 1e3
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
  handleMessage(socket, msg, currentId, setId) {
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
        version: INTERCOM_PROTOCOL_VERSION
      });
      return;
    }
    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }
    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
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
        let id = randomUUID2();
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
        setId(id);
        const session = clientMessage.session;
        const info = {
          id,
          ...session.name !== void 0 ? { name: session.name } : {},
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...session.status !== void 0 ? { status: session.status } : {},
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32"
        };
        this.sessions.set(id, { socket, info, lastPresenceBroadcastAt: Date.now() });
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }
        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION
        });
        this.broadcast({ type: "session_joined", session: info }, id);
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
          this.sessions.delete(currentId);
          this.clearPendingDeliveriesForSession(currentId, socket);
          if (clientMessage.preserveAsks) {
            this.deferAskEdgesForSession(currentId);
          } else {
            this.clearAskEdgesForSession(currentId, "session_disconnected");
          }
          this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
          this.scheduleShutdownCheck();
        }
        setId(null);
        break;
      }
      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }
        const sessions = Array.from(this.sessions.values()).map((s) => s.info);
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
          if (recent.retryable) {
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
          } else {
            writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId: existing.id });
          }
          break;
        }
        if (this.pendingDeliveries.size >= MAX_PENDING_DELIVERIES || this.countPendingDeliveriesFrom(currentId) >= MAX_PENDING_DELIVERIES_PER_SESSION) {
          this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_DELIVERIES", "Too many messages are waiting for receiver acknowledgement");
          break;
        }
        const targets = this.findSessions(clientMessage.to);
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
          const deliveryId = randomUUID2();
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
        if (applied && edge.state === "blocking") {
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
            if (session.info.name !== clientMessage.name) {
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
            this.broadcast({ type: "presence_update", session: session.info }, currentId);
          }
        }
        break;
      }
      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
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
    if (!existsSync(ASK_STATE_PATH)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync3(ASK_STATE_PATH, "utf-8"));
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
    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.replyTo) {
      this.removeAskEdge(this.askKey(pending.to, pending.message.replyTo));
    }
    const response = { type: "delivered", messageId: pending.message.id, deliveryId };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      retryable: false,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS
    });
    const sender = this.sessions.get(pending.from);
    if (sender?.socket === pending.senderSocket) {
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
  broadcast(msg, exclude) {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }
  shutdown() {
    console.log("Broker shutting down");
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
      try {
        unlinkSync2(LISTEN_TARGET);
      } catch {
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
    process.exit(0);
  }
};
new IntercomBroker().start();
