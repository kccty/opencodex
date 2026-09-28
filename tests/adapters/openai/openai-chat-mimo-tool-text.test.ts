import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../../../src/adapters/openai-chat";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

// Issue #5499: MiMo v2.6 emits tool calls in native XML markup that leaks as
// assistant text alongside the structured tool_calls entry on the openai-chat
// path. The guard holds the markup and drops it when the matching structured
// call flushes, so the XML envelope never reaches the client as text.

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
};

function makeResponse(chunks: object[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// The guard reads per-model state set by buildRequest on the same adapter instance,
// so each test must buildRequest and parseStream on one shared adapter.
async function collectEvents(adapter: ReturnType<typeof createOpenAIChatAdapter>, response: Response): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of adapter.parseStream(response)) {
    if (e.type !== "heartbeat") out.push(e);
  }
  return out;
}

function buildParsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: {
      messages: [{ role: "user", content: "list /tmp", timestamp: 0 }],
      tools: [{ name: "exec", description: "run", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] }, freeform: true }],
    },
    stream: true,
    options: {},
  };
}

const MARKER = "\u003ctool_call\u003e";
const CLOSE = "\u003c/tool_call\u003e";

describe("MiMo tool-call text guard (openai-chat)", () => {
  test("drops XML envelope when a matching structured tool call flushes", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const jsBody = "tools.exec_command({cmd:'ls'})";
    const envelope = MARKER + "<function=exec>" + jsBody + "</parameter></function>" + CLOSE;
    const response = makeResponse([
      { choices: [{ delta: { content: envelope } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: JSON.stringify({ input: jsBody }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const textEvents = events.filter(e => e.type === "text_delta");
    const toolCalls = events.filter(e => e.type === "tool_call_start");
    expect(toolCalls.length).toBe(1);
    expect(textEvents.length).toBe(0);
  });

  test("releases non-markup text unchanged", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const response = makeResponse([
      { choices: [{ delta: { content: "Hello world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("Hello world");
  });

  test("does not engage for non-MiMo models", async () => {
    const parsed = buildParsed("deepseek-v4-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const envelope = MARKER + "<function=exec>raw</parameter></function>" + CLOSE;
    const response = makeResponse([
      { choices: [{ delta: { content: envelope } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toContain("<function=exec>");
  });

  // The #5499 field report: the marker follows prose in the same content run
  // ("…。<tool_call><function=exec>…"), not a standalone block like Command Code sees.
  test("drops mid-run markup that follows prose in the same delta", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const jsBody = "rg -n \"def place_order\" server/ledger.py";
    const content = "我来查一下订单逻辑。" + MARKER + "<function=exec>" + jsBody + "</function>" + CLOSE;
    const response = makeResponse([
      { choices: [{ delta: { content } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: JSON.stringify({ input: jsBody }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("我来查一下订单逻辑。");
    expect(events.filter(e => e.type === "tool_call_start").length).toBe(1);
  });

  test("holds a marker that arrives split across deltas", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const jsBody = "rg -n locked server/state.py";
    const response = makeResponse([
      { choices: [{ delta: { content: "检查一下。<tool_" } }] },
      { choices: [{ delta: { content: "call><function=exec>" + jsBody + "</function>" + CLOSE } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: JSON.stringify({ input: jsBody }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("检查一下。");
    expect(events.filter(e => e.type === "tool_call_start").length).toBe(1);
  });

  test("releases text whose tail merely resembles the marker", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const response = makeResponse([
      { choices: [{ delta: { content: "a<toolx" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("a<toolx");
  });

  // The gateway can cut the echo mid body with no closing tag; the structured
  // call still carries the full input, so the truncated text is its duplicate.
  test("drops a truncated echo when the structured call extends its partial body", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const jsBody = "const queries = [[\"paper/order core\", \"rg -n place_order server/ledger.py\", 30000]]";
    const partialBody = jsBody.slice(0, 40);
    const echo = "好的。" + MARKER + "<function=exec>" + partialBody;
    const response = makeResponse([
      { choices: [{ delta: { content: echo } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: JSON.stringify({ input: jsBody }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("好的。");
    expect(events.filter(e => e.type === "tool_call_start").length).toBe(1);
  });

  test("releases an unterminated markup unchanged when no structured call arrives", async () => {
    const parsed = buildParsed("mimo-v2.6-flash");
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest(parsed);
    const echo = "正文。" + MARKER + "<function=exec>partial code";
    const response = makeResponse([
      { choices: [{ delta: { content: echo } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const events = await collectEvents(adapter, response);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe(echo);
  });
});

