import { spawn } from "node:child_process";

export interface FleetInvocationContext {
  managerSessionId: string;
  cwd: string;
}

export function isFleetManagementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.OPENCODE_INTERCOM_FLEET === "1" || env.OPENCODE_INTERCOM_FLEET === "true";
  if (!enabled) return false;
  const ownedWorker = env.AGENT_INTERCOM_OWNED === "1";
  const allowNested = env.OPENCODE_INTERCOM_FLEET_ALLOW_NESTED === "1";
  return !ownedWorker || allowNested;
}

export async function invokeAgentFleet(
  params: Record<string, unknown>,
  context: FleetInvocationContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<any> {
  const command = env.AGENT_INTERCOM_FLEET_COMMAND?.trim() || "agent-intercom-fleet";
  const timeoutMs = Number(env.AGENT_INTERCOM_FLEET_TIMEOUT_MS || 120000);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      cwd: context.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(new Error(`Could not start ${command}: ${error.message}`, { cause: error })));
    child.on("close", (code) => {
      let response: any;
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
      finish(undefined, response.result);
    });
    child.stdin.end(JSON.stringify({ params, managerSessionId: context.managerSessionId, cwd: context.cwd }));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000);
    timer.unref?.();
  });
}
