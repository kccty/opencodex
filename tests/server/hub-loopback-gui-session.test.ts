import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { initializeManagementAuthState, issueGuiSession } from "../../src/server/management-auth";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { remoteConfig, startEphemeralHubServer } from "../helpers/management-auth-fixture";

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

async function startHub(managementPublicOrigin?: string) {
  const config = {
    ...remoteConfig(),
    runtimeRole: "hub" as const,
    // Local dashboard entry must not depend on a remote management public origin.
    hub: {
      managementIngress: { enabled: true, port: 10101 },
      ...(managementPublicOrigin === undefined ? {} : { managementPublicOrigin }),
    },
    remoteGui: { allowedTailscaleUsers: ["alice@example.test"] },
  };
  saveConfig(config);
  const state = initializeManagementAuthState(config);
  if (!state.available) throw new Error("expected management auth state");
  const { server, managementPort } = await startEphemeralHubServer({ managementAuthState: state });
  return { server, state, base: `http://127.0.0.1:${managementPort}` };
}

function bootstrapToken(html: string): string {
  const token = /name="opencodex-session-token" content="([^"]+)"/.exec(html)?.[1];
  // Keep credentials out of assertion output, including the failure path.
  if (!token) throw new Error("expected GUI session bootstrap token");
  return token;
}

