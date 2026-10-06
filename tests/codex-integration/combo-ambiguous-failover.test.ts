import { describe, expect, test } from "bun:test";
import {
  comboConfigIssues,
  normalizeComboConfig,
} from "../../src/combos";
import {
  ambiguousFailoverHopAuthorized,
  comboFailureDecision,
} from "../../src/combos/failover";
import type { OcxProviderConfig } from "../../src/types";

const PROVIDERS: Record<string, OcxProviderConfig> = {
  a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
  b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
};

describe("combo ambiguousFailover configuration", () => {
  test("accepts a boolean and rejects any other shape", () => {
  const base = { targets: [{ provider: "a", model: "m1" }] };
    expect(comboConfigIssues("c", { ...base, ambiguousFailover: true }, PROVIDERS)).toEqual([]);
    expect(comboConfigIssues("c", { ...base, ambiguousFailover: false }, PROVIDERS)).toEqual([]);
    expect(comboConfigIssues("c", { ...base, ambiguousFailover: "yes" }, PROVIDERS))
      .toEqual([{ path: ["ambiguousFailover"], message: "ambiguousFailover must be a boolean" }]);
  });

  test("normalizes to false unless explicitly true", () => {
    const targets = [{ provider: "a", model: "m1" }];
    expect(normalizeComboConfig({ targets }).ambiguousFailover).toBe(false);
    expect(normalizeComboConfig({ targets, ambiguousFailover: true }).ambiguousFailover).toBe(true);
  });
});

describe("ambiguousFailoverHopAuthorized", () => {
  const authorize = (overrides: Partial<Parameters<typeof ambiguousFailoverHopAuthorized>[0]> = {}) => {
    let claims = 0;
    const allowed = ambiguousFailoverHopAuthorized({
      nonReplayable: true,
      spentReplacement: false,
      ambiguousFailover: true,
      selfContainedBody: true,
      claimResendGrant: () => {
        claims += 1;
        return true;
      },
      ...overrides,
      claimResendGrant: () => {
        claims += 1;
        return overrides.claimResendGrant ? overrides.claimResendGrant() : true;
      },
    });
    return { allowed, claims };
  };

  test("authorizes the hop and claims the grant exactly once on the happy path", () => {
    const { allowed, claims } = authorize();
    expect(allowed).toBe(true);
    expect(claims).toBe(1);
  });

  test("recognizes the code-only ambiguity the WS transport settles without the marker", () => {
    const { allowed } = authorize({ nonReplayable: false, upstreamCode: "upstream_closed_before_response" });
    expect(allowed).toBe(true);
  });

  test.each([
    ["replayable failure", { nonReplayable: false }],
    ["combo did not opt in", { ambiguousFailover: false }],
    ["body is not self-contained", { selfContainedBody: false }],
    ["grant already spent on a member replacement", { spentReplacement: true }],
  ])("refuses without claiming the grant: %s", (_label, overrides) => {
    const { allowed, claims } = authorize(overrides as Record<string, unknown>);
    expect(allowed).toBe(false);
    expect(claims).toBe(0);
  });

  test("refuses when the shared grant is exhausted", () => {
    const { allowed } = authorize({ claimResendGrant: () => false });
    expect(allowed).toBe(false);
  });
});

describe("ambiguousFailover leaves the default decision table untouched", () => {
  test("an ambiguous code still stops a combo that has not opted in", () => {
    expect(comboFailureDecision(502, "The connection was closed.", {
      code: "upstream_closed_before_response",
    })).toBe("stop");
    expect(comboFailureDecision(429, "Provider error 429", {
      code: "upstream_reset_replay_refused",
    })).toBe("stop");
  });
});
