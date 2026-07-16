# Changelog

## 0.10.0 - 2026-07-16

- Add `intercom_team` for adoption-safe manager and same-manager coworker discovery.
- Expose orchestrator `versions` and source-aware `update` actions through the native OpenCode fleet bridge.

## 0.9.3 - 2026-07-15

- Expose the orchestrator's manager-scoped fleet listing and explicit `all` diagnostics option through the native OpenCode `agent_fleet` bridge.
- Coordinate the Agent Intercom family on the `0.9.3` release line.

## 0.9.2 - 2026-07-14

- Coordinate the Agent Intercom family on the `0.9.2` release line.
- Declare canonical GitHub repository metadata for npm provenance verification.

- Add CI for branches and pull requests.
- Add tag-driven npm trusted publishing with provenance and automatic GitHub Releases.

## 0.9.1 - 2026-07-14

- Publish the package under the public npm scope `@dataforxyz/agent-intercom-opencode`.
- Keep the Git repository and executable names unchanged.

## 0.9.0 - 2026-07-14

- Align the Agent Intercom family on one coordinated `0.9.0` release line.
- No behavior change from the immediately preceding AGPL release.

## 0.3.0 - 2026-07-14

- Change the current project license to `AGPL-3.0-or-later`. Previously published MIT versions remain under MIT, and original `pi-intercom` notices are preserved in `THIRD_PARTY_NOTICES.md`.
- Persist inbound messages before broker acknowledgement and replay unfinished injection after restart.
- Retain unresolved asks durably until a successful reply and keep a bounded delivered-ID ledger.
- Add OpenCode message metadata/markers plus session-history checks for crash-safe duplicate suppression.
- Queue and acknowledge inbound messages before long headless model turns, using `session.promptAsync` for both idle and busy server sessions.
- Publish atomic readiness/health metadata with Intercom state, server URL, OpenCode session ID, status, and errors.
- Support stable persistent-session resume through the orchestrator launcher.
- Add opt-in native `agent_fleet` management backed by the orchestrator package CLI; owned workers suppress recursive fleet creation by default.
- Correctly read SDK session status objects and separate Intercom IDs from OpenCode session IDs.
- Bound long-lived known-session and delivered-message sets.
- Support persistent `opencode serve` peers without broker delivery timeouts disconnecting otherwise healthy receivers.

## 0.2.0

- Upgrade the shared broker/client transport to strict intercom protocol v3.
- Add receiver acknowledgements and sender delivery IDs.
- Add durable sender outbox replay and incompatible-broker replacement.
- Add broker-confirmed ask defer/cancel behavior and late-reply support.
- Add the optional OpenCode TUI entry with Alt+I contact copying.
