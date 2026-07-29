import {
  INTERCOM_BASE_PROTOCOL_VERSION,
  evaluateBrokerCompatibility,
  parseBrokerCapabilityAdvertisement,
  type BrokerCapabilityAdvertisement,
  type BrokerCompatibilityDecision,
  type BrokerCompatibilityRequest,
} from "@dataforxyz/agent-intercom-core/boss";
import { INTERCOM_PROTOCOL_VERSION } from "./paths.ts";

if (INTERCOM_PROTOCOL_VERSION !== INTERCOM_BASE_PROTOCOL_VERSION) {
  throw new Error(
    `OpenCode protocol v${INTERCOM_PROTOCOL_VERSION} diverges from Core base protocol v${INTERCOM_BASE_PROTOCOL_VERSION}`,
  );
}

/**
 * Publishing Boss contracts is not readiness. The OpenCode provider remains
 * ordinary/base-3 only until protected identity, credentials, transitions,
 * health, and ledger predicates are implemented in lockstep.
 */
export const DORMANT_BROKER_CAPABILITIES: BrokerCapabilityAdvertisement =
  Object.freeze(parseBrokerCapabilityAdvertisement({
    baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
    features: [],
  }));

export const ORDINARY_BASE3_COMPATIBILITY: BrokerCompatibilityRequest = Object.freeze({
  clientKind: "ordinary",
  supportedBaseProtocolVersions: [INTERCOM_BASE_PROTOCOL_VERSION],
});

export function negotiateBrokerCompatibility(value: unknown): BrokerCompatibilityDecision {
  return evaluateBrokerCompatibility(value, DORMANT_BROKER_CAPABILITIES);
}
