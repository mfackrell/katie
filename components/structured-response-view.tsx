"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StructuredResponse, VisualBlock } from "@/lib/chat/structured-response";

const statusLabels = {
  completed: "Completed",
  in_progress: "In progress",
  pending: "Pending",
  blocked: "Blocked",
  failed: "Failed",
  unverified: "Unverified",
} as const;

function ChartBlock({ block }: { block: Extract<VisualBlock, { type: "chart" }> }) {
  const max = Math.max(0, ...block.points.map(point => point.value));
  const min = Math.min(0, ...block.points.map(point => point.value));
  const span = max - min || 1;
  const width = 600;
  const height = 220;
  const inset = 28;
  const x = (index: number) => inset + index * (width - inset * 2) / Math.max(1, block.points.length - 1);
  const y = (value: number) => height - inset - (value - min) / span * (height - inset * 2);
  const label = block.evidence.origin === "observed" ? "Observed" : block.evidence.origin === "estimated" ? "Estimated" : "Illustrative";
  return <figure className="rounded-lg border border-white/15 p-3">
    <figcaption className="font-semibold">{block.title}</figcaption>
    {block.chart === "donut" ? <ul className="mt-3 space-y-1 text-sm">
      {block.points.map((point, index) => <li key={index} className="flex justify-between gap-2"><span>{point.label}</span><span>{point.value.toLocaleString()} {block.unit ?? ""}</span></li>)}
    </ul> : <svg className="mt-2 h-auto w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={block.accessibleSummary}>
      <line x1={inset} y1={height - inset} x2={width - inset} y2={height - inset} stroke="currentColor" opacity="0.4" />
      {block.chart === "line" ? <polyline fill="none" stroke="currentColor" strokeWidth="3" points={block.points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")} /> : block.points.map((point, index) => {
        const band = (width - inset * 2) / block.points.length;
        const barWidth = Math.min(45, band * 0.6);
        const center = inset + (index + 0.5) * band;
        return <rect key={index} x={center - barWidth / 2} y={Math.min(y(point.value), y(0))}
          height={Math.max(1, Math.abs(y(0) - y(point.value)))} width={barWidth}
          fill="currentColor" opacity="0.7"><title>{point.label}: {point.value} {block.unit ?? ""}</title></rect>;
      })}
      {block.chart === "line" && block.points.map((point, index) => <circle key={index} cx={x(index)} cy={y(point.value)} r="4" fill="currentColor"><title>{point.label}: {point.value} {block.unit ?? ""}</title></circle>)}
    </svg>}
    <details className="mt-2 text-sm"><summary className="cursor-pointer">View chart data</summary>
      <table className="mt-2 w-full"><thead><tr><th scope="col" className="text-left">Label</th><th scope="col" className="text-right">Value</th></tr></thead><tbody>
        {block.points.map((point, index) => <tr key={index}><td>{point.label}</td><td className="text-right">{point.value.toLocaleString()} {block.unit ?? ""}</td></tr>)}
      </tbody></table>
    </details>
    <p className="mt-2 text-xs opacity-70">{label}: {block.evidence.description}</p>
  </figure>;
}

function RenderBlock({ block }: { block: VisualBlock }) {
  switch (block.type) {
    case "markdown": return <div className="prose prose-invert max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown></div>;
    case "cards": return <div className="grid gap-3 sm:grid-cols-2">
      {block.items.map((item, index) => <section key={index} className="rounded-lg border border-white/15 p-3">
        <h3 className="font-semibold">{item.title}</h3>
        {item.value && <p className="mt-1 text-xl font-semibold">{item.value}</p>}
        <p className="mt-1 whitespace-pre-wrap text-sm">{item.description}</p>
        {item.status && <p className="mt-2 text-xs font-medium">Status: {statusLabels[item.status]}</p>}
      </section>)}
    </div>;
    case "chart": return <ChartBlock block={block} />;
    case "statuses": return <dl className="space-y-2">
      {block.entries.map((entry, index) => <div key={index} className="rounded border border-white/15 p-2">
        <dt className="font-medium">{entry.label}: {statusLabels[entry.state]}</dt>
        <dd className="mt-1 text-sm opacity-80">{entry.evidence}</dd>
      </div>)}
    </dl>;
    case "comparison": return <div className="overflow-x-auto"><table className="w-full border-collapse text-sm">
      <thead><tr><th scope="col" className="border-b p-2 text-left">Criterion</th>{block.columns.map((col, index) => <th key={index} scope="col" className="border-b p-2 text-left">{col}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, index) => <tr key={index}><th scope="row" className="border-b p-2 text-left">{row.label}</th>{row.values.map((value, cell) => <td key={cell} className="border-b p-2">{value}</td>)}</tr>)}</tbody>
    </table></div>;
    case "timeline": return <ol className="space-y-3 border-l border-white/20 pl-4">
      {block.events.map((event, index) => <li key={index}><p className="text-xs opacity-70">{event.date}</p><p className="font-semibold">{event.label}{event.state ? ` — ${statusLabels[event.state]}` : ""}</p><p className="text-sm">{event.description}</p></li>)}
    </ol>;
    case "details": return <details className="rounded border border-white/15 p-3"><summary className="cursor-pointer font-medium">{block.title}</summary><div className="mt-2 whitespace-pre-wrap text-sm">{block.body}</div></details>;
  }
}

/** Receives only server-validated response blocks; never accepts model-owned React code. */
export function StructuredResponseView({ response }: { response: StructuredResponse }) {
  return <div className="space-y-4" aria-label="Structured assistant response">
    {response.blocks.filter(block => block.type !== "markdown").map((block, index) => <RenderBlock key={index} block={block} />)}
  </div>;
}
