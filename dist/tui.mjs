// opencode/contact.ts
import { spawnSync } from "node:child_process";

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;

// broker/paths.ts
import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
var INTERCOM_RUNTIME_FILE_MODE = 384;
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
function restrictIntercomRuntimeFile(filePath, platform = process.platform) {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}

// broker/spawn.ts
import { join as join2, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join2(dirname(fileURLToPath(import.meta.url)), "..");
var BROKER_PID = join2(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join2(INTERCOM_DIR, "broker.spawn.lock");

// config.ts
var DEFAULT_ASK_TIMEOUT_MS = 45 * 1e3;
var MAX_ASK_TIMEOUT_MS = 120 * 1e3;

// opencode/contact.ts
function copyText(text, platform = process.platform) {
  const candidates = platform === "darwin" ? [["pbcopy", []]] : platform === "win32" ? [["clip.exe", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  return candidates.some(([command, args]) => {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    return result.status === 0;
  });
}

// opencode/control.ts
import { randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
var CONTROL_DIR_NAME = "opencode-control";
function controlDir() {
  const directory = join3(getIntercomDirPath(), CONTROL_DIR_NAME);
  mkdirSync2(directory, { recursive: true, mode: 448 });
  return directory;
}
function safeSessionId(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function requestName(sessionId, requestId) {
  return `${safeSessionId(sessionId)}.${requestId}.request.json`;
}
function responseName(sessionId, requestId) {
  return `${safeSessionId(sessionId)}.${requestId}.response.json`;
}
function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 384 });
  restrictIntercomRuntimeFile(temporary);
  renameSync(temporary, path);
  restrictIntercomRuntimeFile(path);
}
async function requestOpenCodeControl(sessionId, action, timeoutMs = 5e3) {
  const directory = controlDir();
  const id = randomUUID();
  const requestPath = join3(directory, requestName(sessionId, id));
  const responsePath = join3(directory, responseName(sessionId, id));
  const request = { id, sessionId, action, createdAt: Date.now() };
  writeJsonAtomic(requestPath, request);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(readFileSync2(responsePath, "utf8"));
        return response;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 50));
    }
    return { ok: false, error: "The OpenCode intercom server plugin did not respond. Check that dist/plugin.mjs is enabled." };
  } finally {
    rmSync(requestPath, { force: true });
    rmSync(responsePath, { force: true });
  }
}

// opencode/tui.ts
function activeSessionId(api) {
  if (api.route.current.name !== "session") return void 0;
  const sessionId = api.route.current.params.sessionID;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : void 0;
}
function toastError(api, message) {
  api.ui.toast({ title: "Intercom", message, variant: "error", duration: 5e3 });
}
async function withActiveSession(api, action) {
  const sessionId = activeSessionId(api);
  if (!sessionId) {
    toastError(api, "Open a session before using Intercom.");
    return;
  }
  await action(sessionId);
}
function isSessionInfo(value) {
  if (!value || typeof value !== "object") return false;
  const session = value;
  return typeof session.id === "string" && typeof session.cwd === "string" && typeof session.model === "string";
}
async function showIntercom(api, dialog) {
  await withActiveSession(api, async (sessionId) => {
    const response = await requestOpenCodeControl(sessionId, { type: "list" });
    if (!response.ok) {
      toastError(api, response.error ?? "Could not list intercom sessions.");
      return;
    }
    const sessions = Array.isArray(response.value) ? response.value.filter(isSessionInfo) : [];
    if (!sessions.length) {
      api.ui.toast({ title: "Intercom", message: "No other intercom sessions are connected.", variant: "info" });
      return;
    }
    dialog.setSize("large");
    dialog.replace(() => api.ui.DialogSelect({
      title: "Send an intercom message",
      placeholder: "Search sessions",
      options: sessions.map((session) => ({
        title: session.name || session.id,
        value: session,
        description: `${session.id.slice(0, 8)} \xB7 ${session.model} \xB7 ${session.cwd}`,
        footer: session.status || "idle"
      })),
      onSelect(option) {
        const target = option.value;
        dialog.replace(() => api.ui.DialogPrompt({
          title: `Message ${target.name || target.id}`,
          placeholder: "Type a message",
          onCancel: () => dialog.clear(),
          onConfirm: async (message) => {
            const text = message.trim();
            if (!text) return;
            dialog.clear();
            const sent = await requestOpenCodeControl(
              sessionId,
              { type: "send", to: target.id, message: text },
              12e3
            );
            if (!sent.ok) {
              toastError(api, sent.error ?? `Could not send to ${target.name || target.id}.`);
              return;
            }
            api.ui.toast({
              title: "Intercom",
              message: `Message sent to ${target.name || target.id}.`,
              variant: "success",
              duration: 4e3
            });
          }
        }));
      }
    }));
  });
}
async function copyIntercomId(api) {
  await withActiveSession(api, async (sessionId) => {
    const response = await requestOpenCodeControl(sessionId, { type: "whoami" });
    if (!response.ok || !response.value || typeof response.value !== "object") {
      toastError(api, response.error ?? "Could not read this session's intercom ID.");
      return;
    }
    const id = response.value.sessionId;
    if (typeof id !== "string" || !id) {
      toastError(api, "The server plugin returned an invalid intercom ID.");
      return;
    }
    const contact = `Intercom send ID: ${id}`;
    api.ui.toast({
      title: "Intercom",
      message: copyText(contact) ? `Copied: ${contact}` : contact,
      variant: "success",
      duration: 5e3
    });
  });
}
var module = {
  id: "opencode-intercom",
  tui: async (api) => {
    api.command?.register(() => [
      {
        title: "Send an intercom message",
        value: "intercom.send",
        description: "Choose a local agent and send it a message",
        category: "Intercom",
        keybind: "alt+m",
        slash: { name: "intercom" },
        onSelect: (dialog) => showIntercom(api, dialog ?? api.ui.dialog)
      },
      {
        title: "Copy intercom ID",
        value: "intercom.id.copy",
        description: "Copy this OpenCode session's stable intercom target",
        category: "Intercom",
        keybind: "alt+i",
        slash: { name: "intercom-id", aliases: ["intercom-contact"] },
        onSelect: () => copyIntercomId(api)
      }
    ]);
  }
};
var tui_default = module;
export {
  tui_default as default
};
