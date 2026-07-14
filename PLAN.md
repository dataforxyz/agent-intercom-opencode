# OpenCode Intercom Architecture

## Goal

Provide OpenCode with the same durable Agent Intercom messaging and owned fleet lifecycle used by Pi, while using OpenCode's public plugin, session, and TUI APIs rather than patching the host.

## Architecture

### Shared broker protocol

The adapter uses the protocol-v3 broker shared by Pi, Codex, and Claude:

- local Unix socket or opt-in Windows loopback transport
- receiver acknowledgements and delivery IDs
- durable sender outbox
- ask defer/cancel semantics
- incompatible broker detection and replacement

### OpenCode server plugin

The server plugin owns one Intercom identity and provides:

- `intercom_whoami`, `status`, `list`, `send`, `ask`, `pending`, and `reply`
- durable inbound persistence before acknowledgement
- prompt injection with `session.promptAsync`
- session-history duplicate suppression
- readiness and active-session health records
- optional `agent_fleet` for an explicitly configured primary manager

### TUI plugin

The TUI plugin remains a separate OpenCode entry and communicates with the server plugin through the private local control bridge. It provides `/intercom`, `/intercom-id`, Alt+M, and Alt+I without registering a second broker identity.

### Persistent worker ownership

`agent-intercom-orchestrator` starts a private authenticated OpenCode server in an exact systemd user-service cgroup. A bootstrap run creates or resumes the OpenCode session. The plugin publishes health, and spawn succeeds only after the expected run ID is connected and has an active session.

The worker ID maps to durable session state. Reuse resumes; `fresh: true` resets intentionally.

### Manager parity

The orchestrator package ships `agent-intercom-fleet`. This executable hosts the exact same extension tool in a minimal headless context. OpenCode's opt-in native `agent_fleet` tool invokes it with a stable manager-session ID.

No systemd/store logic is copied into the OpenCode adapter. Pi and OpenCode therefore share:

- profiles and role presets
- worker records and cross-process locks
- leases and heartbeat ownership
- adoption
- readiness/session metadata
- model and OpenCode variant enumeration
- systemd cgroups and descendant verification
- logs, stop, cleanup, and forget

## Safety boundaries

- Fleet management is off by default in OpenCode.
- Owned workers suppress recursive fleet registration through `AGENT_INTERCOM_OWNED=1`.
- Detached services, containers, and remote resources require explicit manager ownership.
- Stop operations target exact orchestrator-owned units; broad process-name kills are forbidden.
- Server authentication uses a random per-run loopback password.

## Practical parity definition

Parity means equivalent durable messaging, session continuity, lifecycle ownership, and manager tool operations. It does not mean identical host presentation:

- Pi has native `/agents*` menus and a scoped footer.
- OpenCode has native model-callable tools and separate server/TUI plugins.

Both paths use one lifecycle backend and are expected to produce the same ownership and cleanup results.
