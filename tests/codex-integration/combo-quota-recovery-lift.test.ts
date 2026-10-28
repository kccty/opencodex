import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboTargetCooldowns,
  clearComboTargetCooldownsForProvider,
  coolComboTarget,
  isComboTargetInCooldown,
} from "../../src/combos/failover";
import { liftCodexLaneComboCooldowns } from "../../src/combos/quota-recovery-lift";
import type { StoredAccountQuota } from "../../src/codex/quota-types";

const now = Date.UTC(2026, 9, 7, 6, 0, 0);
const quota = (overrides: Partial<StoredAccountQuota> = {}): StoredAccountQuota => ({
  updatedAt: now,
  weeklyPercent: 0,
  shortPercent: 0,
  ...overrides,
} as StoredAccountQuota);

afterEach(() => clearComboTargetCooldowns());

describe("clearComboTargetCooldownsForProvider", () => {
  test("lifts every cooldown for one provider across combos and leaves siblings alone", () => {
    coolComboTarget("a", { provider: "openai", model: "gpt-6.1-sol" }, { now, status: 429, code: "1308" });
    coolComboTarget("b", { provider: "openai", model: "gpt-6-luna" }, { now, status: 429, code: "1308" });
    coolComboTarget("a", { provider: "zhipu-bigmodel-coding", model: "glm-5.3" }, { now, status: 502 });
    const lifted = clearComboTargetCooldownsForProvider("openai");
    expect(lifted).toBe(2);
    expect(isComboTargetInCooldown("a", { provider: "openai", model: "gpt-6.1-sol" }, now)).toBe(false);
    expect(isComboTargetInCooldown("b", { provider: "openai", model: "gpt-6-luna" }, now)).toBe(false);
    expect(isComboTargetInCooldown("a", { provider: "zhipu-bigmodel-coding", model: "glm-5.3" }, now)).toBe(true);
  });
});

describe("liftCodexLaneComboCooldowns", () => {
  test("a complete healthy snapshot lifts the lane's cooldowns", () => {
    coolComboTarget("sol", { provider: "openai", model: "gpt-6.1-sol" }, { now, status: 429, code: "1308" });
    expect(liftCodexLaneComboCooldowns(quota())).toBe(1);
    expect(isComboTargetInCooldown("sol", { provider: "openai", model: "gpt-6.1-sol" }, now)).toBe(false);
  });

  test.each([
    ["null snapshot", null],
    ["windowless payload carries no reading", quota({ weeklyPercent: undefined, shortPercent: 0 })],
    ["exhausted window is not recovery", quota({ weeklyPercent: 100 })],
    ["exhausted burst window is not recovery", quota({ shortPercent: 100 })],
  ])("refuses to lift: %s", (_label, snapshot) => {
    coolComboTarget("sol", { provider: "openai", model: "gpt-6.1-sol" }, { now, status: 429, code: "1308" });
    expect(liftCodexLaneComboCooldowns(snapshot as StoredAccountQuota | null)).toBe(0);
    expect(isComboTargetInCooldown("sol", { provider: "openai", model: "gpt-6.1-sol" }, now)).toBe(true);
  });
});
