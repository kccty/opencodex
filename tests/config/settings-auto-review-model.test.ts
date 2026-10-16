/**
 * `/api/auto-review-model` round-trip for the dashboard reviewer selector.
 *
 * The route manages the `codex-auto-review` entry in `blockedModelRedirects` on the
 * live config object the router shares, so a PUT is hot: the very next review request is
 * rerouted with no Codex restart. A null clears only that entry; other redirect keys and
 * the hand-editable root `auto_review_model` stamp in Codex's config.toml stay untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { loadExportModels } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

const baseConfig = (): OcxConfig => ({
  port: 10100,
  defaultProvider: "gateway",
  providers: {
    gateway: {
      adapter: "openai-chat",
      baseUrl: "https://gateway.test/v1",
      apiKey: "fixture",
      models: ["cheap", "strong"],
      liveModels: false,
    },
  },
});

function call(cfg: OcxConfig, body?: unknown) {
  const req = new Request("http://127.0.0.1:10100/api/auto-review-model", {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const deps: Partial<ManagementApiDeps> = {};
  return handleManagementAPI(req, new URL(req.url), cfg, deps);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-autoreview-settings-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("/api/auto-review-model", () => {
  test("the export catalog resolves the fixture provider's models", async () => {
    // Also warms the heavy dynamic-import chain behind selector resolution, so the
    // route tests below time their own logic rather than first-call module loading.
    const models = await loadExportModels(baseConfig());
    expect(models.some(model => model.namespaced === "gateway/cheap")).toBe(true);
    expect(models.some(model => model.namespaced === "gateway/nope")).toBe(false);
  }, 20_000);

  test("an unconfigured install reports no reviewer override", async () => {
    const response = await call(baseConfig());
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ autoReviewModel: null });
  });

  test("a save mutates the live config, persists it, and echoes the selector", async () => {
    const config = baseConfig();
    saveConfig(config);
    const put = await call(config, { model: "gateway/cheap" });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ ok: true, autoReviewModel: "gateway/cheap" });
    // The live object the router shares by reference: the hot half of the contract.
    expect(config.blockedModelRedirects).toEqual({ "codex-auto-review": "gateway/cheap" });
    expect(loadConfig().blockedModelRedirects).toEqual({ "codex-auto-review": "gateway/cheap" });
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(raw.blockedModelRedirects).toEqual({ "codex-auto-review": "gateway/cheap" });
    expect(await (await call(config))!.json()).toMatchObject({ autoReviewModel: "gateway/cheap" });
  }, 20_000);

  test("an unknown selector is rejected before any mutation", async () => {
    const config = baseConfig();
    saveConfig(config);
    const response = await call(config, { model: "gateway/nope" });
    expect(response!.status).toBe(400);
    expect(config.blockedModelRedirects).toBeUndefined();
  });

  test("a malformed selector is rejected", async () => {
    const config = baseConfig();
    for (const value of ["with space", "ctrl\u0001", ""]) {
      const response = await call(config, { model: value });
      expect(response!.status).toBe(400);
    }
    const wrongType = await call(config, { model: 42 });
    expect(wrongType!.status).toBe(400);
  });

  test("null clears only the reviewer entry and keeps other redirects", async () => {
    const config = baseConfig();
    config.blockedModelRedirects = { "codex-auto-review": "gateway/cheap", "gpt-5.5": "gateway/strong" };
    saveConfig(config);
    const clear = await call(config, { model: null });
    expect(clear!.status).toBe(200);
    expect(await clear!.json()).toMatchObject({ ok: true, autoReviewModel: null });
    expect(config.blockedModelRedirects).toEqual({ "gpt-5.5": "gateway/strong" });
  });

  test("clearing the last redirect removes the key from the persisted file", async () => {
    const config = baseConfig();
    config.blockedModelRedirects = { "codex-auto-review": "gateway/cheap" };
    saveConfig(config);
    const clear = await call(config, { model: null });
    expect(clear!.status).toBe(200);
    expect(config.blockedModelRedirects).toBeUndefined();
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(raw, "blockedModelRedirects")).toBe(false);
  });
});
