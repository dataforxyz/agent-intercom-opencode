import type { Context, Plugin } from "@opencode/plugin/promise/plugin";
import { resolve } from "node:path";
import OpenCodeIntercomPlugin from "./plugin.ts";

type LegacyHookSet = Awaited<ReturnType<typeof OpenCodeIntercomPlugin>>;

const toolSchemas: Record<string, Record<string, unknown>> = {
  agent_fleet: { properties: { action: { type: "string" }, id: { type: "string" }, harness: { type: "string" }, role: { type: "string" }, task: { type: "string" }, cwd: { type: "string" }, profile: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, instructions: { type: "string" }, fresh: { type: "boolean" }, all: { type: "boolean" }, execute: { type: "boolean" }, acknowledge: { type: "boolean" }, lines: { type: "number" } }, required: ["action"] },
  intercom_whoami: { properties: {} },
  intercom_team: { properties: {} },
  intercom_status: { properties: {} },
  intercom_list: { properties: { scope: { type: "string", enum: ["machine", "directory", "repo"] }, include_self: { type: "boolean" } } },
  intercom_set_summary: { properties: { summary: { type: "string" } }, required: ["summary"] },
  intercom_send: { properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"] },
  intercom_ask: { properties: { to: { type: "string" }, message: { type: "string" }, timeout_ms: { type: "number" } }, required: ["to", "message"] },
  intercom_pending: { properties: { mark_read: { type: "boolean" } } },
  intercom_reply: { properties: { message: { type: "string" }, to: { type: "string" }, which: { type: "string", enum: ["oldest", "latest"] } }, required: ["message"] },
};

function sameDirectory(left: unknown, right: string): boolean {
  return typeof left === "string" && resolve(left) === resolve(right);
}

function legacyPart(message: any, sessionID: string): any {
  if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
    return {
      info: { id: message.id, sessionID, role: "user", agent: message.agent },
      parts: [{ id: `${message.id}-text`, sessionID, messageID: message.id, type: "text", text: message.text ?? "", synthetic: message.type !== "user" }],
    };
  }
  return {
    info: { id: message.id, sessionID, role: "assistant", agent: message.agent },
    parts: (message.content ?? []).map((part: any, index: number) => ({
      id: part.id ?? `${message.id}-${index}`,
      sessionID,
      messageID: message.id,
      ...part,
    })),
  };
}

function legacyClient(ctx: Context) {
  return {
    app: {
      log: async ({ body }: any) => {
        const line = `[${body?.service ?? "agent-intercom"}] ${body?.message ?? ""}`;
        body?.level === "warn" ? console.warn(line) : console.info(line);
        return { data: true };
      },
    },
    tui: {
      showToast: async () => ({ data: false }),
      appendPrompt: async () => ({ data: false }),
      submitPrompt: async () => ({ data: false }),
    },
    session: {
      list: async () => ({ data: [] }),
      get: async ({ path }: any) => ({ data: await ctx.session.get({ sessionID: path.id }) }),
      messages: async ({ path }: any) => ({
        data: (await ctx.session.context({ sessionID: path.id })).map((message: any) =>
          legacyPart(message, path.id)
        ),
      }),
      promptAsync: async ({ path, body }: any) => {
        const text = (body?.parts ?? [])
          .filter((part: any) => part?.type === "text")
          .map((part: any) => part.text ?? "")
          .join("\n");
        const data = await ctx.session.prompt({
          sessionID: path.id,
          text,
          delivery: "queue",
          metadata: body?.parts?.[0]?.metadata,
        });
        return { data, response: new Response(null, { status: 200 }) };
      },
    },
  } as any;
}

function toLegacyEvent(raw: any) {
  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  const type = typeof source?.type === "string" ? source.type.replace(/\.1$/, "") : source?.type;
  const data = source?.data ?? {};
  if (source && typeof source === "object" && "properties" in source) return source;
  if (type === "session.created" || type === "session.updated") {
    return { type, properties: { info: data.session ?? data.info ?? data } };
  }
  return { type, properties: data };
}

async function belongsToLocation(ctx: Context, raw: any): Promise<boolean> {
  const directory = raw?.directory ?? raw?.payload?.directory ?? raw?.data?.info?.directory;
  if (directory) return sameDirectory(directory, ctx.location.directory);
  const data = raw?.data ?? raw?.payload?.data ?? raw?.properties;
  const sessionID = data?.sessionID ?? data?.session?.id ?? data?.info?.id;
  if (!sessionID) return false;
  try {
    const session: any = await ctx.session.get({ sessionID });
    return sameDirectory(session?.directory ?? session?.data?.directory, ctx.location.directory);
  } catch {
    return false;
  }
}

function toolResult(value: unknown): { content: string; metadata?: unknown } {
  if (typeof value === "string") return { content: value };
  if (value && typeof value === "object" && typeof (value as any).output === "string") {
    return { content: (value as any).output, metadata: (value as any).metadata };
  }
  return { content: JSON.stringify(value ?? null) };
}

const OpenCodeIntercomPluginV2: Plugin = {
  id: "agent-intercom",
  async setup(ctx) {
    const legacy = await OpenCodeIntercomPlugin({
      client: legacyClient(ctx),
      directory: ctx.location.directory,
      worktree: ctx.location.project.directory,
      project: ctx.location.project,
      serverUrl: new URL("http://127.0.0.1"),
    } as any, ctx.options as any) as LegacyHookSet;

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(legacy.tool ?? {})) {
        const schema = toolSchemas[name];
        if (!schema) continue;
        editor.add({
          name,
          description: definition.description,
          input: { type: "object", ...schema, additionalProperties: false } as any,
          execute: async (args: any, toolContext: any) => toolResult(await definition.execute(args, {
            sessionID: toolContext.sessionID,
            messageID: toolContext.messageID,
            agent: toolContext.agent,
            directory: ctx.location.directory,
            worktree: ctx.location.project.directory,
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          } as any)) as any,
        } as any);
      }
    });

    const announceSession = async (sessionID: string) => {
      await legacy.event?.({ event: { type: "session.updated", properties: { info: { id: sessionID } } } } as any);
    };
    await ctx.session.hook("prompt", (event) => announceSession(event.sessionID));
    await ctx.session.hook("context", (event) => announceSession(event.sessionID));

    const controller = new AbortController();
    const watcher = (async () => {
      if (!legacy.event) return;
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          if (await belongsToLocation(ctx, raw)) {
            await legacy.event({ event: toLegacyEvent(raw) } as any);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("agent-intercom event bridge failed", error);
      }
    })();

    return async () => {
      controller.abort();
      await watcher;
      await legacy.dispose?.();
    };
  },
};

export default OpenCodeIntercomPluginV2;
