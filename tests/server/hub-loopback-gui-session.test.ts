import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementSessionControl, initializeManagementAuthState, issueGuiSession, managementPrincipal, requireManagementAuth } from "../../src/server/management-auth";
import { markPrivateNetworkRequest, markTrustedHubManagementRequest } from "../../src/server/auth-cors";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { remoteConfig } from "../helpers/management-auth-fixture";

const environmentKeys = [
  "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_GUI_DIST",
  "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN",
] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hub-loopback-gui-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.CODEX_HOME = testHome;
  process.env.OPENCODEX_GUI_DIST = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  writeFileSync(join(testHome, "index.html"), "<!doctype html><html><head></head><body>Dashboard</body></html>");
});

afterEach(async () => {
  const root = testHome;
  testHome = "";
  await drainAndRemoveFixtureRoots({
    roots: root ? [{ path: root }] : [],
    restoreEnvironment: () => {
      for (const key of environmentKeys) {
        if (previousEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnvironment[key];
      }
    },
  });
});

describe("trusted private IPv4 dashboard sessions", () => {
  test.each(["192.168.50.83", "0.0.0.0", "::"])("LAN bind %s needs no trust switch", hostname => {
    const config = { ...remoteConfig(), hostname, port: 10100 };
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const origin = "http://192.168.50.83:10100";
    const request = (headers: Record<string, string> = {}) => {
      const req = new Request(`${origin}/`, { headers: { Host: "192.168.50.83:10100", ...headers } });
      markPrivateNetworkRequest(req, "192.168.50.169");
      return req;
    };
    const context = { trustedTailscaleIngress: false, peerAddress: "192.168.50.169" };
    expect(issueGuiSession(request(), config, state, context)?.issuance).toBe("trusted-lan");
    expect(issueGuiSession(request(), config, state)?.issuance).toBe("trusted-lan");
    expect(issueGuiSession(request({ Origin: "https://evil.example.test" }), config, state, context)).toBeNull();
    expect(issueGuiSession(request({ Host: "evil.example.test:10100" }), config, state, context)).toBeNull();
    expect(issueGuiSession(request({ Host: "192.168.50.83:10101" }), config, state, context)).toBeNull();
  });

  test("LAN management reads and writes work without credentials, including session control", () => {
    const config = { ...remoteConfig(), hostname: "0.0.0.0", port: 10100 };
    const state = initializeManagementAuthState(config);
    const control = createManagementSessionControl(state);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const req = new Request("http://192.168.50.83:10100/api/combos", {
        method, headers: { Host: "192.168.50.83:10100" },
      });
      markPrivateNetworkRequest(req, "::ffff:192.168.50.169");
      expect(requireManagementAuth(req, state, config)).toBeNull();
      expect(managementPrincipal(req, state, config)).toBe("trusted-lan");
      expect(control.isCurrent(req, config)).toBe(true);
      expect(control.canRevealDataKeys?.(req, config)).toBe(true);
    }
  });

  test("public addresses, cross-origin browsers and dedicated ingress retain authentication", () => {
    const config = { ...remoteConfig(), hostname: "0.0.0.0", port: 10100 };
    const state = initializeManagementAuthState(config);
    for (const address of ["8.8.8.8", "hub.example.test"]) {
      const req = new Request(`http://${address}:10100/api/combos`, { headers: { Host: `${address}:10100` } });
      expect(requireManagementAuth(req, state, config)?.status).toBe(401);
      expect(issueGuiSession(req, config, state)).toBeNull();
    }
    const crossOrigin = new Request("http://192.168.50.83:10100/api/combos", {
      headers: { Host: "192.168.50.83:10100", Origin: "https://other.example.test" },
    });
    expect(requireManagementAuth(crossOrigin, state, config)?.status).toBe(401);
    for (const peerAddress of [null, "8.8.8.8"]) {
      const forged = new Request("http://192.168.50.83:10100/api/combos", {
        headers: { Host: "192.168.50.83:10100", "X-Forwarded-For": "192.168.50.169" },
      });
      markPrivateNetworkRequest(forged, peerAddress);
      expect(requireManagementAuth(forged, state, config)?.status).toBe(401);
    }
    const ingress = new Request("http://127.0.0.1:10101/api/combos", { headers: { Host: "127.0.0.1:10101" } });
    markTrustedHubManagementRequest(ingress);
    expect(requireManagementAuth(ingress, state, config)?.status).toBe(401);
  });

  test("one real wildcard listener serves Web, management and inference metadata on the same port", async () => {
    const config = { ...remoteConfig(), hostname: "0.0.0.0", runtimeRole: "hub" as const };
    saveConfig(config);
    const server = startServer(0);
    try {
      const port = server.port!;
      const target = `http://127.0.0.1:${port}`;
      const headers = { Host: `192.168.50.83:${port}` };
      for (let reload = 0; reload < 2; reload++) {
        const page = await fetch(target + "/", { headers });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('name="opencodex-session-token"');
      }
      for (const path of ["/api/combos", "/v1/models", "/healthz"]) {
        const response = await fetch(target + path, { headers });
        expect(response.status).toBe(200);
        await response.text();
      }
      const localPage = await fetch(target + "/");
      expect(await localPage.text()).toContain('name="opencodex-session-token"');
      const localApi = await fetch(target + "/api/combos");
      expect(localApi.status).toBe(200);
      await localApi.text();
    } finally {
      await server.stop(true);
    }
  });

  test("dedicated management ingress does not independently bypass authentication", () => {
    const config = { ...remoteConfig(), runtimeRole: "hub" as const,
      hub: { managementIngress: { enabled: true, port: 10101 } } };
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const request = new Request("http://127.0.0.1:10101/opencodex-session", {
      headers: { Host: "127.0.0.1:10101" },
    });
    expect(issueGuiSession(request, config, state, { trustedTailscaleIngress: true })).toBeNull();
    expect(state.sessions.size).toBe(0);
  });
});
