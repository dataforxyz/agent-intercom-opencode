import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getIntercomDirPath } from "./broker/paths.ts";

export const DEFAULT_ASK_TIMEOUT_MS = 45 * 1000;
export const MAX_ASK_TIMEOUT_MS = 120 * 1000;

export function validateAskTimeoutMs(value: unknown, name = "timeout_ms"): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  if (value > MAX_ASK_TIMEOUT_MS) {
    throw new Error(`${name} must be ${MAX_ASK_TIMEOUT_MS} ms or less; use intercom_send plus intercom_pending for longer-running work`);
  }
  return value;
}

export function getAskTimeoutMs(): number {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }

  const value = Number(raw);
  return validateAskTimeoutMs(value, "PI_INTERCOM_ASK_TIMEOUT_MS");
}

export interface IntercomConfig {
  brokerCommand: string;
  brokerArgs: string[];
  enabled: boolean;
}

export function getConfigPath(): string {
  return join(getIntercomDirPath(), "opencode-config.json");
}

const defaults: IntercomConfig = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  enabled: true,
};

export function loadConfig(): IntercomConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...defaults };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config: IntercomConfig = { ...defaults };

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
      const brokerArgs: string[] = [];
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
