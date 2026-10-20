"use client";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useResource } from "@/components/workspace-data";
export function GlobalSearchScreen() {
  const params = useSearchParams(),
    router = useRouter(),
    q = params.get("q") ?? "",
    kind = params.get("type") ?? "All";
  const resource = useResource<{
    results: Array<{
      id: string;
      kind: string;
      title: string;
      snippet: string;
      href: string;
    }>;
    warnings: string[];
    scope?: string;
  }>(`/api/search?q=${encodeURIComponent(q)}`);
  function change(key: string, value: string) {
    const p = new URLSearchParams(params.toString());
    p.set(key, value);
    router.replace(`/search?${p}`, { scroll: false });
  }
  const results = (resource.data?.results ?? []).filter(
    (r) => kind === "All" || r.kind === kind,
  );
  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-10">
      <h1 className="text-3xl font-semibold">Search Katie</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Find conversations, requests, answers, work, and specialists.
      </p>
      <input
        autoFocus
        aria-label="Search Katie"
        placeholder="Search your work…"
        className="mt-6 w-full rounded-xl border border-white/15 bg-zinc-900 p-3 text-base"
        value={q}
        onChange={(e) => change("q", e.target.value)}
      />
      <label className="mt-4 block text-sm">
        Show
        <select
          className="ml-3 rounded bg-zinc-900 p-3"
          aria-label="Search result type"
          value={kind}
          onChange={(e) => change("type", e.target.value)}
        >
          {[
            "All",
            "Conversation",
            "Request",
            "Answer",
            "Work",
            "Result",
            "Specialist",
          ].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      {resource.error && (
        <p role="alert" className="my-4 text-amber-200">
          {resource.error}
          <button
            className="ml-3 min-h-11 underline"
            onClick={() => void resource.refresh()}
          >
            Retry connection
          </button>
        </p>
      )}
      {resource.data?.warnings.map((w) => (
        <p key={w} className="mt-4 text-amber-200">
          {w}
        </p>
      ))}
      {q.length < 2 ? (
        <p className="mt-8 text-zinc-500">Enter at least two characters.</p>
      ) : resource.loading ? (
        <p role="status" className="mt-8">
          Searching…
        </p>
      ) : (
        results.map((result) => (
          <Link
            key={result.kind + result.id}
            href={result.href}
            className="block border-b border-white/10 py-5"
          >
            <p className="text-xs text-emerald-300">{result.kind}</p>
            <h2 className="mt-2 break-words font-semibold">{result.title}</h2>
            <p className="mt-2 line-clamp-3 break-words text-sm text-zinc-400">
              {result.snippet}
            </p>
          </Link>
        ))
      )}
      {q.length >= 2 && !resource.loading && !results.length && (
        <p className="py-6 text-zinc-400">No matching results.</p>
      )}
      <p className="mt-6 text-xs text-zinc-500">{resource.data?.scope}</p>
    </div>
  );
}
