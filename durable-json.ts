import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { INTERCOM_RUNTIME_FILE_MODE, restrictIntercomRuntimeFile } from "./broker/paths.ts";

export interface DurableJsonFileOperations {
  writeFile(filePath: string, contents: string, options: { encoding: "utf-8"; mode: number }): void;
  open(filePath: string, flags: "r"): number;
  fsync(fileDescriptor: number): void;
  close(fileDescriptor: number): void;
  rename(from: string, to: string): void;
  restrict(filePath: string): void;
  readonly platform: NodeJS.Platform;
}

export const DURABLE_JSON_FILE_OPERATIONS: DurableJsonFileOperations = Object.freeze({
  writeFile(filePath: string, contents: string, options: { encoding: "utf-8"; mode: number }): void {
    writeFileSync(filePath, contents, options);
  },
  open(filePath: string, flags: "r"): number {
    return openSync(filePath, flags);
  },
  fsync(fileDescriptor: number): void {
    fsyncSync(fileDescriptor);
  },
  close(fileDescriptor: number): void {
    closeSync(fileDescriptor);
  },
  rename(from: string, to: string): void {
    renameSync(from, to);
  },
  restrict(filePath: string): void {
    restrictIntercomRuntimeFile(filePath);
  },
  platform: process.platform,
});

export function writeDurableJson(
  filePath: string,
  value: unknown,
  operations: DurableJsonFileOperations = DURABLE_JSON_FILE_OPERATIONS,
): void {
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
