import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { BOUNDED_WS_RUNTIME, shouldUseCodexWsUpstream, streamingInit } from "../helpers/ws-upstream-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

/**
 * Canonical ChatGPT requests carrying Responses image input stay on HTTP/SSE
 * instead of the responses_websockets beta lane. These cases live in a sibling
 * file because tests/responses/ws-upstream.test.ts sits at its file-size cap;
 * the harness below mirrors its FakeWebSocket/installFake shapes.
 */

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket, mirroring `ws-upstream.test.ts`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() { this.closed = true; }
}

const RealWebSocket = globalThis.WebSocket;
const RealFetch = globalThis.fetch;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
let savedProxyEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

// A case that calls handleResponses directly never takes the writer lease startServer takes,
// so its dispatch is refused. Dropped in teardown so a throwing case cannot leave it behind.
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] !== undefined) process.env[key] = savedProxyEnv[key];
  }
});

describe("canonical image input transport selection", () => {
  test("keeps canonical image-bearing input on HTTP SSE", () => {
    const imageInput = [{
      role: "user",
      content: [
        { type: "input_text", text: "describe this" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }];
    expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit({ input: imageInput }))).toBe(false);
    expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit({
      input: [{ type: "custom_tool_call_output", output: imageInput }],
    }))).toBe(false);
    expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit({
      input: [{ type: "computer_screenshot", image_url: "data:image/png;base64,iVBORw0KGgo=" }],
    }))).toBe(false);

    // A prompt that merely discusses the wire type is still ordinary text.
    expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit({
      input: "Explain JSON containing {\"type\":\"input_image\"}",
    }))).toBe(true);
    // Operator-configured gateways keep their explicit WS policy; the image
    // exception is destination-scoped to the canonical ChatGPT WS beta.
    expect(shouldUseCodexWsUpstream(
      "https://sub2api.example.com/v1/responses",
      streamingInit({ input: imageInput }),
      BOUNDED_WS_RUNTIME,
      true,
    )).toBe(false);
  });

  test("an image-bearing continuation uses HTTP SSE without dialing upstream WS", async () => {
    installFake(() => { throw new Error("canonical image input must not dial WS"); });
    takeSpendHome();
    const outboundBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      outboundBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { id: "r-image", status: "completed", output: [] },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const input = [{
      role: "user",
      content: [
        { type: "input_text", text: "describe this" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }];
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-5.5", input, stream: true }),
    });
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "openai",
      streamMode: "legacy-tee",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    } as OcxConfig;

    const response = await handleResponses(request, config, { model: "", provider: "" }, {
      codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    });

    expect(response.status).toBe(200);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(outboundBodies).toHaveLength(1);
    expect(JSON.stringify(outboundBodies[0]?.input)).toContain("input_image");
    expect(await response.text()).toContain("response.completed");
  });
});
