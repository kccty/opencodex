import {
  applyCodexRoutingHint,
  CODEX_RESPONSES_LITE_HEADER,
  CODEX_RESPONSES_LITE_METADATA_KEY,
} from "../../codex/forward-transport-headers";

export const CODEX_RESPONSES_HTTP_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
export const WS_BETA = "responses_websockets=2026-02-06";

export interface PreparedCodexWsRequest {
  /** Fully synthesized frame; the transport measures this exact text before dialing. */
  frameText: string;
  headers: Record<string, string>;
  /** Original HTTP body/framing/options with only the canonical routing hint re-derived. */
  httpInit: RequestInit;
  canonical: boolean;
  carriesImageInput: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_IMAGE_INPUT_SCAN_NODES = 100_000;

/**
 * Detect actual Responses image parts without matching prompt text. The scan is
 * bounded and fail-safe: an unexpectedly large input stays on HTTP/SSE rather
 * than entering the single-frame WebSocket path.
 */
export function codexRequestInputCarriesImage(input: unknown): boolean {
  const pending: unknown[] = [input];
  let scanned = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    scanned += 1;
    if (scanned > MAX_IMAGE_INPUT_SCAN_NODES) return true;
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    if (!isRecord(value)) continue;
    if (value.type === "input_image" || value.type === "computer_screenshot") return true;
    for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}

function applyLiteMetadata(body: Record<string, unknown>, headers: Headers): boolean {
  const metadata = body.client_metadata;
  // Native client metadata is a string map. Do not spread malformed input or
  // turn boolean/number values into plausible but invented protocol strings.
  if (metadata !== undefined && (!isRecord(metadata)
    || Object.values(metadata).some(value => typeof value !== "string"))) return false;
  const lite = headers.get(CODEX_RESPONSES_LITE_HEADER);
  if (lite === "true" || lite === "false") {
    body.client_metadata = { ...(metadata as Record<string, string> | undefined),
      [CODEX_RESPONSES_LITE_METADATA_KEY]: lite };
  }
  for (const name of ["x-codex-turn-state", "x-codex-turn-metadata"]) {
    const value = headers.get(name);
    const current = body.client_metadata as Record<string, string> | undefined;
    if (value !== null && !Object.hasOwn(current ?? {}, name)) {
      body.client_metadata = { ...current, [name]: value };
    }
  }
  return true;
}

/** Pure preparation; null keeps malformed requests on the existing HTTP fallback path. */
export function prepareCodexHttpInit(url: string, init: RequestInit): RequestInit {
  if (url !== CODEX_RESPONSES_HTTP_URL || typeof init.body !== "string") return init;
  const headers = new Headers(init.headers);
  let body: unknown;
  try { body = JSON.parse(init.body); } catch { /* malformed body cannot authorize a hint */ }
  applyCodexRoutingHint(headers, body);
  return { ...init, headers };
}

/** Null refuses only WS conversion; canonical HTTP normalization is independently reusable. */
export function prepareCodexWsRequest(url: string, init: RequestInit): PreparedCodexWsRequest | null {
  if (typeof init.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (!isRecord(parsed)) return null;
    const body = { ...parsed };
    const canonical = url === CODEX_RESPONSES_HTTP_URL;
    const carriesImageInput = codexRequestInputCarriesImage(body.input);
    const httpHeaders = new Headers(init.headers);
    if (canonical) {
      if (!applyLiteMetadata(body, httpHeaders)) return null;
      applyCodexRoutingHint(httpHeaders, body);
    }
    const httpInit = { ...init, headers: httpHeaders };
    // WS is implicitly streaming; retain every other caller field except type.
    delete body.stream;
    const frameText = JSON.stringify({ ...body, type: "response.create" });
    const headers: Record<string, string> = {};
    httpHeaders.forEach((value, key) => {
      if (key === "content-type" || key === "content-length" || key === "accept" || key === "accept-encoding") return;
      headers[key] = value;
    });
    // Preserve the existing beta composition for both canonical and opted-in gateways.
    headers["openai-beta"] = headers["openai-beta"]
      ? headers["openai-beta"].includes("responses_websockets")
        ? headers["openai-beta"]
        : `${headers["openai-beta"]}, ${WS_BETA}`
      : WS_BETA;
    return { frameText, headers, httpInit, canonical, carriesImageInput };
  } catch {
    return null;
  }
}
