import { z } from "zod";

/**
 * Provider-neutral visual response contract.
 * Only data and approved presentation options cross the model/render boundary.
 * No HTML, JavaScript, arbitrary URLs, styles, or privileged actions.
 */
const short = z.string().trim().min(1).max(160);
const detail = z.string().max(4000);
const number = z.number().finite();
const status = z.enum(["completed", "in_progress", "pending", "blocked", "failed", "unverified"]);
const evidence = z.object({
  origin: z.enum(["observed", "estimated", "illustrative"]),
  description: short,
}).strict();
const chartPoint = z.object({
  label: short,
  value: number,
}).strict();

const markdownBlock = z.object({
  type: z.literal("markdown"),
  text: z.string().min(1).max(24000),
}).strict();
const cardBlock = z.object({
  type: z.literal("cards"),
  items: z.array(z.object({
    title: short,
    description: detail,
    value: short.optional(),
    status: status.optional(),
  }).strict()).min(1).max(12),
}).strict();
const chartBlock = z.object({
  type: z.literal("chart"),
  chart: z.enum(["line", "bar", "donut"]),
  title: short,
  unit: z.string().max(32).optional(),
  points: z.array(chartPoint).min(2).max(100),
  evidence,
  accessibleSummary: detail.min(1),
}).strict();
const statusesBlock = z.object({
  type: z.literal("statuses"),
  entries: z.array(z.object({
    label: short,
    state: status,
    evidence: short,
  }).strict()).min(1).max(20),
}).strict();
const comparisonBlock = z.object({
  type: z.literal("comparison"),
  columns: z.array(short).min(2).max(5),
  rows: z.array(z.object({
    label: short,
    values: z.array(z.string().max(500)).min(2).max(5),
  }).strict()).min(1).max(30),
}).strict();
const timelineBlock = z.object({
  type: z.literal("timeline"),
  events: z.array(z.object({
    label: short,
    date: short,
    description: detail,
    state: status.optional(),
  }).strict()).min(1).max(30),
}).strict();
const mediaBlock = z.object({
  type: z.literal("media"),
  assetIndex: z.number().int().min(0).max(19),
  alt: short,
  caption: short.optional(),
}).strict();
const selectorBlock = z.object({
  type: z.literal("selector"),
  title: short,
  options: z.array(z.object({
    label: short,
    description: detail,
  }).strict()).min(2).max(8),
}).strict();
const metricBlock = z.object({
  type: z.literal("metric"),
  label: short,
  value: short,
  description: detail.optional(),
}).strict();
const detailsBlock = z.object({
  type: z.literal("details"),
  title: short,
  body: detail.min(1),
}).strict();

export const visualBlockSchema = z.discriminatedUnion("type", [
  markdownBlock, cardBlock, chartBlock, statusesBlock,
  comparisonBlock, timelineBlock, detailsBlock, mediaBlock, selectorBlock, metricBlock,
]);

export const structuredResponseSchema = z.object({
  version: z.literal(1),
  blocks: z.array(visualBlockSchema).min(1).max(30),
  /** Always available when a richer client cannot render the blocks. */
  fallbackMarkdown: z.string().min(1).max(32000),
}).strict().superRefine((response, ctx) => {
  const orderedText = response.blocks.filter((block) => block.type === "markdown")
    .map(block => block.text).join("");
  if (orderedText && orderedText !== response.fallbackMarkdown) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ordered Markdown blocks must reconstruct canonical answer", path: ["blocks"] });
  }
  response.blocks.forEach((block, index) => {
    if (block.type === "chart" && block.chart === "donut" &&
      (block.points.some(point => point.value < 0) || !block.points.some(point => point.value > 0))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Donut data requires nonnegative values and a positive total", path: ["blocks", index] });
    }
    if (block.type === "comparison" && block.rows.some(row => row.values.length !== block.columns.length)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Comparison rows must match column count", path: ["blocks", index] });
    }
  });
});

export type StructuredResponse = z.infer<typeof structuredResponseSchema>;
export type VisualBlock = z.infer<typeof visualBlockSchema>;

export function parseStructuredResponse(value: unknown): StructuredResponse | null {
  const result = structuredResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Backward-compatible: ordinary assistant Markdown is never interpreted as component code. */
export function resolveResponseContent(
  markdown: string,
  candidate: unknown,
): { markdown: string; structured: StructuredResponse | null } {
  const structured = parseStructuredResponse(candidate);
  return { markdown: structured ? structured.fallbackMarkdown : markdown, structured };
}
