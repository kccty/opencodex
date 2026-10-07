import { isCompleteCodexQuotaRecoverySnapshot } from "../codex/quota";
import type { StoredAccountQuota } from "../codex/quota-types";
import { clearComboTargetCooldownsForProvider } from "./failover";

/** The provider lane a Codex account quota observation speaks for. */
export const CODEX_LANE_PROVIDER = "openai";

/**
 * Lift the Codex lane's combo cooldowns when a fresh quota observation proves the account
 * healthy again.
 *
 * A quota-exhaustion failure records a reset-derived cooldown deadline snapshot, and that
 * snapshot never consults the quota store again: the dashboard can show a recovered account
 * while every combo keeps the lane's targets excluded until the snapshotted window expires.
 * The re-read path only refreshes percentages for accounts that are ACTIVELY SERVED, so a
 * cooled target — never attempted, never served — could not exit the state on its own. This
 * is the missing edge: a COMPLETE observation that is not exhausted is positive evidence the
 * window the cooldown was waiting for has passed, so those cooldowns lift immediately. A
 * target that fails again simply re-cools; the cost of a wrong lift is one request.
 */
export function liftCodexLaneComboCooldowns(quota: StoredAccountQuota | null): number {
  // The completeness predicate already refuses an exhausted snapshot, so a single call
  // answers both "is this a real reading" and "is the account healthy".
  if (!isCompleteCodexQuotaRecoverySnapshot(quota)) return 0;
  return clearComboTargetCooldownsForProvider(CODEX_LANE_PROVIDER);
}
