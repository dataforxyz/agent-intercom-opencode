import { appendFileSync } from "fs";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { OpenCodeIntercomRuntime, formatAttachments, formatSessionDisplay, type PendingInboundMessage } from "./runtime.ts";
import { normalizeOpenCodeSessionStatus, OpenCodePeerHealthReporter } from "./health.ts";
import { invokeAgentFleet, isFleetManagementEnabled } from "./fleet.ts";
import { startOpenCodeControlServer } from "./control.ts";
import { validateAskTimeoutMs } from "../config.ts";

const INJECT_LOG_PATH = "/tmp/intercom-inject.log";

interface PendingInjectEntry {
  entry: PendingInboundMessage;
}

function resultText(result: { content: Array<{ type: "text"; text: string }>; isError?: boolean }): string {
  const text = result.content.map(part => part.text).join("\n");
  if (result.isError) {
    throw new Error(text);
  }
  return text;
}

function listScope(value: string | undefined): "machine" | "directory" | "repo" {
  if (value === undefined) return "machine";
  if (value === "machine" || value === "directory" || value === "repo") return value;
  throw new Error('scope must be one of "machine", "directory", or "repo"');
}

export const OpenCodeIntercomPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  let activeSessionID = process.env.OPENCODE_INTERCOM_TARGET_SESSION?.trim() || process.env.OPENCODE_SESSION_ID?.trim() || undefined;
  let activeSessionStatus = "idle";
  const knownSessionIDs = new Set<string>();
  let flushingInjectQueue = false;
  const pendingInjectQueue: PendingInjectEntry[] = [];
  const deliveredMessageIDs = new Set<string>();
  let runtime: OpenCodeIntercomRuntime;
  let healthReporter: OpenCodePeerHealthReporter;
  const canUseTuiInjection = Boolean(process.stdin.isTTY || process.stdout.isTTY);
  const debugInject = process.env.OPENCODE_INTERCOM_DEBUG === "1";

  function logInject(step: string, details: Record<string, unknown>): void {
    if (!debugInject) {
      return;
    }
    try {
      appendFileSync(INJECT_LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), step, ...details })}\n`);
    } catch {
      // Ignore logging failures to avoid breaking message delivery.
    }
  }

  function formatError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      };
    }
    return { value: error };
  }

  async function logResult(step: string, result: {
    data?: unknown;
    error?: unknown;
    response?: Response;
  }, details: Record<string, unknown> = {}): Promise<void> {
    const responseBody = result.response
      ? await result.response.clone().text().catch(() => undefined)
      : undefined;
    logInject(step, {
      ...details,
      ok: result.error === undefined,
      status: result.response?.status,
      data: result.data,
      error: result.error,
      responseBody,
    });
  }

  function rememberBounded(values: Set<string>, value: string, limit = 4096): void {
    values.add(value);
    while (values.size > limit) {
      const oldest = values.values().next().value;
      if (typeof oldest !== "string") break;
      values.delete(oldest);
    }
  }

  function setActiveSession(sessionID: unknown): void {
    if (typeof sessionID === "string" && sessionID.trim()) {
      activeSessionID = sessionID;
      rememberBounded(knownSessionIDs, sessionID);
      healthReporter?.update({ openCodeSessionId: sessionID, status: activeSessionStatus });
    }
  }

  function messageMarker(messageID: string): string {
    return `[agent-intercom-message:${messageID}]`;
  }

  function formatInboundPrompt(entry: PendingInboundMessage): string {
    const from = formatSessionDisplay(entry.from);
    const replyHint = entry.message.expectsReply
      ? "\n\nThis message expects a reply. Use intercom_reply with only your reply text while this turn is active. If you reply later, use intercom_pending plus the sender and oldest/latest selector."
      : "";
    return [
      `Incoming intercom message from ${from} (${entry.from.model}, ${entry.from.cwd}):`,
      "",
      entry.message.content.text + formatAttachments(entry.message.content.attachments),
      replyHint,
      messageMarker(entry.message.id),
    ].join("\n");
  }

  async function resolveActiveSessionID(): Promise<string | undefined> {
    if (activeSessionID) {
      return activeSessionID;
    }

    const sessionList = await client.session.list({ query: { directory } }).catch((error) => {
      logInject("session.list.error", { error: formatError(error) });
      return undefined;
    });
    if (sessionList) {
      await logResult("session.list", sessionList);
    }
    const sessions = sessionList?.data;
    if (!sessions?.length) {
      return undefined;
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

  function enqueuePendingInject(entry: PendingInboundMessage, reason: string): void {
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

  function markDelivered(messageID: string, path: string): void {
    rememberBounded(deliveredMessageIDs, messageID);
    runtime.markInboundInjected(messageID);
    const queueIndex = pendingInjectQueue.findIndex((queued) => queued.entry.message.id === messageID);
    if (queueIndex >= 0) {
      pendingInjectQueue.splice(queueIndex, 1);
    }
    logInject("message.delivered", { messageID, path, queueLength: pendingInjectQueue.length });
  }

  async function sessionAlreadyContainsMessage(sessionID: string, messageID: string): Promise<boolean> {
    const marker = messageMarker(messageID);
    const result = await client.session.messages({
      path: { id: sessionID },
      query: { directory, limit: 200 },
    }).catch((error) => {
      logInject("session.messages.error", { sessionID, messageID, error: formatError(error) });
      return undefined;
    });
    const messages = result?.data;
    if (!messages) return false;
    return messages.some((message) => message.parts.some((part) => {
      if (part.type !== "text") return false;
      const metadata = part.metadata as Record<string, unknown> | undefined;
      return metadata?.intercomMessageId === messageID || part.text.includes(marker);
    }));
  }

  async function flushPendingInjectQueue(trigger: string): Promise<void> {
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
              parts: [{ type: "text", text: prompt, metadata: { intercomMessageId: entry.message.id } }],
            },
          });
        } catch (error) {
          logInject("queue.flush.promptAsync.throw", {
            trigger,
            sessionID,
            messageID: entry.message.id,
            error: formatError(error),
          });
          break;
        }

        await logResult("queue.flush.promptAsync", result, {
          trigger,
          sessionID,
          messageID: entry.message.id,
        });
        if (result.error !== undefined || !result.response?.ok) {
          break;
        }
        markDelivered(entry.message.id, "queue.flush.promptAsync");
      }
    } finally {
      logInject("queue.flush.end", { trigger, remaining: pendingInjectQueue.length });
      flushingInjectQueue = false;
    }
  }

  async function injectInbound(entry: PendingInboundMessage): Promise<void> {
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
      activeSessionStatus,
    });

    if (busy) {
      // In opencode run, append/submit may report success without creating a
      // durable follow-up turn, so keep an idle-flush fallback queued.
      enqueuePendingInject(entry, "session_busy_pre_tui");
    }

    logInject("inject.mode", {
      messageID: entry.message.id,
      canUseTuiInjection,
      busy,
    });

    try {
      const toastResult = await client.tui.showToast({
        body: {
          title: `Intercom from ${from}`,
          message: entry.message.content.text.slice(0, 240),
          variant: entry.message.expectsReply ? "warning" : "info",
          duration: 8000,
        },
        query: { directory },
      });
      await logResult("inject.toast", toastResult, { messageID: entry.message.id });
    } catch (error) {
      logInject("inject.toast.throw", { messageID: entry.message.id, error: formatError(error) });
    }

    if (canUseTuiInjection) {
      try {
        const appended = await client.tui.appendPrompt({
          body: { text: prompt },
          query: { directory },
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
      busy,
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
          parts: [{ type: "text", text: prompt, metadata: { intercomMessageId: entry.message.id } }],
        },
      });
      await logResult("inject.promptAsync", asyncResult, { messageID: entry.message.id, sessionID, busy });
      if (asyncResult.error === undefined && asyncResult.response?.ok) {
        markDelivered(entry.message.id, "session.promptAsync");
      } else {
        enqueuePendingInject(entry, "prompt_async_error");
      }
    } catch (error) {
      logInject("inject.promptAsync.throw", {
        messageID: entry.message.id,
        sessionID,
        error: formatError(error),
      });
      enqueuePendingInject(entry, "prompt_async_throw");
    }
  }

  runtime = new OpenCodeIntercomRuntime(undefined, directory, injectInbound);
  const runtimeIdentity = runtime.getIdentity();
  healthReporter = new OpenCodePeerHealthReporter({
    path: process.env.AGENT_INTERCOM_OPENCODE_HEALTH_PATH,
    runId: process.env.AGENT_INTERCOM_RUN_ID,
    workerId: process.env.AGENT_INTERCOM_WORKER_ID,
    intercomSessionId: runtimeIdentity.sessionId,
    serverUrl: serverUrl.toString(),
    directory,
  });
  runtime.setConnectionStateHandler((connected, error) => {
    healthReporter.update({
      connected,
      status: connected ? activeSessionStatus : "reconnecting",
      error: error?.message,
    });
  });
  void (async () => {
    try {
      await runtime.connect();
      healthReporter.update({ connected: true, status: activeSessionStatus, error: undefined });
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
    acceptsSession: sessionID => knownSessionIDs.has(sessionID),
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
        if (result.isError) throw new Error(result.content.map(part => part.text).join("\n"));
        return result.structuredContent ?? { ok: true };
      }
      throw new Error("Unsupported OpenCode intercom action.");
    },
  });

  return {
    dispose: async () => {
      stopControlServer();
      healthReporter.update({ connected: false, ready: false, status: "stopped" });
      await runtime.disconnect();
    },

    tool: {
      ...(fleetManagementEnabled ? {
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
            lines: tool.schema.number().optional().describe("Journal lines for logs."),
          },
          async execute(args, context) {
            setActiveSession(context.sessionID);
            const result = await invokeAgentFleet(args, {
              managerSessionId: runtimeIdentity.sessionId,
              cwd: directory,
            });
            return resultText(result);
          },
        }),
      } : {}),
      intercom_whoami: tool({
        description: "Show this OpenCode session's intercom identity.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.whoami());
        },
      }),

      intercom_team: tool({
        description: "Show your current manager and the live coworkers owned by that manager. No arguments are required.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.team());
        },
      }),

      intercom_status: tool({
        description: "Show local intercom connection status and pending message counts.",
        args: {},
        async execute(_args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.status());
        },
      }),

      intercom_list: tool({
        description: "List local Pi, Codex, Claude, and OpenCode intercom sessions.",
        args: {
          scope: tool.schema.string().optional().describe('Filter sessions: "machine", "directory", or "repo".'),
          include_self: tool.schema.boolean().optional().describe("Include this OpenCode session in the result."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.list(listScope(args.scope), args.include_self ?? false));
        },
      }),

      intercom_set_summary: tool({
        description: "Publish a short discoverable status for this OpenCode session.",
        args: {
          summary: tool.schema.string().describe("Short status shown to other intercom sessions."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.setSummary(args.summary));
        },
      }),

      intercom_send: tool({
        description: "Send a non-blocking message to another local intercom session.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Message text to send."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.send(args.to, args.message));
        },
      }),

      intercom_ask: tool({
        description: "Ask another local intercom session a question only when the next step depends on its reply. Use intercom_send for assignments, progress/status checkpoints, and notifications.",
        args: {
          to: tool.schema.string().describe("Target session name, id, or unique id prefix."),
          message: tool.schema.string().describe("Question text to send."),
          timeout_ms: tool.schema.number().optional().describe("Reply timeout in milliseconds, max 120000."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          const timeoutMs = args.timeout_ms === undefined
            ? undefined
            : validateAskTimeoutMs(args.timeout_ms);
          return resultText(await runtime.ask(args.to, args.message, undefined, timeoutMs));
        },
      }),

      intercom_pending: tool({
        description: "Read queued inbound intercom messages and unresolved asks.",
        args: {
          mark_read: tool.schema.boolean().optional().describe("Mark unread messages as read after returning them."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.pending(args.mark_read ?? false));
        },
      }),

      intercom_reply: tool({
        description: "Reply to a pending inbound intercom ask. Use to plus which=oldest/latest when one sender has multiple unresolved asks.",
        args: {
          message: tool.schema.string().describe("Reply text."),
          to: tool.schema.string().optional().describe("Optional sender name/id; never a message or thread ID."),
          which: tool.schema.enum(["oldest", "latest"]).optional().describe("Select the oldest or latest ask from the chosen sender."),
        },
        async execute(args, context) {
          setActiveSession(context.sessionID);
          return resultText(await runtime.reply(args.message, args.to, args.which));
        },
      }),
    },

    event: async ({ event }) => {
      const properties = (event as { properties?: Record<string, unknown> }).properties;
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties?.info as { id?: unknown } | undefined;
        setActiveSession(info?.id);
      } else {
        setActiveSession(properties?.sessionID);
      }

      if (event.type === "session.idle") {
        activeSessionStatus = "idle";
        healthReporter.update({ status: "idle", connected: true, error: undefined });
        await runtime.setSummary("idle");
        await flushPendingInjectQueue("session.idle");
      } else if (event.type === "session.status") {
        const status = normalizeOpenCodeSessionStatus(properties?.status);
        activeSessionStatus = status;
        healthReporter.update({ status, connected: true, error: undefined });
        await runtime.setSummary(status);
      }
    },
  };
};

export default OpenCodeIntercomPlugin;
