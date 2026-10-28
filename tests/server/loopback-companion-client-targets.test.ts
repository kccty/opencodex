/**
 * What the companion loopback listener is FOR: local clients keep working on a hub (#4236).
 *
 * With `hostname: "100.76.170.81"` and `unauthenticatedLoopbackListener: { enabled: true, port:
 * 10104 }`, only the `ocx sync` writers honored the listener. Everything else — `ocx claude`,
 * Claude Desktop, Cursor, `system-env`, the vision helper — hardcodes
 * `http://127.0.0.1:<proxy port>`, a port that does not exist on a tailnet-bound hub. The
 * reported symptom was "Codex works but nothing else does".
 *
 * The port-less companion form answers that without touching any of those call sites: the
 * listener binds the proxy port on 127.0.0.1, so the URL they already write is live. These
 * tests pin the two ends of that claim — the sync-writer target and the hardcoded one must be
 * the SAME origin — because the fix is only real while those two agree.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeEnv } from "../../src/cli/claude";
import { opencodeProxyBaseUrl } from "../../src/clients/config-export";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject";
import type { OcxConfig } from "../../src/types";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const HUB_PORT = 10_100;
const TAILNET_ADDRESS = "100.76.170.81";

test.each(["0.0.0.0", "192.168.50.83", "127.0.0.1"])("single-port hub %s injects real Codex files without altering its login", hostname => {
  const root = mkdtempSync(join(tmpdir(), "ocx-single-port-inject-"));
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      const { mkdirSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { injectCodexConfig } = require("./src/codex/inject");
      mkdirSync(process.env.CODEX_HOME, { recursive: true });
      writeFileSync(join(process.env.CODEX_HOME, "config.toml"), 'model = "test"\\n');
      writeFileSync(join(process.env.CODEX_HOME, "auth.json"), '{"test":"keep-login"}');
      const config = { ...getDefaultConfig(), runtimeRole: "hub", hostname: process.env.TEST_LOCAL_HOST,
        port: 10100, unauthenticatedLoopbackListener: { enabled: false },
        hub: { managementIngress: { enabled: false } } };
      saveConfig(config);
      const result = await injectCodexConfig(10100, config);
      console.log(JSON.stringify(result));
    `], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, CODEX_HOME: join(root, "codex"), OPENCODEX_HOME: join(root, "ocx"), TEST_LOCAL_HOST: hostname },
    });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(receipt.success, receipt.message).toBe(true);
    const text = readFileSync(join(root, "codex", "config.toml"), "utf8");
    const config = Bun.TOML.parse(text);
    expect(config.openai_base_url).toBe(`http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:10100/v1`);
    expect(text).not.toContain("OPENCODEX_API_AUTH_TOKEN");
    expect(readFileSync(join(root, "codex", "auth.json"), "utf8")).toBe('{"test":"keep-login"}');
  } finally {
    removeTreeWithRetry(root);
  }
}, SPAWN_BUDGET_MS);

function hubConfig(listener: OcxConfig["unauthenticatedLoopbackListener"]): OcxConfig {
  return {
    port: HUB_PORT,
    hostname: TAILNET_ADDRESS,
    runtimeRole: "hub",
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
    ...(listener === undefined ? {} : { unauthenticatedLoopbackListener: listener }),
  } as unknown as OcxConfig;
}

/** The origin a hardcoded local integration writes, spelled the way those call sites spell it. */
function hardcodedLocalOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

