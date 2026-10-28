import { standaloneCodexRoutingTarget, type CodexRoutingTarget } from "../codex/inject/routing-target";
import type { OcxClientConnectionConfig, OcxConfig } from "../types";
import { isLinkConnection, readClientConnectionState } from "./state";

export type ClientCodexRoutingTarget = CodexRoutingTarget & { link?: true };

/**
 * Codex routing for a connected client. A hub client points Codex at the hub with the admission
 * token in `env_key`. A link Child (`localPort` given) keeps exactly the standalone loopback form,
 * root `openai_base_url = "http://127.0.0.1:<port>/v1"` with no provider table and no `env_key`:
 * its own listener relays to the Home and attaches the link key itself, so a GUI-launched Codex
 * that never saw the key's environment variable still works, and joining changes no Codex bytes.
 */
export function routingTarget(
  serverUrl: string,
  localPort?: number,
  config?: Pick<OcxConfig, "codexDesktopAuthless" | "codexClientCompaction">,
): ClientCodexRoutingTarget {
  if (localPort === undefined) {
    return { baseUrl: `${serverUrl}/v1`, requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" };
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error("link mode requires a valid local config port");
  }
  return {
    ...standaloneCodexRoutingTarget(localPort, {
      hostname: "127.0.0.1",
      codexDesktopAuthless: config?.codexDesktopAuthless,
      codexClientCompaction: config?.codexClientCompaction,
    }),
    link: true as const,
  };
}

/**
 * The target to write when a caller supplies none.
 *
 * Only the connected client's own writers used to pass a target, so every other entry point —
 * `ocx restore back` and the local `ocx sync` path — defaulted to the standalone loopback form
 * and wrote `http://127.0.0.1:<port>/v1` into a machine whose Codex must reach the hub. A client
 * with no local proxy on that port then quietly fell back to the official ChatGPT endpoint, which
 * is exactly the surprise this resolution removes. Lives here rather than in `connect.ts` because
 * the injector needs the same answer and `connect.ts` already imports the injector.
 */
export function defaultCodexRoutingTarget(
  port: number,
  config?: OcxConfig,
): ClientCodexRoutingTarget {
  const state = readClientConnectionState();
  if (state.kind !== "connected" || state.value.pendingOperation) {
    return standaloneCodexRoutingTarget(port, config);
  }
  const connection = state.value;
  return routingTarget(
    connection.serverUrl,
    isLinkConnection(connection) ? config?.port ?? port : undefined,
    config,
  );
}
