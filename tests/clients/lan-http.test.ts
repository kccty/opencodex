import { describe, expect, test } from "bun:test";
import { isHubAdminTransportPermitted, isHubTransportPermitted } from "../../src/lib/hub-transport";
import { normalizeHubOrigin, fetchHubReady, downloadClientCatalog, exchangeConnectPairingGrant, issueClientKey, startClientKeyRotation, commitClientKeyRotation, abortClientKeyRotation, revokeClientKey, fetchHubUsage, fetchHubState } from "../../src/client/hub-client";
import { createGuiPairingGrant, consumeGuiPairingGrant, type GuiSessionState } from "../../src/server/gui-session";
import { pairingOriginUsable } from "../../src/cli/hub";
import type { OcxConfig } from "../../src/types";

const hub = "http://192.168.50.83:10100";
const browser = "http://localhost:10100";
const now = Date.now();
const fakeFetch = (fn: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>): typeof fetch =>
  Object.assign(fn, { preconnect: fetch.preconnect });
const config: OcxConfig = { port: 10100, hostname: "192.168.50.83", runtimeRole: "hub", defaultProvider: "fixture", providers: {},
  hub: { managementPublicOrigin: hub }, corsAllowOrigins: [browser] };

describe("private LAN HTTP transport", () => {
  test.each(["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.50.83"])("accepts literal private IPv4 %s", host => {
    const origin = `http://${host}:10100`;
    expect(normalizeHubOrigin(origin + "/v1")).toBe(origin);
    expect(isHubTransportPermitted(origin)).toBe(true);
    expect(isHubAdminTransportPermitted(origin)).toBe(true);
    expect(pairingOriginUsable(origin)).toBe(true);
  });
  test.each(["http://example.test", "http://100.64.0.1", "http://172.15.0.1", "http://172.32.0.1", "http://192.169.0.1", "http://8.8.8.8", "http://0.0.0.0", "http://[fd00::1]", "ftp://192.168.1.1"])("still refuses %s", origin => {
    expect(isHubTransportPermitted(origin)).toBe(false);
    expect(pairingOriginUsable(origin)).toBe(false);
    expect(() => normalizeHubOrigin(origin)).toThrow();
  });
  test("URL credential, path, query and fragment restrictions remain", () => {
    for (const value of [`http://user:pass@192.168.1.1`, `${hub}/other`, `${hub}?token=x`, `${hub}#x`]) {
      expect(() => normalizeHubOrigin(value)).toThrow();
    }
  });
  test("ready and catalog synchronize over private LAN without following redirects", async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch(async (input, init) => {
      seen.push(String(input)); expect(init?.redirect).toBe("manual");
      expect((init as RequestInit & { proxy?: string | false }).proxy).toBe(false);
      if (String(input).endsWith("/readyz")) return Response.json({ status: "ready", protocol: 1, minimumClientProtocol: 1, managementUrl: hub });
      expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe("fixture-data-key");
      return Response.json({ models: [{ slug: "combo/leader" }] });
    });
    expect((await fetchHubReady(hub, { fetchImpl })).status).toBe("ready");
    expect((await downloadClientCatalog(hub, "fixture-data-key", { fetchImpl })).kind).toBe("fresh");
    expect(seen).toHaveLength(2);
    await expect(fetchHubReady(hub, { fetchImpl: fakeFetch(async () => new Response(null, { status: 302, headers: { Location: "http://example.test" } })) }))
      .rejects.toMatchObject({ code: "redirect_refused" });
  });
  test("client pairing exchanges with the actual server grant rules, then rejects replay", async () => {
    const state: GuiSessionState = { sessions: new Map(), pairingGrants: new Map() };
    const grant = createGuiPairingGrant(browser, config, state, now);
    const fetchImpl = fakeFetch(async (_input, init) => {
      const req = new Request(`${hub}/opencodex-session`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Host: "192.168.50.83:10100" } });
      const session = consumeGuiPairingGrant(req, JSON.parse(String(init?.body)), config, state, now + 1);
      if (!session) return new Response(null, { status: 401 });
      return new Response([
        `<meta name="opencodex-session-token" content="${session.token}">`,
        `<meta name="opencodex-session-csrf" content="${session.csrfToken}">`,
        `<meta name="opencodex-session-origin" content="${session.browserOrigin}">`,
        `<meta name="opencodex-session-server-origin" content="${session.serverOrigin}">`,
      ].join(""));
    });
    const bytes = new TextEncoder().encode(grant.grant);
    expect((await exchangeConnectPairingGrant(hub, browser, bytes, { fetchImpl })).serverOrigin).toBe(hub);
    await expect(exchangeConnectPairingGrant(hub, browser, bytes, { fetchImpl })).rejects.toMatchObject({ code: "pairing_refused" });
    expect(state.pairingGrants.size).toBe(0);
  });
  test("a mismatched browser origin cannot consume the LAN grant", () => {
    const state: GuiSessionState = { sessions: new Map(), pairingGrants: new Map() };
    const grant = createGuiPairingGrant(browser, config, state, now);
    const request = new Request(`${hub}/opencodex-session`, { method: "POST", headers: { Host: "192.168.50.83:10100", Origin: "http://example.test" } });
    expect(consumeGuiPairingGrant(request, { grant: grant.grant }, config, state, now + 1)).toBeNull();
    expect(state.pairingGrants.size).toBe(1);
  });
  test("admin issuance, rotation and revocation accept private LAN HTTP", async () => {
    const authority = { kind: "admin" as const, value: new TextEncoder().encode("fixture-admin") };
    let calls = 0;
    const fetchImpl = fakeFetch(async (_input, init) => {
      calls++; expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe("fixture-admin");
      return Response.json({ id: "fixture", name: "client", key: `ocx_data_${"a".repeat(40)}`, createdAt: new Date(now).toISOString(),
        rotationId: "rotation", expiresAt: new Date(now + 60_000).toISOString() });
    });
    expect((await issueClientKey(hub, authority, "client", { fetchImpl })).id).toBe("fixture");
    expect((await startClientKeyRotation(hub, authority, "fixture", { fetchImpl })).rotationId).toBe("rotation");
    await commitClientKeyRotation(hub, authority, "fixture", "rotation", { fetchImpl });
    await abortClientKeyRotation(hub, authority, "fixture", "rotation", { fetchImpl });
    await revokeClientKey(hub, authority, "fixture", { fetchImpl });
    expect(calls).toBe(5);
  });
  test("subsequent usage and hub-state reads reach the LAN server with authentication", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async (_input, init) => { calls++; expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe("fixture-key"); return new Response(null, { status: 401 }); });
    await expect(fetchHubUsage(hub, "fixture-key", new URLSearchParams(), { fetchImpl })).rejects.toThrow();
    await expect(fetchHubState(hub, "fixture-key", { fetchImpl })).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