describe("hub loopback dashboard with a public inference bind", () => {
  test("explicit LAN trust issues sessions only to private peers on the exact origin", () => {
    const config = { ...remoteConfig(), hostname: "192.168.50.83", port: 10100, trustedLanDashboard: true };
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const origin = "http://192.168.50.83:10100";
    const request = (headers: Record<string, string> = {}) => new Request(`${origin}/`, {
      headers: { Host: "192.168.50.83:10100", ...headers },
    });
    const context = { trustedTailscaleIngress: false, peerAddress: "192.168.50.169" };
    expect(issueGuiSession(request(), config, state, context)?.issuance).toBe("trusted-lan");
    expect(issueGuiSession(request(), { ...config, trustedLanDashboard: false }, state, context)).toBeNull();
    expect(issueGuiSession(request(), { ...config, trustedLanDashboard: "true" as never }, state, context)).toBeNull();
    expect(issueGuiSession(request({ Origin: "https://evil.example.test" }), config, state, context)).toBeNull();
    expect(issueGuiSession(request({ Host: "evil.example.test:10100" }), config, state, context)).toBeNull();
    expect(issueGuiSession(request({ Host: "192.168.50.83:10101" }), config, state, context)).toBeNull();
    for (const peerAddress of [null, "8.8.8.8", "192.168.50.999"]) {
      expect(issueGuiSession(request({ "X-Forwarded-For": "192.168.50.169" }), config, state,
        { ...context, peerAddress })).toBeNull();
    }
  });

  test("the dedicated management listener issues a usable loopback session", async () => {
    const { server, state, base } = await startHub();
    try {
      const bootstrap = await fetch(`${base}/opencodex-session`);
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get("cache-control")).toBe("no-store");
      const token = bootstrapToken(await bootstrap.text());
      expect(state.sessions.get(token)?.issuance).toBe("loopback");
      expect(state.sessions.get(token)?.serverOrigin).toBe(base);
      expect(state.sessions.get(token)?.browserOrigin).toBe(base);
      const headers = { Origin: base, "x-opencodex-api-key": token, "x-opencodex-gui-origin": base };
      expect((await fetch(`${base}/api/combos`, { headers })).status).toBe(200);
      expect((await fetch(`${base}/api/combos`)).status).toBe(401);
      expect((await fetch(`${base}/api/combos`, {
        headers: { ...headers, "x-opencodex-gui-origin": "http://localhost" },
      })).status).toBe(401);
      expect((await fetch(`${base}/api/combos`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
      })).status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("the local dashboard page injects its loopback session", async () => {
    const { server, state, base } = await startHub();
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const token = bootstrapToken(await page.text());
      expect(state.sessions.get(token)?.issuance).toBe("loopback");
      expect(state.sessions.get(token)?.serverOrigin).toBe(base);
    } finally {
      await server.stop(true);
    }
  });

  test("a foreign browser origin cannot obtain or use a local session", async () => {
    const { server, state, base } = await startHub();
    const foreignOrigin = "https://evil.example.test";
    try {
      const refused = await fetch(`${base}/opencodex-session`, { headers: { Origin: foreignOrigin } });
      expect(refused.status).toBe(401);
      const page = await fetch(`${base}/`, { headers: { Origin: foreignOrigin } });
      expect((await page.text()).includes('name="opencodex-session-token"')).toBe(false);
      expect(state.sessions.size).toBe(0);
      const local = await fetch(`${base}/opencodex-session`);
      expect(local.status).toBe(200);
      const token = bootstrapToken(await local.text());
      expect((await fetch(`${base}/api/combos`, {
        headers: { Origin: foreignOrigin, "x-opencodex-api-key": token, "x-opencodex-gui-origin": base },
      })).status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("the public listener cannot claim management ingress with Host or proxy identity headers", async () => {
    const { server, state, base } = await startHub();
    try {
      const publicBase = `http://127.0.0.1:${server.port}`;
      for (const headers of [
        { Host: new URL(base).host },
        {
          Host: new URL(base).host,
          Origin: base,
          Forwarded: `for=127.0.0.1;host="${new URL(base).host}";proto=https`,
          "X-Forwarded-For": "127.0.0.1",
          "X-Forwarded-Host": new URL(base).host,
          "X-Forwarded-Proto": "https",
          "Tailscale-User-Login": "alice@example.test",
        },
      ]) {
        expect((await fetch(`${publicBase}/opencodex-session`, { headers })).status).toBe(401);
        const page = await fetch(`${publicBase}/`, { headers });
        expect((await page.text()).includes('name="opencodex-session-token"')).toBe(false);
        expect((await fetch(`${publicBase}/api/combos`, { headers })).status).toBe(401);
      }
      expect(state.sessions.size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("an explicit matching local management origin permits local bootstrap", async () => {
    const origin = "http://127.0.0.1:10101";
    const { server, state, base } = await startHub(origin);
    const headers = { Host: new URL(origin).host, Origin: origin };
    try {
      const bootstrap = await fetch(`${base}/opencodex-session`, { headers });
      expect(bootstrap.status).toBe(200);
      const token = bootstrapToken(await bootstrap.text());
      expect(state.sessions.get(token)?.issuance).toBe("loopback");
      expect(state.sessions.get(token)?.serverOrigin).toBe(origin);
      expect((await fetch(`${base}/api/combos`, {
        headers: { ...headers, "x-opencodex-api-key": token, "x-opencodex-gui-origin": origin },
      })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    "http://localhost:10101",
    "http://127.0.0.1:10102",
  ])("a mismatched local public origin refuses local bootstrap: %s", async publicOrigin => {
    const { server, state, base } = await startHub(publicOrigin);
    try {
      const bootstrap = await fetch(`${base}/opencodex-session`, { headers: { Host: "127.0.0.1:10101" } });
      expect(bootstrap.status).toBe(401);
      expect(state.sessions.size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    "http://127.0.0.1:10101/unexpected-path",
    "http://127.0.0.1:10101?unexpected=query",
    "invalid-origin",
    " ",
  ])("a malformed nonempty public origin fails closed: %s", publicOrigin => {
    // Config loading already rejects these values; exercise issuance directly as defense in depth.
    const config = {
      ...remoteConfig(), runtimeRole: "hub" as const, hub: { managementPublicOrigin: publicOrigin },
    };
    const state = initializeManagementAuthState(config);
    if (!state.available) throw new Error("expected management auth state");
    const request = new Request("http://127.0.0.1:10101/opencodex-session", {
      headers: { Host: "127.0.0.1:10101" },
    });
    expect(issueGuiSession(request, config, state, { trustedTailscaleIngress: true })).toBeNull();
    expect(state.sessions.size).toBe(0);
  });

  test("a remote frontend rewriting Host to loopback cannot acquire local bootstrap", async () => {
    const { server, state, base } = await startHub("https://hub.example.test");
    try {
      for (const identity of [undefined, "mallory@example.test", "alice@example.test"]) {
        const headers = {
          Host: "127.0.0.1:10101",
          ...(identity === undefined ? {} : { "Tailscale-User-Login": identity }),
        };
        expect((await fetch(`${base}/opencodex-session`, { headers })).status).toBe(401);
        const page = await fetch(`${base}/`, { headers });
        expect((await page.text()).includes('name="opencodex-session-token"')).toBe(false);
      }
      expect(state.sessions.size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
