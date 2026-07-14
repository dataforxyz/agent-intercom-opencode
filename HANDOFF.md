# OpenCode Intercom Handoff

## Current state

OpenCode now supports practical Pi parity for persistent coworker and primary-manager operations.

Core files:

- `opencode/plugin.ts` — native tools, prompt injection, health, model/session events
- `opencode/runtime.ts` — broker identity, durable inbound lifecycle, asks/replies
- `opencode/inbound-store.ts` — crash-safe inbound persistence and replay
- `opencode/health.ts` — run-specific readiness and session health
- `opencode/fleet.ts` — opt-in bridge to the shared orchestrator CLI
- `opencode/tui.ts` — native TUI commands and shortcuts

## Implemented

### Durable messaging

- inbound messages are atomically persisted before broker acknowledgement
- unfinished injection replays after reconnect or restart
- unresolved asks remain durable until `intercom_reply` succeeds
- prompt submissions carry `metadata.intercomMessageId` and a textual marker
- replay checks recent session messages before submission to suppress crash-window duplicates
- delivered IDs and known session IDs are bounded
- sender outbox remains durable through the protocol-v3 broker client

### Persistent OpenCode peers

The orchestrator launcher:

- starts an authenticated private-loopback `opencode serve`
- bootstraps with `opencode run --pure --attach`
- waits for plugin, Intercom, and OpenCode session readiness
- records the active OpenCode session ID
- resumes with `opencode run --session <id>` when the worker ID is reused
- falls back to a fresh session if the saved session no longer exists
- supports explicit `fresh: true`

### OpenCode as manager

Set `OPENCODE_INTERCOM_FLEET=1` for exactly one primary OpenCode manager. The plugin registers native `agent_fleet`, which invokes the `agent-intercom-fleet` executable from `agent-intercom-orchestrator`.

This reuses the same worker store, leases, manager-session ownership, adoption, readiness, systemd cgroups, logs, stop verification, cleanup, models, and variants as Pi. Owned workers receive `AGENT_INTERCOM_OWNED=1` and suppress recursive fleet registration by default.

## Proven

- persistent headless follow-up delivery through `session.promptAsync`
- durable message and ask replay in tests
- stable OpenCode session restart with retained memory
- real Pi → OpenCode and OpenCode → Pi communication
- real OpenCode manager `agent_fleet capabilities`
- real OpenCode manager spawn → completed status → logs → cgroup verification → forget
- model-specific OpenCode variant enumeration and pre-spawn rejection

## Verification

Run:

```bash
npm install
npm test
npm run typecheck
npm run build
```

The current feature work passes 49 adapter tests. Re-run the orchestrator suite separately because readiness, resume, variants, CLI hosting, and systemd ownership live there.

## Remaining harness-level differences

These are presentation differences, not missing ownership behavior:

- Pi has a scoped footer and `/agents*` configuration menus.
- OpenCode exposes fleet lifecycle as native model-callable tools.
- OpenCode uses separate server and TUI plugin files.
- Interactive TUI prompt rendering remains dependent on OpenCode's public TUI APIs; headless persistent delivery is the strongest verified path.

## Release dependency

The OpenCode fleet tool requires a matching `agent-intercom-orchestrator` release containing `agent-intercom-fleet`. Publish the adapter and orchestrator changes together.