describe("companion hub: sync-managed and hardcoded clients agree", () => {
  test("the Codex target is the public port on loopback, with no admission header", () => {
    const target = standaloneCodexRoutingTarget(HUB_PORT, hubConfig({ enabled: true }));
    expect(target.baseUrl).toBe(`${hardcodedLocalOrigin(HUB_PORT)}/v1`);
    // A directly spawned app-server has no OPENCODEX_API_AUTH_TOKEN to put in a header, so
    // demanding one here is the #1102 failure in a new place.
    expect(target.requiresAdmissionToken).toBe(false);
    // And the tailnet address must not leak into a base_url a local client dials.
    expect(target.baseUrl).not.toContain(TAILNET_ADDRESS);
  });

  test("buildClaudeEnv lands on that exact origin without being taught about the listener", () => {
    // `ocx claude` passes the live PUBLIC port and hardcodes 127.0.0.1. It is not changed by
    // this PR; the point is that it no longer has to be.
    const config = hubConfig({ enabled: true });
    const env = buildClaudeEnv(config, HUB_PORT, {});
    expect(env.ANTHROPIC_BASE_URL).toBe(hardcodedLocalOrigin(HUB_PORT));

    const codexOrigin = new URL(standaloneCodexRoutingTarget(HUB_PORT, config).baseUrl).origin;
    expect(env.ANTHROPIC_BASE_URL).toBe(codexOrigin);
  });

  test("the opencode/OMP exporter resolves to the same origin", () => {
    const config = hubConfig({ enabled: true });
    expect(opencodeProxyBaseUrl(HUB_PORT, config.hostname, config))
      .toBe(`${hardcodedLocalOrigin(HUB_PORT)}/v1`);
  });

  test("the ported form now agrees too: both writers land on the listener's port", () => {
    // PR2 left these two disagreeing here on purpose (the companion form was the answer, and
    // the call sites were untouched). #4236's local-client unit closed the gap: `ocx claude`
    // resolves the listener's EFFECTIVE port, so a 10104-style hub no longer sends Claude to
    // the public port while Codex goes to the listener.
    const config = hubConfig({ enabled: true, port: 10_104 });
    const codexOrigin = new URL(standaloneCodexRoutingTarget(HUB_PORT, config).baseUrl).origin;
    expect(codexOrigin).toBe(hardcodedLocalOrigin(10_104));
    expect(buildClaudeEnv(config, HUB_PORT, {}).ANTHROPIC_BASE_URL).toBe(hardcodedLocalOrigin(10_104));
    expect(buildClaudeEnv(config, HUB_PORT, {}).ANTHROPIC_BASE_URL).toBe(codexOrigin);
  });

  test("with no listener a hub keeps demanding admission on its public address", () => {
    const target = standaloneCodexRoutingTarget(HUB_PORT, hubConfig(undefined));
    expect(target.baseUrl).toBe(`http://${TAILNET_ADDRESS}:${HUB_PORT}/v1`);
    expect(target.requiresAdmissionToken).toBe(true);
  });

  test("with no listener EVERY local writer agrees on that address, Claude included", () => {
    // This is the case the first round of the local-clients fix got wrong. `ocx sync` already
    // wrote the bind address here, while the hardcoded callers wrote `127.0.0.1:10100` — a
    // closed port — so the two destination contracts disagreed on exactly the topology the
    // issue is about. They resolve through the same rule now.
    const config = { ...hubConfig(undefined), apiKeys: [
      { id: "k1", name: "local", key: "ocx_data_this_proxy_key", createdAt: "2026-01-01T00:00:00Z" },
    ] } as OcxConfig;
    const expected = `http://${TAILNET_ADDRESS}:${HUB_PORT}`;

    const codexTarget = standaloneCodexRoutingTarget(HUB_PORT, config);
    expect(new URL(codexTarget.baseUrl).origin).toBe(expected);
    expect(opencodeProxyBaseUrl(HUB_PORT, config.hostname, config)).toBe(`${expected}/v1`);

    const env = buildClaudeEnv({ ...config, claudeCode: { authMode: "proxy" } } as OcxConfig, HUB_PORT, {});
    expect(env.ANTHROPIC_BASE_URL).toBe(expected);
    // And the credential is the same DATA-plane one Codex is told to send, never the admin
    // token: `tokenEnv` on the Codex side, the configured `apiKeys` entry on this side.
    expect(codexTarget.tokenEnv).toBe("OPENCODEX_API_AUTH_TOKEN");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ocx_data_this_proxy_key");
  });
});
