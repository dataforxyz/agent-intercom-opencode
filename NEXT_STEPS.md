# Next Steps

Core persistent-worker and manager parity is implemented. Remaining work is release and broader compatibility validation rather than architecture discovery.

## Before release

1. Run adapter validation:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

2. Run matching orchestrator validation:

```bash
npm test
npm run typecheck
npm pack --dry-run
```

3. Verify a real persistent peer:

- spawn `opencode-peer`
- confirm spawn waits for a ready health record
- send a follow-up ask
- stop and respawn the same worker ID
- confirm the OpenCode session ID and remembered context are retained
- repeat with `fresh: true` and confirm a new session is created

4. Verify a real OpenCode manager:

```bash
OPENCODE_INTERCOM_FLEET=1 \
OPENCODE_INTERCOM_NAME=opencode-manager \
OPENCODE_INTERCOM_SESSION_ID=opencode-manager \
opencode
```

Call native `agent_fleet` to spawn a harmless worker, inspect status/logs, stop or reconcile completion, and forget it. Verify no matching systemd unit or cgroup remains.

5. Confirm model-specific variants:

```text
agent_fleet({ action: "models", harness: "opencode" })
agent_fleet({ action: "variants", model: "anthropic/claude-fable-5" })
```

Known-invalid variants must fail before systemd launch.

## Compatibility follow-ups

- Exercise interactive TUI prompt append/submit on current OpenCode releases.
- Test additional providers and reasoning variant shapes.
- Keep SDK `session.status` object handling covered as OpenCode evolves.
- Consider a native OpenCode fleet dashboard if the public TUI API gains a safe scoped-widget surface.

## Release coordination

Publish together:

- `agent-intercom-opencode` durable delivery, health, and fleet tool changes
- `agent-intercom-orchestrator` readiness, session resume, variants, and CLI changes

Do not advertise OpenCode manager parity if only one side has been released.
