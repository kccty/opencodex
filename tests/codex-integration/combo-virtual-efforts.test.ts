import { expect, test } from "bun:test";
import { concreteComboRequestBody } from "../../src/combos/request";

test("explicit caller efforts retain upstream precedence without changing the parent", () => {
  const target = { provider: "fixture", model: "fixture-model" };
  const parent = { reasoning: { effort: "ultra", summary: "none" } };
  for (const mode of ["strict", "adaptive"] as const) {
    expect(concreteComboRequestBody(parent, target, null, ["low", "high"], mode).reasoning)
      .toEqual({ effort: "ultra", summary: "none" });
    expect(concreteComboRequestBody(parent, target, null, ["low", "max"], mode).reasoning)
      .toEqual({ effort: "ultra", summary: "none" });
    expect(concreteComboRequestBody(parent, target, null, [], mode).reasoning)
      .toEqual({ summary: "none" });
    expect(concreteComboRequestBody({ reasoning: { effort: "medium" } }, target, null, ["low", "high"], mode).reasoning)
      .toEqual({ effort: "medium" });
  }
  expect(parent.reasoning).toEqual({ effort: "ultra", summary: "none" });
});
