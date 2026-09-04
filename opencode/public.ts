// Library entry point. Keep public values out of plugin.ts: OpenCode's v1
// server-plugin loader treats every export from that configured module as a
// plugin factory.
import OpenCodeIntercomPlugin from "./plugin.ts";

export default OpenCodeIntercomPlugin;
export { OpenCodeIntercomPlugin };
export {
  createProductionOpenCodeNoticeRecipientIngress,
  DurableOpenCodeNoticeIngressStore,
  getOpenCodeNoticeIngressStatePath,
  OpenCodeNoticeAuthorityUnavailableError,
  OpenCodeNoticeCurrentClaimUnavailableError,
  OpenCodeNoticeRecipientIngress,
  OPENCODE_NOTICE_AUTHORITY_UNAVAILABLE,
  OPENCODE_NOTICE_CURRENT_CLAIM_EVIDENCE_VERSION,
  OPENCODE_NOTICE_CURRENT_CLAIM_UNAVAILABLE,
} from "./notice-ingress.ts";
