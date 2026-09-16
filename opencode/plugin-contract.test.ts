import assert from "node:assert/strict";
import test from "node:test";

test("configured server-plugin bundle exposes only its default factory", async () => {
  const plugin = await import(new URL("../dist/plugin.mjs", import.meta.url).href);
  assert.deepEqual(Object.keys(plugin), ["default"]);
  assert.equal(typeof plugin.default, "function");
});

test("OpenCode v2 bundle exposes a native setup plugin", async () => {
  const plugin = await import(new URL("../dist/plugin-v2.mjs", import.meta.url).href);
  assert.deepEqual(Object.keys(plugin), ["default"]);
  assert.equal(plugin.default.id, "agent-intercom");
  assert.equal(typeof plugin.default.setup, "function");
});

test("package library bundle retains the public adapter contract", async () => {
  const library = await import(new URL("../dist/index.mjs", import.meta.url).href);
  assert.deepEqual(Object.keys(library).sort(), [
    "DurableOpenCodeNoticeIngressStore",
    "OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE",
    "OPENCODE_NOTICE_CURRENT_CLAIM_EVIDENCE_VERSION",
    "OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE",
    "OpenCodeIntercomPlugin",
    "OpenCodeNoticeAuthorityUnavailableError",
    "OpenCodeNoticeCurrentClaimUnavailableError",
    "OpenCodeNoticeRecipientIngress",
    "createProductionOpenCodeNoticeRecipientIngress",
    "default",
    "getOpenCodeNoticeIngressStatePath",
  ]);
  assert.equal(typeof library.default, "function");
  assert.equal(typeof library.OpenCodeIntercomPlugin, "function");
  assert.equal(typeof library.createProductionOpenCodeNoticeRecipientIngress, "function");
});
