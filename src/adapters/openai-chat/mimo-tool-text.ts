import {
  parseToolCallMarkup,
  markupMatchesInput,
  salvagedArguments,
  TOOL_CALL_MARKER,
  MAX_HELD_TOOL_TEXT_BYTES,
  type CommandCodeDeclaredTool,
  type CommandCodeDeclaredTools,
  type ToolCallMarkup,
} from "../command-code-tool-text";
import type { AdapterEvent } from "../../types";

/**
 * MiMo tool-call markup on an OpenAI-Chat stream.
 *
 * MiMo v2.6 writes tool calls in its native XML grammar
 * `<function=NAME><parameter=KEY>VALUE</parameter></function>`. When the upstream
 * gateway cannot parse a freeform `exec` body (raw JavaScript that fails the
 * lowered `{input}` schema), it forwards the markup as `delta.content` text and
 * also sends the same call as a structured `delta.tool_calls` entry. Relaying
 * both puts the call on screen as assistant text (issue #5499).
 *
 * This guard holds a text run that opens with the MiMo tool-call marker instead
 * of streaming it. When the matching structured tool call arrives (same input),
 * the held text is dropped. When no structured call arrives and the finish is
 * clean, the guard restores a valid call from the markup or releases the text
 * unchanged. The parsing functions are shared with the Command Code adapter
 * (`src/adapters/command-code-tool-text.ts`), which solved the same leak on the
 * OAuth /alpha/generate path in #5611.
 */
export class MimoToolTextGuard {
  private held = "";
  private heldBytes = 0;
  private active = false;

  constructor(
    private readonly declared: CommandCodeDeclaredTools | undefined,
  ) {}

  /**
   * Feed a content delta. Returns the events to emit: empty while holding markup,
   * or the text to stream when the delta is not markup.
   */
  feed(text: string): AdapterEvent[] {
    if (!this.active) {
      const probe = this.held + text;
      const trimmed = probe.trimStart();
      if (TOOL_CALL_MARKER.startsWith(trimmed) || trimmed.startsWith(TOOL_CALL_MARKER)) {
        this.held = probe;
        this.heldBytes += new TextEncoder().encode(text).byteLength;
        this.active = true;
        return [];
      }
      return [{ type: "text_delta", text }];
    }
    this.held += text;
    this.heldBytes += new TextEncoder().encode(text).byteLength;
    if (this.heldBytes > MAX_HELD_TOOL_TEXT_BYTES) {
      const release = this.held;
      this.reset();
      return [{ type: "text_delta", text: release }];
    }
    return [];
  }

  /**
   * Called when a structured tool call is about to flush. If the held markup
   * matches this call's input, drop the held text (the structured call wins).
   * Returns true when the held text was consumed.
   */
  matchToolCall(name: string, args: string): boolean {
    if (!this.active || this.held.trim().length === 0) return false;
    const markup = parseToolCallMarkup(this.held);
    if (!markup || markup.name !== name) return false;
    let input: unknown;
    try { input = JSON.parse(args); } catch { input = args; }
    if (markupMatchesInput(markup, input)) {
      this.reset();
      return true;
    }
    return false;
  }

  /**
   * Called on a clean finish. If markup is held and no structured call matched,
   * try to restore a valid call from it; otherwise release as text.
   */
  flush(): { events: AdapterEvent[]; restored: { name: string; arguments: string } | undefined } {
    if (!this.active || this.held.trim().length === 0) {
      const carried = this.held;
      this.reset();
      return { events: carried.length > 0 ? [{ type: "text_delta", text: carried }] : [], restored: undefined };
    }
    const markup = parseToolCallMarkup(this.held);
    if (markup && this.declared) {
      const tool = this.declared.get(markup.name);
      if (tool) {
        const args = salvagedArguments(markup, tool);
        if (args !== undefined) {
          this.reset();
          return { events: [], restored: { name: markup.name, arguments: args } };
        }
      }
    }
    const release = this.held;
    this.reset();
    return { events: [{ type: "text_delta", text: release }], restored: undefined };
  }

  /** Release everything held as text without attempting restoration. */
  release(): AdapterEvent[] {
    const text = this.held;
    this.reset();
    return text.length > 0 ? [{ type: "text_delta", text }] : [];
  }

  private reset(): void {
    this.held = "";
    this.heldBytes = 0;
    this.active = false;
  }
}

/** Whether a model id is a MiMo model that emits native XML tool-call markup. */
export function isMimoToolTextModel(modelId: string): boolean {
  return /mimo/i.test(modelId);
}

/** Build the declared-tool map the guard needs from an OcxTool list. */
export function buildMimoDeclaredTools(tools: readonly { name: string; parameters: Record<string, unknown>; freeform?: boolean }[] | undefined): CommandCodeDeclaredTools {
  const map = new Map<string, CommandCodeDeclaredTool>();
  for (const tool of tools ?? []) {
    map.set(tool.name, { freeform: tool.freeform === true, schema: tool.parameters });
  }
  return map;
}

