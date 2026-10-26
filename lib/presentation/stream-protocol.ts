import { validatePresentation } from "@/lib/presentation/default-registry";
import type { StructuredResponse } from "@/lib/chat/structured-response";

export const PRESENTATION_START = "\n<katie-presentation-v1>\n";
export const PRESENTATION_END = "\n</katie-presentation-v1>";
const LIMIT = 64 * 1024;

export const PRESENTATION_GENERATION_GUIDANCE = [
  "Answer the user normally in complete Markdown prose. A visual must be optional, never compulsory.",
  "Only when cards, a chart, statuses, comparison, timeline or details would materially improve comprehension, append ONE machine-readable visual specification at the VERY END.",
  "Append a newline, <katie-presentation-v1>, a newline, compact JSON with ONLY version:1 and blocks, then a newline and </katie-presentation-v1>.",
  "The text before the marker must be a complete useful answer; never reference hidden JSON in the visible explanation.",
  "Allowed blocks: markdown {type,text}; cards {type,items:[{title,description,value?,status?}]}; chart {type,chart:'line'|'bar'|'donut',title,points:[{label,value}],unit?,evidence:{origin:'observed'|'estimated'|'illustrative',description},accessibleSummary}; statuses {type,entries:[{label,state,evidence}]}; comparison {type,columns:[strings],rows:[{label,values:[strings]}]}; timeline {type,events:[{label,date,description,state?}]}; details {type,title,body}.",
  "Statuses: completed, in_progress, pending, blocked, failed, unverified.",
  "Use only grounded numerical data; do not invent metrics, sources, CI states, dates or evidence. Use ordinary Markdown if uncertain.",
  "No executable code, HTML, CSS, URLs, actions, arbitrary fields or other component types in visual JSON.",
].join("\n");

export function parsePresentationTail(raw: string): {
  text: string;
  presentation: StructuredResponse | null;
} {
  const start = raw.lastIndexOf(PRESENTATION_START);
  if (start < 0) return { text: raw, presentation: null };
  const prefix = raw.slice(0, start);
  const tail = raw.slice(start + PRESENTATION_START.length);
  const end = tail.lastIndexOf(PRESENTATION_END);
  if (end < 0 || tail.slice(end + PRESENTATION_END.length).trim() || !prefix.trim()) {
    return { text: prefix || raw, presentation: null };
  }
  const json = tail.slice(0, end);
  if (new TextEncoder().encode(json).length > LIMIT) return { text: prefix, presentation: null };
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text: prefix, presentation: null };
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes("version") || !keys.includes("blocks")) {
      return { text: prefix, presentation: null };
    }
    const record = parsed as { version: unknown; blocks: unknown };
    const presentation = validatePresentation({
      version: record.version, blocks: record.blocks, fallbackMarkdown: prefix,
    });
    return { text: prefix, presentation };
  } catch {
    return { text: prefix, presentation: null };
  }
}

/**
 * Holds a bounded delimiter lookbehind. Raw component JSON never enters the
 * streamed Markdown channel. Incomplete or invalid structures are dropped;
 * the full preceding prose remains readable.
 */
export class PresentationStreamFilter {
  private pending = "";
  private inComponent = false;
  private closed = false;
  private componentBytes = 0;

  write(delta: string): string {
    if (this.closed || !delta) return "";
    if (this.inComponent) {
      this.componentBytes += new TextEncoder().encode(delta).length;
      if (this.componentBytes > LIMIT) this.closed = true;
      return "";
    }
    this.pending += delta;
    const marker = this.pending.indexOf(PRESENTATION_START);
    if (marker >= 0) {
      const plain = this.pending.slice(0, marker);
      this.pending = "";
      this.inComponent = true;
      return plain;
    }
    const keep = PRESENTATION_START.length - 1;
    if (this.pending.length <= keep) return "";
    const visible = this.pending.slice(0, -keep);
    this.pending = this.pending.slice(-keep);
    return visible;
  }

  finish(): string {
    if (this.inComponent || this.closed) return "";
    const remaining = this.pending;
    this.pending = "";
    return remaining;
  }
}
