import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, type StoredAccountQuota } from "../../src/codex/quota";
import { clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos/failover";
import { liftCodexLaneComboCooldowns } from "../../src/combos/quota-recovery-lift";
import { CodexMainAccountHardLockError, cooldownErrorResponse } from "../../src/codex/auth-context";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const now = Date.UTC(2026, 9, 7, 12, 0, 0);
const enabled = { codexMainAccountHardLock: true };
const windowSeconds = 18_000;
const resetAt = now + 3_600_000;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-hard-lock-burn-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity("policy-account-burn");
});

afterEach(() => {
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearComboTargetCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function observe(quota: Omit<StoredAccountQuota, "updatedAt">): void {
  const writer = captureMainQuotaWriter("policy-account-burn");
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed("__main__", quota, undefined, writer);
}

describe("main-account hard-lock burn projection", () => {
  test("a single large observation jump blocks below the static 95 gate", () => {
    observe({ shortPercent: 60, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
    observe({ shortPercent: 90, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    expect(getAccountQuota("__main__")?.shortBurnPerRequestPercent).toBe(25);
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
  });

  test("the estimate decays as small steps replace the spike", () => {
    observe({ shortPercent: 60, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    observe({ shortPercent: 90, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    observe({ shortPercent: 91, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    expect(getAccountQuota("__main__")?.shortBurnPerRequestPercent).toBe(15);
    observe({ shortPercent: 93, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    expect(getAccountQuota("__main__")?.shortBurnPerRequestPercent).toBe(10);
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
    observe({ shortPercent: 94, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    observe({ shortPercent: 94.5, shortResetAt: resetAt, shortWindowSeconds: windowSeconds });
    expect(getAccountQuota("__main__")?.shortBurnPerRequestPercent).toBe(4);
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
  });

  test("a window reset keeps the learned burn for the next window", () => {
    observe({ shortPercent: 60, shortResetAt: now - 1, shortWindowSeconds: windowSeconds });
    observe({ shortPercent: 90, shortResetAt: now - 1, shortWindowSeconds: windowSeconds });
    observe({ shortPercent: 0, shortResetAt: now + 17_999_000, shortWindowSeconds: windowSeconds });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
    expect(getAccountQuota("__main__")?.shortBurnPerRequestPercent).toBe(25);
    observe({ shortPercent: 89, shortResetAt: now + 17_999_000, shortWindowSeconds: windowSeconds });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
  });
});

describe("quota recovery lift respects the hard-lock band", () => {
  test.each([
    ["exhausted stays refused", { weeklyPercent: 16, shortPercent: 100 }, 0],
    ["inside the 95 band", { weeklyPercent: 16, shortPercent: 96 }, 0],
    ["projected over the line", { weeklyPercent: 16, shortPercent: 92, shortBurnPerRequestPercent: 9 }, 0],
    ["healthy below the band lifts", { weeklyPercent: 16, shortPercent: 92, shortBurnPerRequestPercent: 4 }, 1],
  ])("%s", (_label, overrides, expected) => {
    coolComboTarget("sol", { provider: "openai", model: "gpt-6.1-sol" }, { now, status: 429, code: "1308" });
    const snapshot = { updatedAt: now, ...overrides } as StoredAccountQuota;
    const lifted = liftCodexLaneComboCooldowns(snapshot);
    expect(lifted).toBe(expected);
    expect(isComboTargetInCooldown("sol", { provider: "openai", model: "gpt-6.1-sol" }, now))
      .toBe(expected === 0);
  });
});

describe("hard-lock Retry-After ceiling", () => {
  test("a window reset hours away advertises at most fifteen minutes", () => {
    const res = cooldownErrorResponse(new CodexMainAccountHardLockError(now + 3 * 3_600_000), now);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });
});
