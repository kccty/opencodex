import { isCompleteCodexQuotaRecoverySnapshot } from "../codex/quota";
import { MAIN_ACCOUNT_HARD_LOCK_PERCENT, type StoredAccountQuota } from "../codex/quota-types";
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
  // The recovery predicate refuses only a >=100 reading, while admission cuts the account off
  // at 95 — earlier once per-request burn is projected. Lifting inside that band hands combos a
  // lane that cannot serve: the next send is refused locally and simply re-cools the target.
  if (insideMainAccountHardLockBand(quota)) return 0;
  return clearComboTargetCooldownsForProvider(CODEX_LANE_PROVIDER);
}

/** The same band admission refuses: the static gate, or its burn projection, on any window. */
function insideMainAccountHardLockBand(quota: StoredAccountQuota | null): boolean {
  if (!quota) return false;
  const governing = [quota.shortPercent, quota.weeklyPercent,
    ...(quota.shortPercent === undefined && quota.weeklyPercent === undefined
      ? [quota.monthlyPercent] : [])];
  if (governing.some(value => typeof value === "number" && Number.isFinite(value)
    && value >= MAIN_ACCOUNT_HARD_LOCK_PERCENT)) return true;
  return typeof quota.shortPercent === "number" && Number.isFinite(quota.shortPercent)
    && typeof quota.shortBurnPerRequestPercent === "number" && Number.isFinite(quota.shortBurnPerRequestPercent)
    && quota.shortPercent + quota.shortBurnPerRequestPercent >= 100;
}
