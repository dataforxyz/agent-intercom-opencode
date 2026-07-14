import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invokeAgentFleet, isFleetManagementEnabled } from "./fleet.ts";

test("OpenCode fleet management is explicit and disabled inside owned workers", () => {
  assert.equal(isFleetManagementEnabled({}), false);
  assert.equal(isFleetManagementEnabled({ OPENCODE_INTERCOM_FLEET: "1" }), true);
  assert.equal(isFleetManagementEnabled({ OPENCODE_INTERCOM_FLEET: "1", AGENT_INTERCOM_OWNED: "1" }), false);
  assert.equal(isFleetManagementEnabled({ OPENCODE_INTERCOM_FLEET: "1", AGENT_INTERCOM_OWNED: "1", OPENCODE_INTERCOM_FLEET_ALLOW_NESTED: "1" }), true);
});

test("OpenCode invokes the packaged fleet command with stable manager identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-agent-fleet-"));
  try {
    const command = join(dir, "fleet.mjs");
    await writeFile(command, `#!/usr/bin/env node\nlet input="";for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);process.stdout.write(JSON.stringify({ok:true,result:{content:[{type:"text",text:request.managerSessionId+":"+request.params.action}]}}));\n`);
    await chmod(command, 0o755);
    const result = await invokeAgentFleet(
      { action: "capabilities" },
      { managerSessionId: "opencode-manager-1", cwd: dir },
      { ...process.env, AGENT_INTERCOM_FLEET_COMMAND: command },
    );
    assert.equal(result.content[0].text, "opencode-manager-1:capabilities");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
