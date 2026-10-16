"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentConfig, AgentTask, ManagedAgent } from "@/lib/agents/policy";

type TaskView = AgentTask & { output?: string | null; review?: unknown; progress?: unknown };
const defaults: AgentConfig = { name: "", instructions: "", research: false, attachments: false, development: false, maxActiveTasks: 1, maxInputChars: 8000, reviewMode: "always" };
const field = "w-full rounded-lg border border-white/20 bg-zinc-900 p-3 text-white";
const button = "rounded-lg border border-white/20 px-4 py-2 hover:bg-white/10 disabled:opacity-40";
async function api(path: string, body?: unknown) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Request failed");
  return payload;
}
export default function AgentsPage() {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [config, setConfig] = useState<AgentConfig>(defaults);
  const [editing, setEditing] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<"general" | "development">("general");
  const [repos, setRepos] = useState<{ id: string; full_name: string }[]>([]);
  const [repoId, setRepoId] = useState("");
  const [selected, setSelected] = useState<TaskView | null>(null);
  const [continuation, setContinuation] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const creationId = useRef<string | null>(null);
  const [error, setError] = useState("");
  async function load() {
    const [a, t, r] = await Promise.all([api("/api/agents"), api("/api/agent-tasks"), api("/api/admin/repos")]);
    setAgents(a.agents); setTasks(t.tasks); setRepos(r.repos ?? []);
  }
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [a, t, r] = await Promise.all([api("/api/agents"), api("/api/agent-tasks"), api("/api/admin/repos")]);
        if (!active) return;
        setAgents(a.agents); setTasks(t.tasks); setRepos(r.repos ?? []);
        const params = new URLSearchParams(window.location.search);
        const id = params.get("task");
        const chat = params.get("chat");
        if (!id && chat) { const result = await api(`/api/agent-tasks?chatId=${encodeURIComponent(chat)}`); if (active) setSelected(result.task); }
        if (id) { const result = await api(`/api/agent-tasks?id=${encodeURIComponent(id)}`); if (active) setSelected(result.task); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Unable to load agents"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);
  async function work(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); } finally { busyRef.current = false; setBusy(false); }
  }
  function select(task: TaskView) {
    setSelected(task); setContinuation("");
    window.history.replaceState(null, "", `/agents?task=${encodeURIComponent(task.id)}`);
  }
  async function inspect(id: string) {
    const result = await api(`/api/agent-tasks?id=${encodeURIComponent(id)}`);
    select(result.task);
  }
  async function execute(task: TaskView) {
    if (task.kind !== "general" || task.status !== "running") return;
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-request-id": task.request_id }, body: JSON.stringify({ actorId: task.actor_id, chatId: task.chat_id, message: task.input, repoInjectionEnabled: false }) });
    // Consume the existing runtime stream; only durable server status determines success.
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    }
    await inspect(task.id);
    if (!response.ok) throw new Error("Execution did not complete. Refresh the saved task status for details.");
  }
  async function start(action: "start" | "continue") {
    if (!selected) return;
    const result = await api("/api/agent-tasks", { action, id: selected.id, ...(action === "continue" ? { message: continuation } : {}) });
    select(result.task); await execute(result.task); await load();
  }
  return <main className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100 sm:px-8">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Agents</h1><p className="text-sm text-zinc-400">Reusable isolated identities, saved task instructions, and reviewed results.</p></div><Link className={button} href="/">Chat workspace</Link></header>
      {error && <p role="alert" className="rounded-lg border border-red-400/40 p-3 text-red-200">{error}</p>}
      {loading ? <p role="status">Loading agents and tasks…</p> : <>
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-4 rounded-xl border border-white/10 p-4" aria-labelledby="definitions-title"><h2 id="definitions-title" className="text-lg">Saved agents</h2>
            {!agents.length && <p>No managed agents yet. Existing actors remain in the chat workspace.</p>}
            <ul className="space-y-2">{agents.map(agent => <li key={agent.id} className="flex flex-wrap items-center gap-2"><span className="mr-auto">{agent.config.name} {agent.archived ? "(archived)" : `· version ${agent.version}`}</span><button className={button} disabled={busy || agent.archived} onClick={() => { setEditing(agent.id); setConfig(agent.config); }}>Edit {agent.config.name}</button><button className={button} disabled={busy || agent.archived} onClick={() => void work(async () => { await api("/api/agents", { id: agent.id, config: agent.config, archive: true }); await load(); })}>Archive {agent.config.name}</button></li>)}</ul>
            <form className="space-y-3 border-t border-white/10 pt-4" onSubmit={event => { event.preventDefault(); void work(async () => { await api("/api/agents", { ...(editing ? { id: editing } : {}), config }); setEditing(null); setConfig(defaults); await load(); }); }}>
              <h3>{editing ? "Edit agent" : "Create agent"}</h3>
              <label className="block">Name<input className={field} value={config.name} required maxLength={80} onChange={e => setConfig({ ...config, name: e.target.value })} /></label>
              <label className="block">Purpose, instructions and responsibilities<textarea className={field} rows={5} value={config.instructions} required maxLength={12000} onChange={e => setConfig({ ...config, instructions: e.target.value })} /></label>
              {([['research', 'Live web research'], ['development', 'Approved development submission']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={config[key]} onChange={e => setConfig({ ...config, [key]: e.target.checked })} />{label}</label>)}
              <p className="text-sm text-zinc-400">Repository reads and attachment/media access: unavailable for managed tasks. Development runs in the existing GitHub workflow.</p>
              <label className="block">Independent review preference<select className={field} value={config.reviewMode} onChange={e => setConfig({ ...config, reviewMode: e.target.value as AgentConfig["reviewMode"] })}><option value="always">Always (default)</option><option value="adaptive">Adaptive</option></select></label>
              <label className="block">Maximum active tasks (1–4)<input className={field} type="number" min={1} max={4} required value={config.maxActiveTasks} onChange={e => setConfig({ ...config, maxActiveTasks: Number(e.target.value) })} /></label>
              <label className="block">Maximum input characters (100–16000)<input className={field} type="number" min={100} max={16000} required value={config.maxInputChars} onChange={e => setConfig({ ...config, maxInputChars: Number(e.target.value) })} /></label>
              <p className="text-xs text-zinc-400">These bound admission and each user turn. Existing runtime deadlines and bounded collaboration apply. No hard dollar or token budget is offered.</p>
              <button className={button} disabled={busy}>Save agent</button>{editing && <button type="button" className={`${button} ml-2`} disabled={busy} onClick={() => { setEditing(null); setConfig(defaults); }}>Cancel editing</button>}
            </form>
          </section>
          <section className="space-y-4 rounded-xl border border-white/10 p-4" aria-labelledby="task-title"><h2 id="task-title" className="text-lg">Assign a task</h2>
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void work(async () => { const id = creationId.current ??= crypto.randomUUID(); const result = await api("/api/agent-tasks", { action: "create", id, agentId, input, kind, ...(kind === "development" ? { repositoryId: repoId } : {}) }); select(result.task); creationId.current = null; setInput(""); await load(); }); }}>
              <label className="block">Agent<select className={field} value={agentId} required onChange={e => setAgentId(e.target.value)}><option value="">Choose an agent</option>{agents.filter(a => !a.archived).map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
              <label className="block">Task type<select className={field} value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="general">Research, analysis, finance, writing or code assistance</option><option value="development">Autonomous software development</option></select></label>
              {kind === "development" && <label className="block">Connected repository<select className={field} value={repoId} required onChange={e => setRepoId(e.target.value)}><option value="">Choose repository</option>{repos.map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}</select></label>}
              <label className="block">Task instructions<textarea className={field} value={input} rows={5} required maxLength={agents.find(a => a.id === agentId)?.config.maxInputChars ?? 16000} onChange={e => setInput(e.target.value)} /></label>
              <button className={button} disabled={busy}>Save task for approval</button>
            </form>
            <h3>Task history</h3>{!tasks.length && <p>No saved tasks yet.</p>}
            <ul className="max-h-80 space-y-2 overflow-y-auto">{tasks.map(t => <li key={t.id}><button className={`${button} w-full text-left`} disabled={busy} onClick={() => void work(() => inspect(t.id))}>{t.snapshot.name} · {t.initial_input.slice(0, 90)} · {t.status}</button></li>)}</ul>
          </section>
        </div>
        {selected && <section className="space-y-4 rounded-xl border border-white/10 p-4" aria-labelledby="selected-title"><h2 id="selected-title" className="text-lg">Saved task · {selected.status}</h2>
          <p className="whitespace-pre-wrap break-words">{selected.initial_input}</p>
          {selected.input !== selected.initial_input && <p className="whitespace-pre-wrap break-words">Current saved turn: {selected.input}</p>}
          <details><summary>Trusted saved configuration · version {selected.definition_version}</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(selected.snapshot, null, 2)}</pre><p>Repository: {selected.repository_full_name ?? "none"}</p></details>
          {selected.details && <p role="status">{selected.details}</p>}
          <div className="flex flex-wrap gap-2">
            {selected.status === "draft" && <button className={button} disabled={busy} onClick={() => void work(() => start("start"))}>{selected.kind === "development" ? "Approve exact saved task and submit to GitHub" : "Start saved task"}</button>}
            {selected.status === "running" && <button className={button} disabled={busy} onClick={() => void work(() => execute(selected))}>Resume saved request</button>}
            <button className={button} disabled={busy} onClick={() => void work(async () => { const result = await api("/api/agent-tasks", { action: "refresh", id: selected.id }); select(result.task); await load(); })}>Refresh status</button>
            <button className={button} disabled={busy} onClick={() => { localStorage.setItem("katie.activeActorId", selected.actor_id); localStorage.setItem("katie.activeChatId", selected.chat_id); window.location.assign("/"); }}>Open existing workspace</button>
          </div>
          {selected.output && <div className="whitespace-pre-wrap break-words rounded-lg bg-white/5 p-4">{selected.output}</div>}
          {selected.review != null && <details><summary>Independent review details</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(selected.review, null, 2)}</pre></details>}
          {selected.progress != null && <details><summary>Conversation task progress and pending questions</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(selected.progress, null, 2)}</pre></details>}
          {selected.external.receipt != null && <details><summary>Verified workflow receipt and checks</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(selected.external.receipt, null, 2)}</pre></details>}
          {selected.kind === "general" && ["pending", "completed", "failed"].includes(selected.status) && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void work(() => start("continue")); }}><label className="block">Continue in this task’s conversation<textarea className={field} required maxLength={selected.snapshot.maxInputChars} value={continuation} onChange={e => setContinuation(e.target.value)} /></label><button className={button} disabled={busy}>Send continuation</button></form>}
          <div className="flex flex-wrap gap-4">{([['issueUrl', 'GitHub issue'], ['runUrl', 'Workflow run'], ['prUrl', 'Draft PR']] as const).map(([key, label]) => { const url = selected.external[key]; return typeof url === "string" && /^https:\/\/github\.com\//.test(url) ? <a key={key} href={url} target="_blank" rel="noreferrer" className="underline">{label}</a> : null; })}</div>
          {selected.kind === "development" && <p className="text-sm text-zinc-400">READY means draft ready for owner approval. Nothing is automatically merged or deployed.</p>}
        </section>}
      </>}
      <p role="status" aria-live="polite">{busy ? "Working… Tasks and requests remain saved if the connection is lost." : ""}</p>
    </div>
  </main>;
}
