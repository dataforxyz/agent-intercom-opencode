# OpenCode Intercom

**Agent Intercom** is a cross-harness, same-machine messaging system for coding agents. Its Pi, Codex, Claude Code, and OpenCode adapters share one local broker and protocol, so sessions can discover and message each other regardless of which harness they run in.

| Harness | Repository |
|---|---|
| Pi | [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi) |
| Codex | [`agent-intercom-codex`](https://github.com/dataforxyz/agent-intercom-codex) |
| Claude Code | [`agent-intercom-claude`](https://github.com/dataforxyz/agent-intercom-claude) |
| OpenCode | [`agent-intercom-opencode`](https://github.com/dataforxyz/agent-intercom-opencode) |

## Origin and thanks

Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). A sincere thank you to Nico and the original contributors for creating the Pi extension and the foundation this cross-harness family builds on.

This repository contains the OpenCode adapter. It gives OpenCode native intercom tools, durable wakeable sessions, and an optional `agent_fleet` manager tool backed by [`agent-intercom-orchestrator`](https://github.com/dataforxyz/agent-intercom-orchestrator). OpenCode can now participate as either a persistent coworker or an explicitly configured primary manager.

## What It Does

- registers the current OpenCode session with the shared local broker
- lists Pi, Codex, Claude, and OpenCode peers
- sends and receives inter-agent messages
- supports blocking ask/reply flows
- injects inbound messages back into OpenCode so the receiving session can wake up and continue from the message
- persists inbound messages before broker acknowledgement and replays unfinished injection after restart
- publishes run-specific readiness, health, and active OpenCode session metadata
- resumes a stable OpenCode session after an orchestrator-owned worker restart
- optionally exposes the same systemd-owned `agent_fleet` lifecycle tool used by Pi

## Status

Protocol-v3 compatible with the matching Pi, Codex, and Claude Code adapters.

Proven working:

- OpenCode plugin loads in real `opencode run`
- startup registration works without needing an intercom tool call first
- fresh Pi and Codex peers can be reached from OpenCode
- fresh OpenCode receivers can be reached from Pi
- busy headless `opencode run` receivers can wake after their current turn
  finishes
- verified exactly-once inbound delivery in headless run mode
- verified crash-safe durable inbound replay and unresolved-ask retention
- verified persistent worker restart with the same OpenCode session ID and retained memory
- verified OpenCode-manager spawn, status, logs, cgroup cleanup, and forget through native `agent_fleet`
- headless server receivers persist and acknowledge queued messages, then inject asynchronously so long model turns do not make the broker evict a healthy peer
- sends survive reconnects in a durable sender outbox and replay with the same ID
- incompatible older brokers are detected and replaced safely
- ask defer/cancel controls are broker-acknowledged, and timed-out asks remain late-replyable

## Practical Pi parity

OpenCode now has operational parity for the behaviors that matter to a persistent manager or coworker:

- durable inbound delivery and ask recovery
- explicit Intercom/session readiness before an owned spawn succeeds
- stable session ID capture and restart/resume
- model-specific variant discovery and validation through the orchestrator
- the same `agent_fleet` actions, store, leases, adoption, systemd cgroups, logs, and cleanup used by Pi
- recursive fleet creation disabled in ordinary owned workers

The harnesses still present differently. Pi has native extension commands, a scoped footer, and `/agents` menus; OpenCode exposes equivalent lifecycle operations as model-callable tools and uses separate server/TUI plugins. This is a UI/API difference, not a separate ownership implementation.

## Install From GitHub

```bash
git clone https://github.com/dataforxyz/agent-intercom-opencode.git
cd agent-intercom-opencode
npm install
npm run build
```

Add the server plugin to your normal OpenCode config (usually
`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/path/to/agent-intercom-opencode/dist/plugin.mjs"
  ]
}
```

To add the native intercom picker and copy command, put the separate TUI plugin in
`~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/path/to/agent-intercom-opencode/dist/tui.mjs"
  ]
}
```

OpenCode keeps server and TUI plugins in separate configuration files. Do not
put `dist/tui.mjs` in `opencode.json`: the server plugin loader will reject it.
Restart OpenCode after changing either config.

The TUI plugin talks to the already-connected server plugin through a private
local control bridge. It does not open another broker connection or register a
second intercom identity. Both plugin entries are therefore required for the
native commands.

No wrapper alias is required for OpenCode as a worker: once both config files are present, plain `opencode` has the shortcuts and slash commands. This differs from hosts whose terminal wrappers are responsible for their keybindings.

### Use Pi as the fleet manager

Install both Pi packages, then restart Pi or run `/reload`:

```bash
pi install git:github.com/dataforxyz/agent-intercom-pi
pi install git:github.com/dataforxyz/agent-intercom-orchestrator
```

Inside Pi, run `agent_fleet({ action: "doctor" })` to confirm this OpenCode plugin is visible in OpenCode's resolved configuration. The orchestrator Pi package provides the `agent_fleet` tool, `/agents*` commands, scoped footer, and bundled manager Agent Skill.

### Enable OpenCode as the primary fleet manager

Install or link the orchestrator package so its `agent-intercom-fleet` executable is available:

```bash
cd /path/to/agent-intercom-orchestrator
npm install
npm link
```

Then start the one OpenCode session that should own persistent coworker creation:

```bash
OPENCODE_INTERCOM_FLEET=1 \
OPENCODE_INTERCOM_NAME=opencode-manager \
OPENCODE_INTERCOM_SESSION_ID=opencode-manager \
opencode
```

For a checkout without an npm link, point directly at the packaged CLI:

```bash
AGENT_INTERCOM_FLEET_COMMAND=/path/to/agent-intercom-orchestrator/src/agent-fleet-cli.mjs
```

Fleet management is opt-in. Orchestrator-owned OpenCode workers receive `AGENT_INTERCOM_OWNED=1`, which suppresses recursive `agent_fleet` registration even if the manager environment is inherited. Do not enable `OPENCODE_INTERCOM_FLEET_ALLOW_NESTED=1` unless recursive ownership is deliberately required.

## TUI Commands

| Action | Slash command | Shortcut |
|---|---|---|
| Choose a connected agent, compose, and send a message | `/intercom` | **Alt+M** |
| Copy this session's exact intercom target | `/intercom-id` | **Alt+I** |

`/intercom-contact` remains an alias for `/intercom-id`. The copy command uses
the identity owned by the server plugin, so it remains correct even when the
TUI and OpenCode server run in different processes. If no system clipboard
helper is installed, the target is displayed in a toast instead. Linux support
uses `wl-copy`, `xclip`, or `xsel`; macOS uses `pbcopy`, and Windows uses
`clip.exe`.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model
- `intercom_status`: show connection status and pending message counts
- `intercom_list`: list local Pi, Codex, Claude, and OpenCode sessions
- `intercom_set_summary`: publish a short discoverable status
- `intercom_send`: send a non-blocking message
- `intercom_ask`: send a question and wait briefly for the target's reply
- `intercom_pending`: read queued inbound messages and unresolved asks
- `intercom_reply`: reply to a pending inbound ask
- `agent_fleet` *(opt-in manager only)*: create, inspect, adopt, renew, stop, and clean up owned Pi, Codex, Claude, and OpenCode coworkers using the same store and systemd lifecycle implementation as Pi

## Inbound Delivery Model

Inbound messages always reach the runtime queue. From there, the plugin tries to
deliver them into the active OpenCode session.

Current delivery strategy:

1. atomically persist the inbound message before acknowledging it to the broker
2. restore pending injection and unresolved asks from disk after restart
3. show a toast
4. if OpenCode is running with a real TUI, try prompt append + submit
5. in headless run/server mode, use `session.promptAsync` so broker delivery does not wait for the model turn
6. attach `metadata.intercomMessageId` and a prompt marker to submitted turns
7. before replay, inspect recent session messages for that ID so a crash after accepted submission does not duplicate the turn
8. retain asks durably until `intercom_reply` succeeds
9. cap the durable delivered-ID ledger and in-memory session sets

Protocol delivery has two states: `accepted` means the broker assigned a delivery ID; `delivered` means this receiver durably stored the message and acknowledged it.
Model completion and an ask reply are separate later events. This distinction is
necessary for persistent headless servers because a model turn can outlive the
broker's receiver-ack deadline.
The sender outbox is stored below the shared intercom runtime directory and is
replayed automatically after reconnect.

That means busy `opencode run` sessions can now receive a real follow-up turn
after their original tool call completes.

## Quick Verification

Start a long-lived receiver:

```bash
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","plugin":["/path/to/agent-intercom-opencode/dist/plugin.mjs"],"permission":{"bash":"allow"}}' \
OPENCODE_INTERCOM_NAME=opencode-live-test \
OPENCODE_INTERCOM_SESSION_ID=opencode-live-test \
opencode run --auto --format json "Run bash command sleep 60. Then output done. Do not call any intercom tools."
```

Confirm it registered from Pi:

```bash
PI_INTERCOM_SESSION_ID=pi-list-test \
pi --no-extensions --extension /path/to/agent-intercom-pi/index.ts --no-skills --mode json --print "Use the intercom tool with action list once. Output only the tool result."
```

Send a message from Pi while the receiver is still in `sleep`:

```bash
PI_INTERCOM_SESSION_ID=pi-send-test \
pi --no-extensions --extension /path/to/agent-intercom-pi/index.ts --no-skills --mode json --print "Use the intercom tool with action send to send this exact message to opencode-live-test: hello from pi live test. Output only the tool result."
```

Then inspect the receiver session:

```bash
opencode export <session-id>
```

Expected result:

- the original `sleep` turn finishes
- a new user turn appears with the inbound intercom text
- the inbound prompt appears exactly once

## Debugging

Enable inject-path logging with:

```bash
OPENCODE_INTERCOM_DEBUG=1
```

When enabled, the plugin writes structured injection logs to:

```bash
/tmp/intercom-inject.log
```

Useful things to inspect there:

- whether the receiver was busy
- whether TUI injection was skipped because the run was headless
- whether `session.promptAsync` returned `204`
- whether delivery was recorded exactly once

## Environment

| Variable | Purpose |
|----------|---------|
| `OPENCODE_INTERCOM_NAME` | Discoverable session name |
| `OPENCODE_INTERCOM_SESSION_ID` | Stable intercom id |
| `OPENCODE_INTERCOM_MODEL` | Model label shown to peers |
| `OPENCODE_INTERCOM_DEBUG` | Enable `/tmp/intercom-inject.log` diagnostics when set to `1` |
| `OPENCODE_INTERCOM_FLEET` | Register the native `agent_fleet` manager tool when set to `1` |
| `AGENT_INTERCOM_FLEET_COMMAND` | Override the `agent-intercom-fleet` executable path |
| `AGENT_INTERCOM_FLEET_TIMEOUT_MS` | Fleet CLI timeout; default 120000 |
| `OPENCODE_INTERCOM_FLEET_ALLOW_NESTED` | Explicitly permit fleet management inside an owned worker; unsafe by default |
| `OPENCODE_INTERCOM_TARGET_SESSION` | Internal persistent-peer target session used during resume |
| `OPENCODE_INTERCOM_INBOUND_STATE` | Override durable inbound state path |
| `AGENT_INTERCOM_OPENCODE_HEALTH_PATH` | Orchestrator-provided readiness/health file |
| `AGENT_INTERCOM_OPENCODE_STATE_PATH` | Orchestrator-provided persistent OpenCode session state file |
| `PI_INTERCOM_ASK_TIMEOUT_MS` | Shared default blocking-ask timeout, max 120000 |
| `PI_CODING_AGENT_DIR` | Shared broker socket/config base, default `~/.pi/agent` |

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

See also:

- `HANDOFF.md`
- `NEXT_STEPS.md`
- `PLAN.md`
