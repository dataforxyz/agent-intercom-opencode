# Changelog

## Unreleased

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
