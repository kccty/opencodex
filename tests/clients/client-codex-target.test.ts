/**
 * The default Codex routing target follows the machine's role.
 *
 * `ocx restore back` and the local `ocx sync` path reach `injectCodexConfig` without an explicit
 * target. On a hub client that default was the standalone loopback form, so config.toml got
 * `http://127.0.0.1:<port>/v1` — an address this machine's Codex cannot reach, which is how old
 * conversations quietly landed on the official ChatGPT endpoint instead of the hub. These cases
 * pin the three resolutions and one real injector run, because the resolver alone passing would
 * not prove the bytes on disk.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexRoutingTarget } from "../../src/client/codex-target";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = resolveRepoRoot();
const previousHome = process.env.OPENCODEX_HOME;
let root = "";

setDefaultTimeout(SPAWN_BUDGET_MS);

function clientConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverUrl: "http://192.168.50.83:10100",
    managementUrl: "http://192.168.50.83:10100",
    managementTransport: "direct",
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "client-key-1",
    tokenFingerprint: "a".repeat(64),
    protocolVersion: 1,
    connectedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function writeClientConfig(home: string, client?: Record<string, unknown>): string {
  const configDir = join(home, ".opencodex");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 10100,
    hostname: "127.0.0.1",
    providers: {},
    ...(client ? { runtimeRole: "client", client } : {}),
  }));
  process.env.OPENCODEX_HOME = configDir;
  return configDir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-client-codex-target-"));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

describe("defaultCodexRoutingTarget", () => {
  test("a machine with no client connection keeps the standalone loopback target", () => {
    writeClientConfig(root);
    const target = defaultCodexRoutingTarget(10100, { port: 10100 } as OcxConfig);
    expect(target.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(target.link).toBeUndefined();
  });

  test("a connected hub client targets the hub origin, never its own loopback port", () => {
    writeClientConfig(root, clientConnection());
    const target = defaultCodexRoutingTarget(10100, { port: 10100 } as OcxConfig);
    expect(target.baseUrl).toBe("http://192.168.50.83:10100/v1");
    expect(target.requiresAdmissionToken).toBe(true);
    expect(target.tokenEnv).toBe("OPENCODEX_API_AUTH_TOKEN");
    expect(target.link).toBeUndefined();
  });

  test("an operation in flight on the connection is not trusted as a target", () => {
    writeClientConfig(root, clientConnection({
      pendingOperation: {
        kind: "rotate",
        rotationId: "rotation-1",
        newKeyIssuedAt: "2026-10-28T01:00:00.000Z",
        oldKeyBackupPath: join(root, ".opencodex", "service-api-token.prev"),
      },
    }));
    const target = defaultCodexRoutingTarget(10100, { port: 10100 } as OcxConfig);
    expect(target.baseUrl).toBe("http://127.0.0.1:10100/v1");
  });

  test("a link child keeps its own loopback listener, which relays the key itself", () => {
    writeClientConfig(root, clientConnection({
      transport: "link",
      serverUrl: "http://127.0.0.1:41000",
      managementUrl: "http://127.0.0.1:41000",
      link: { tunnelPort: 41000, linkId: "lnk_0123456789abcdef" },
    }));
    const target = defaultCodexRoutingTarget(10100, { port: 10100 } as OcxConfig);
    expect(target.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(target.link).toBe(true);
  });
});

test("the injector writes the hub origin when the caller supplies no target", () => {
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const configDir = join(home, ".opencodex");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 10100,
    hostname: "127.0.0.1",
    providers: {},
    runtimeRole: "client",
    client: clientConnection(),
  }));
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, {}).then(result => {
      console.log(JSON.stringify({ success: result.success, message: result.message }));
    });
  `;
  const spawned = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      CODEX_SQLITE_HOME: "",
      OPENCODEX_HOME: configDir,
    },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  const lines = (spawned.stdout ?? "").trim().split("\n");
  const result = JSON.parse(lines[lines.length - 1] ?? "{}") as { success?: boolean; message?: string };
  expect(result.success, `${result.message}\n${spawned.stderr ?? ""}`).toBe(true);
  const written = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(written).toContain("http://192.168.50.83:10100/v1");
  expect(written).not.toContain("127.0.0.1");
});
