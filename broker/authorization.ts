import {
  authorizeFeatureAware,
  type BossAuthorizationContext,
  type BossPolicyAction,
  type FeatureAwareAuthorizationDecision,
  type FeatureAwarePolicyState,
} from "@dataforxyz/agent-intercom-core/boss";
import type { PolicyAction, PolicyPrincipal, PolicyState } from "@dataforxyz/agent-intercom-core/policy";
import { validatedBossMetadata } from "./boss.ts";
import type { SessionInfo } from "../types.ts";

export function policyPrincipalForSession(session: SessionInfo): PolicyPrincipal {
  if (session.origin === "remote") {
    if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
      throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
    }
    return {
      id: session.id,
      kind: "remote",
      state: "active",
      generation: session.generation,
      policy: "remote-tree",
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId,
    };
  }
  return {
    id: session.id,
    kind: "local",
    state: "active",
    generation: 1,
    policy: "local-public",
    rootSessionId: session.id,
  };
}

export function policyStateForSessions(sessions: Iterable<SessionInfo>): PolicyState {
  const principals: Record<string, PolicyPrincipal> = {};
  for (const session of sessions) {
    if (session.boss === undefined) principals[session.id] = policyPrincipalForSession(session);
  }
  return { principals };
}

export function featurePolicyStateForSessions(sessions: Iterable<SessionInfo>): FeatureAwarePolicyState {
  const values = Array.from(sessions);
  const legacy = policyStateForSessions(values);
  const registrations: FeatureAwarePolicyState["registrations"] = {};
  const boss: FeatureAwarePolicyState["boss"] = { principals: {} };

  for (const session of values) {
    let metadata;
    try {
      metadata = validatedBossMetadata(session);
    } catch {
      // Boss-marked metadata is broker-owned. Corruption must stay in the
      // Boss namespace and fail closed rather than downgrade to ordinary.
      registrations[session.id] = {} as FeatureAwarePolicyState["registrations"][string];
      continue;
    }
    if (metadata) {
      registrations[session.id] = metadata.registration;
      boss.principals[session.id] = metadata.principal;
    } else {
      registrations[session.id] = {
        principalId: session.id,
        principalClass: "ordinary",
        state: "active",
      };
    }
  }
  return { legacy, boss, registrations };
}

export function authorizeSessionAction(
  sessions: Iterable<SessionInfo>,
  actorId: string,
  action: PolicyAction | BossPolicyAction,
  targetId: string,
  bossContext?: BossAuthorizationContext,
): FeatureAwareAuthorizationDecision {
  const state = featurePolicyStateForSessions(sessions);
  const actorRegistration = state.registrations[actorId];
  const targetRegistration = state.registrations[targetId];
  const request = {
    actorId,
    action,
    targetId,
    ...(actorRegistration?.principalClass === "boss-bound" || targetRegistration?.principalClass === "boss-bound"
      ? { bossContext }
      : {
          legacyContext: {
            actorGeneration: state.legacy.principals[actorId]?.generation,
            targetGeneration: state.legacy.principals[targetId]?.generation,
          },
        }),
  };
  return authorizeFeatureAware(state, request);
}

export function visibleSessions(sessions: Iterable<SessionInfo>, actorId: string): SessionInfo[] {
  const values = Array.from(sessions);
  return values.filter((target) => authorizeSessionAction(values, actorId, "discover", target.id).allowed);
}
