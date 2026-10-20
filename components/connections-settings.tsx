"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useResource } from "@/components/workspace-data";
export function ConnectionsSettings() {
  const repos = useResource<{
      repos: Array<{ id: string; full_name: string }>;
    }>("/api/admin/repos"),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState<unknown>(null),
    guard = useRef(false);
  async function connect() {
    if (guard.current || !name.trim()) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/repos/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: name.trim() }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false)
        throw Error(
          data.error ?? data.message ?? "Repository connection failed",
        );
      setReceipt(data);
      repos.refresh();
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Repository connection failed");
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-4xl p-5 sm:p-10">
      <Link href="/settings" className="text-sm text-zinc-400">
        ← Settings
      </Link>
      <h1 className="mt-6 text-3xl font-semibold">Connections</h1>
      <p className="mt-3 text-sm text-zinc-400">
        Connect a GitHub repository, then choose it within the relevant
        conversation. Connection does not approve coding, merging, or
        deployment.
      </p>
      <h2 className="mt-8 font-semibold">Connected repositories</h2>
      {repos.data?.repos.map((repo) => (
        <p className="border-b border-white/10 py-4 text-sm" key={repo.id}>
          {repo.full_name}
        </p>
      ))}
      {repos.error && (
        <p role="alert" className="mt-4 text-amber-200">
          {repos.error}
        </p>
      )}
      <form
        className="mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label className="block text-sm">
          GitHub repository
          <input
            aria-label="GitHub repository"
            required
            pattern="[^/ ]+/[^/ ]+"
            placeholder="owner/repository"
            className="mt-2 w-full rounded-lg border border-white/15 bg-zinc-900 p-3 text-base"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          disabled={busy}
          className="min-h-11 rounded-xl bg-emerald-400 px-5 font-semibold text-zinc-950 disabled:opacity-40"
        >
          {busy ? "Connecting…" : "Connect repository"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-amber-200">
          {error}
        </p>
      )}
      {receipt != null && (
        <div role="status" className="mt-4">
          <p className="text-emerald-300">Repository connected.</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm">
              Connection receipt
            </summary>
            <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(receipt, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
