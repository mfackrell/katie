"use client";

import ReactMarkdown from "react-markdown";
import { useState } from "react";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
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
    {block.chart === "donut" ? <svg className="mx-auto mt-2 h-52 w-full max-w-sm" viewBox="0 0 260 220" role="img" aria-label={block.accessibleSummary}>
      {block.points.map((point, index) => {
        const total = block.points.reduce((sum, item) => sum + item.value, 0);
        const previous = block.points.slice(0, index).reduce((sum, item) => sum + item.value, 0);
        const radius = 68;
        const circumference = 2 * Math.PI * radius;
        const length = circumference * point.value / total;
        const offset = -circumference * previous / total;
        return <circle key={index} cx="130" cy="108" r={radius} fill="none" stroke={`hsl(${(index * 57 + 145) % 360} 65% 55%)`}
          strokeWidth="28" strokeDasharray={`${length} ${circumference - length}`}
          strokeDashoffset={offset} transform="rotate(-90 130 108)">
          <title>{point.label}: {point.value.toLocaleString()} {block.unit ?? ""}</title>
        </circle>;
      })}
      <circle cx="130" cy="108" r="45" fill="none" />
      <text x="130" y="112" textAnchor="middle" fill="currentColor" fontSize="14">Total: {block.points.reduce((sum, p) => sum + p.value, 0).toLocaleString()}</text>
    </svg> : <svg className="mt-2 h-auto w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={block.accessibleSummary}>
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

function SelectorBlock({ block }: { block: Extract<VisualBlock, { type: "selector" }> }) {
  const [selected, setSelected] = useState(0);
  return <section className="rounded-lg border border-white/15 p-3">
    <h3 className="font-semibold">{block.title}</h3>
    <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={block.title}>
      {block.options.map((option, index) =>
        <button key={index} type="button" aria-pressed={selected === index}
          className={`rounded-md border px-3 py-1.5 text-sm ${selected === index ? "border-emerald-400 bg-emerald-900/30" : "border-white/20"}`}
          onClick={() => setSelected(index)}>{option.label}</button>)}
    </div>
    <p className="mt-2 whitespace-pre-wrap text-sm">{block.options[selected].description}</p>
  </section>;
}

function RenderBlock({ block, assets = [] }: { block: VisualBlock; assets?: Array<{type: string; url: string}> }) {
  switch (block.type) {
    case "markdown": return <div className="prose prose-invert max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{block.text}</ReactMarkdown></div>;
    case "cards": return <div className="grid gap-3 sm:grid-cols-2">
      {block.items.map((item, index) => <section key={index} className="rounded-lg border border-white/15 p-3">
        <h3 className="font-semibold">{item.title}</h3>
        {item.value && <p className="mt-1 text-xl font-semibold">{item.value}</p>}
        <p className="mt-1 whitespace-pre-wrap text-sm">{item.description}</p>
        {item.status && <p className="mt-2 text-xs font-medium">Status: {statusLabels[item.status]}</p>}
      </section>)}
    </div>;
    case "chart": return <ChartBlock block={block} />;
    case "metric": return <section className="rounded-lg border border-white/15 p-3" aria-label={block.label}>
      <p className="text-sm opacity-75">{block.label}</p><p className="text-2xl font-semibold">{block.value}</p>
      {block.description && <p className="mt-1 text-sm">{block.description}</p>}
    </section>;
    case "selector": return <SelectorBlock block={block} />;
    case "media": {
      const asset = assets[block.assetIndex];
      if (!asset || asset.type !== "image" || !/^https:\/\//i.test(asset.url)) {
        return <p className="text-sm">{block.alt} (image unavailable)</p>;
      }
      return <figure className="rounded-lg border border-white/15 p-2">
        {/* Images are references to already-authorized saved message assets, not model-authored URLs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset.url} alt={block.alt} loading="lazy" className="max-h-80 w-full rounded object-contain" />
        {block.caption && <figcaption className="mt-1 text-xs opacity-75">{block.caption}</figcaption>}
      </figure>;
    }
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
export function StructuredResponseView({ response, assets, ordered = false }: {
  response: StructuredResponse;
  assets?: Array<{ type: string; url: string }>;
  ordered?: boolean;
}) {
  return <div className="space-y-4" aria-label="Structured assistant response">
    {response.blocks.filter(block => ordered || block.type !== "markdown")
      .map((block, index) => <RenderBlock key={index} block={block} assets={assets} />)}
  </div>;
}
