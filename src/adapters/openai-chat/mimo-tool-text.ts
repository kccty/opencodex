import {
  parseToolCallMarkup,
  markupMatchesInput,
  salvagedArguments,
  TOOL_CALL_MARKER,
  MAX_HELD_TOOL_TEXT_BYTES,
  type CommandCodeDeclaredTool,
  type CommandCodeDeclaredTools,
} from "../command-code-tool-text";
import type { AdapterEvent } from "../../types";

/**
 * MiMo tool-call markup on an OpenAI-Chat stream.
 *
 * MiMo v2.6 writes tool calls in its native XML grammar
 * `<tool_call><function=NAME>...</function></tool_call>`. When the upstream
 * gateway cannot parse a freeform `exec` body (raw JavaScript that fails the
 * lowered `{input}` schema), it forwards the markup as `delta.content` text and
 * also sends the same call as a structured `delta.tool_calls` entry. Relaying
 * both puts the call on screen as assistant text (issue #5499).
 *
 * On this wire the marker is not a standalone text block the way it is on
 * Command Code (#5611): the model writes prose first and the markup inside the
 * same content run (`…查一下。<tool_call><function=exec>…`), and the gateway can
 * cut the echo mid body with no closing `</tool_call>`. The guard therefore
 * scans every fed delta for the first marker, streams the prose ahead of it,
 * and holds from the marker on. When the matching structured tool call flushes
 * — same input, or an input that extends a truncated echo — the held markup is
 * dropped. When no structured call arrives and the finish is clean, the guard
 * restores a valid call from complete markup or releases the text unchanged.
 * The parsing functions are shared with the Command Code adapter
 * (`src/adapters/command-code-tool-text.ts`).
 */

const encoder = new TextEncoder();

/**
 * The earliest index whose remainder is a prefix of the marker. A strict prefix
 * has to reach the end of the buffer (anything after it would already
 * mismatch), so only the last `marker.length - 1` starts can qualify.
 */
function earliestMarkerPrefix(buffer: string): number {
  const window = Math.max(0, buffer.length - (TOOL_CALL_MARKER.length - 1));
  for (let i = window; i < buffer.length; i++) {
    if (TOOL_CALL_MARKER.startsWith(buffer.slice(i))) return i;
  }
  return -1;
}

const TRUNCATED_FREEFORM = /^<tool_call>\s*<function=([^>\s]+)>([\s\S]*)$/;

/**
 * A held echo the gateway cut mid body: the freeform name and its partial
 * input. Parameterized bodies return undefined — their structured input is an
 * object, and prefix-comparing that against markup text would be a guess.
 */
function truncatedFreeformMarkup(text: string): { name: string; value: string } | undefined {
  const match = TRUNCATED_FREEFORM.exec(text.trim());
  if (!match || match[2]!.includes("<parameter=")) return undefined;
  return { name: match[1]!, value: match[2]! };
}

/** The freeform input text of a structured call: a plain string or the lowered single-key object. */
function freeformInputText(args: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { return args.length > 0 ? args : undefined; }
  if (typeof parsed === "string") return parsed;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed);
    if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1];
  }
  return undefined;
}

export class MimoToolTextGuard {
  private held = "";
  private heldBytes = 0;
  private pending = "";
  private active = false;

  constructor(
    private readonly declared: CommandCodeDeclaredTools | undefined,
  ) {}

  /**
   * Feed a content delta. Returns the events to emit: the prose that precedes
   * the marker (streamed at once), and nothing while markup is held.
   */
  feed(text: string): AdapterEvent[] {
    if (this.active) {
      this.held += text;
      this.heldBytes += encoder.encode(text).byteLength;
      if (this.heldBytes > MAX_HELD_TOOL_TEXT_BYTES) {
        const release = this.held;
        this.reset();
        return [{ type: "text_delta", text: release }];
      }
      return [];
    }
    const buffer = this.pending + text;
    this.pending = "";
    const full = buffer.indexOf(TOOL_CALL_MARKER);
    const partial = earliestMarkerPrefix(buffer);
    if (full !== -1 && (partial === -1 || full <= partial)) {
      const lead = buffer.slice(0, full);
      this.held = buffer.slice(full);
      this.heldBytes = encoder.encode(this.held).byteLength;
      this.active = true;
      return lead.length > 0 ? [{ type: "text_delta", text: lead }] : [];
    }
    if (partial !== -1) {
      // A tail that could still grow into the marker is held back rather than
      // streamed, so a marker split across deltas never leaks its first half.
      const lead = buffer.slice(0, partial);
      this.pending = buffer.slice(partial);
      return lead.length > 0 ? [{ type: "text_delta", text: lead }] : [];
    }
    return buffer.length > 0 ? [{ type: "text_delta", text: buffer }] : [];
  }

  /**
   * Called when a structured tool call is about to flush. If the held markup
   * matches this call's input — exactly, or by extending a body the gateway
   * cut off mid echo — drop the held text (the structured call wins).
   * Returns true when the held text was consumed.
   */
  matchToolCall(name: string, args: string): boolean {
    if (!this.active || this.held.trim().length === 0) return false;
    const markup = parseToolCallMarkup(this.held);
    if (markup) {
      if (markup.name !== name) return false;
      let input: unknown;
      try { input = JSON.parse(args); } catch { input = args; }
      if (markupMatchesInput(markup, input)) {
        this.reset();
        return true;
      }
      return false;
    }
    const partial = truncatedFreeformMarkup(this.held);
    if (partial && partial.name === name) {
      const input = freeformInputText(args);
      if (input !== undefined && partial.value.trim().length > 0 && input.trim().startsWith(partial.value.trim())) {
        this.reset();
        return true;
      }
    }
    return false;
  }

  /**
   * Called on a clean finish. If markup is held and no structured call matched,
   * try to restore a valid call from it; otherwise release as text. An
   * unterminated markup restores nothing — a body the gateway cut mid way
   * cannot be trusted as the call's full input — so it is released unchanged.
   */
  flush(): { events: AdapterEvent[]; restored: { name: string; arguments: string } | undefined } {
    if (!this.active) {
      const carried = this.pending;
      this.pending = "";
      return { events: carried.length > 0 ? [{ type: "text_delta", text: carried }] : [], restored: undefined };
    }
    if (this.held.trim().length === 0) {
      const carried = this.held;
      this.reset();
      return { events: [{ type: "text_delta", text: carried }], restored: undefined };
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
    const text = this.active ? this.held : this.pending;
    this.reset();
    return text.length > 0 ? [{ type: "text_delta", text }] : [];
  }

  private reset(): void {
    this.held = "";
    this.heldBytes = 0;
    this.pending = "";
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
