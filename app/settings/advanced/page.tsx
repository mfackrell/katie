"use client";
import { useEffect, useRef, useState } from "react";
import { IdentityDirectory } from "@/components/identity-directory";
import Link from "next/link";
import { MissionsPanel } from "@/components/missions-panel";
import {RecoveryPanel} from '@/components/recovery-panel';
import { ProjectApprovalCard, type ProjectApproval } from "@/components/project-approval-card";
import type { AgentConfig, AgentTask, ManagedAgent } from "@/lib/agents/policy";

type TaskView = AgentTask & { output?: string | null; review?: unknown; progress?: unknown };
type ProjectSummary = { id:string; actorId:string; chatId:string; chatTitle:string; name:string; status:string; phase:string; detail:string|null; milestoneIndex:number; milestoneCount:number; cycles:number; maxCycles:number; updatedAt:string; deadline:string };
type PendingReply = { taskId: string; turnId: string; expectedRequestId: string; message: string };
type HandoffPreview = { handoff: { sourceActorId: string; sourceChatId: string; projectId: string }; label: string };
const replyKey = (taskId: string) => `katie.agentReply.v1.${taskId}`;
function savedReply(taskId: string): PendingReply | null {
  try {
    const raw = window.localStorage.getItem(replyKey(taskId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingReply>;
    if (value.taskId !== taskId || typeof value.turnId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.turnId) ||
        typeof value.expectedRequestId !== "string" || value.expectedRequestId.length < 1 || value.expectedRequestId.length > 128 ||
        typeof value.message !== "string" || !value.message.trim() || value.message.length > 16000) return null;
    return value as PendingReply;
  } catch { return null; }
}
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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [approval, setApproval] = useState<{chatId:string;actorId:string;scope:ProjectApproval}|null>(null);
  const [approvalBusy,setApprovalBusy] = useState(false);
  const [projectsError,setProjectsError] = useState("");
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [config, setConfig] = useState<AgentConfig>(defaults);
  const [editing, setEditing] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<"general" | "development">("general");
  const [carryContext, setCarryContext] = useState(false);
  const [handoffPreview, setHandoffPreview] = useState<HandoffPreview | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const handoffRequest = useRef(0);
  const [repos, setRepos] = useState<{ id: string; full_name: string }[]>([]);
  const [repoId, setRepoId] = useState("");
  const [selected, setSelected] = useState<TaskView | null>(null);
  const [continuation, setContinuation] = useState("");
  const [pendingReply, setPendingReply] = useState<PendingReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const creationId = useRef<string | null>(null);
  const [error, setError] = useState("");
  function clearHandoff() {
    handoffRequest.current += 1;
    setCarryContext(false); setHandoffPreview(null); setHandoffLoading(false); setHandoffError("");
  }
  async function chooseHandoff(checked: boolean) {
    clearHandoff();
    if (!checked) return;
    const request = handoffRequest.current;
    setCarryContext(true); setHandoffLoading(true);
    try {
      const chatId = window.localStorage.getItem("katie.activeChatId");
      if (!chatId) throw new Error("Open the source conversation first, then return here to carry its context.");
      const preview = await api(`/api/agent-tasks?handoffChatId=${encodeURIComponent(chatId)}`) as HandoffPreview;
      if (request !== handoffRequest.current) return;
      if (!preview.handoff || preview.handoff.sourceChatId !== chatId || !preview.label)
        throw new Error("The source conversation’s active task could not be verified.");
      if (window.localStorage.getItem("katie.activeChatId") !== chatId)
        throw new Error("The current conversation changed. Select its context again.");
      setHandoffPreview(preview);
    } catch (e) {
      if (request === handoffRequest.current) { setCarryContext(false); setHandoffError(e instanceof Error ? e.message : "Conversation context unavailable."); }
    } finally { if (request === handoffRequest.current) setHandoffLoading(false); }
  }
  useEffect(() => {
    const invalidate = () => {
      if (handoffPreview && window.localStorage.getItem("katie.activeChatId") !== handoffPreview.handoff.sourceChatId) {
        clearHandoff(); setHandoffError("The current conversation changed. Select its context again.");
      }
    };
    window.addEventListener("storage", invalidate); window.addEventListener("focus", invalidate);
    return () => { window.removeEventListener("storage", invalidate); window.removeEventListener("focus", invalidate); };
  }, [handoffPreview]);
  async function createTask() {
    let handoff: HandoffPreview["handoff"] | undefined;
    if (kind === "general" && carryContext) {
      if (handoffLoading || !handoffPreview) throw new Error("Wait for the source context to be verified.");
      const chatId = window.localStorage.getItem("katie.activeChatId");
      if (chatId !== handoffPreview.handoff.sourceChatId) {
        clearHandoff(); throw new Error("The current conversation changed. Select its context again.");
      }
      const current = await api(`/api/agent-tasks?handoffChatId=${encodeURIComponent(chatId)}`) as HandoffPreview;
      if (window.localStorage.getItem("katie.activeChatId") !== chatId ||
          current.handoff?.sourceActorId !== handoffPreview.handoff.sourceActorId ||
          current.handoff?.sourceChatId !== handoffPreview.handoff.sourceChatId ||
          current.handoff?.projectId !== handoffPreview.handoff.projectId || current.label !== handoffPreview.label) {
        clearHandoff(); throw new Error("The active task changed. Select its context again before saving.");
      }
      handoff = current.handoff;
    }
    const id = creationId.current ??= crypto.randomUUID();
    const result = await api("/api/agent-tasks", { action: "create", id, agentId, input, kind,
      ...(kind === "development" ? { repositoryId: repoId } : {}), ...(handoff ? { handoff } : {}) });
    select(result.task); creationId.current = null; setInput(""); clearHandoff(); await load();
  }
  async function loadProjects() {
    try {
      const result = await api("/api/projects/overview") as {projects:ProjectSummary[]};
      setProjects(result.projects ?? []);setProjectsError("");
    } catch(e) {setProjectsError(e instanceof Error?e.message:"Project overview unavailable");}
  }
  useEffect(()=>{
    let cancelled=false;
    const refresh=async()=>{
      if(cancelled||document.visibilityState==="hidden")return;
      try {
        const result=await api("/api/projects/overview") as {projects:ProjectSummary[]};
        if(!cancelled){setProjects(result.projects??[]);setProjectsError("");}
      } catch(e) {if(!cancelled)setProjectsError(e instanceof Error?e.message:"Project overview unavailable");}
    };
    const timer=window.setInterval(()=>void refresh(),15000);
    window.addEventListener("focus",refresh);
    void refresh();
    return()=>{cancelled=true;window.clearInterval(timer);window.removeEventListener("focus",refresh);};
  },[]);
  async function reviewProject(project:ProjectSummary){
    const result=await api("/api/projects?actorId="+encodeURIComponent(project.actorId)+"&chatId="+encodeURIComponent(project.chatId)) as {approval?:ProjectApproval|null};
    if(!result.approval)throw Error("Project approval is no longer pending. Refresh status.");
    setApproval({actorId:project.actorId,chatId:project.chatId,scope:result.approval});
  }
  async function approveProject(hash:string){
    if(!approval||approvalBusy)return;
    setApprovalBusy(true);setError("");
    try{
      await api("/api/projects",{actorId:approval.actorId,chatId:approval.chatId,approvalHash:hash});
      setApproval(null);await loadProjects();
    } catch(e){setError(e instanceof Error?e.message:"Project approval failed");}
    finally{setApprovalBusy(false);}
  }
  function openProject(project:ProjectSummary){
    window.localStorage.setItem("katie.activeActorId",project.actorId);
    window.localStorage.setItem("katie.activeChatId",project.chatId);
    window.location.assign(`/conversations/${encodeURIComponent(project.chatId)}`);
  }
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
        if (!id && chat) { const result = await api(`/api/agent-tasks?chatId=${encodeURIComponent(chat)}`); if (active) select(result.task); }
        if (id) { const result = await api(`/api/agent-tasks?id=${encodeURIComponent(id)}`); if (active) select(result.task); }
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
    const pending = savedReply(task.id);
    setSelected(task); setContinuation(pending?.message ?? ""); setPendingReply(pending);
    window.history.replaceState(null, "", `/settings/advanced?task=${encodeURIComponent(task.id)}`);
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
    let reply: PendingReply | null = null;
    if (action === "continue") {
      const message = continuation.trim();
      const prior = savedReply(selected.id);
      reply = prior?.message === message ? prior : { taskId: selected.id, turnId: crypto.randomUUID(), expectedRequestId: selected.request_id, message };
      // Persist before submission, so a reload after response loss retries this same turn.
      window.localStorage.setItem(replyKey(selected.id), JSON.stringify(reply));
      setPendingReply(reply);
    }
    const result = await api("/api/agent-tasks", { action, id: selected.id, ...(reply ? { message: reply.message, turnId: reply.turnId, expectedRequestId: reply.expectedRequestId } : {}) });
    if (reply && savedReply(selected.id)?.turnId === reply.turnId) window.localStorage.removeItem(replyKey(selected.id));
    select(result.task);
    // An old receipt may be replayed after a later turn. Never execute that later turn by accident.
    if (!result.continuation || result.continuation.request_id === result.task.request_id) await execute(result.task);
    await load();
  }
  return <main className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100 sm:px-8">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Advanced management</h1><p className="text-sm text-zinc-400">Reusable isolated identities, saved task instructions, and reviewed results.</p></div><Link className={button} href="/">Chat workspace</Link></header>
      <IdentityDirectory/>
      {error && <p role="alert" className="rounded-lg border border-red-400/40 p-3 text-red-200">{error}</p>}
      {loading ? <p role="status">Loading agents and tasks…</p> : <>
        <section aria-label="Autonomous projects" className="space-y-3 rounded-xl border border-amber-400/25 bg-white/[0.03] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-semibold">Autonomous projects</h2>
            <button type="button" className={button} onClick={()=>void loadProjects()}>Refresh projects</button>
          </div>
          <p className="text-sm text-zinc-400">Live project progress and approvals, separate from individual agent tasks.</p>
          {projectsError&&<p role="alert" className="text-sm text-red-200">{projectsError}</p>}
          {!projects.length&&!projectsError&&<p className="text-sm text-zinc-400">No autonomous projects found.</p>}
          <ul className="space-y-2">{projects.map(project=><li key={project.id} className="rounded-xl border border-white/10 bg-zinc-900/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{project.name}</h3>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${project.status==="awaiting_approval"?"bg-amber-400 text-zinc-950":project.status==="blocked"?"bg-red-500/20 text-red-200":project.status==="completed"?"bg-emerald-500/20 text-emerald-200":"bg-sky-500/20 text-sky-200"}`}>{project.status.replaceAll("_"," ")}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-300">{project.detail??"No recent details"}</p>
            <p className="mt-1 text-xs text-zinc-500">Phase: {project.phase} · Verified milestones: {project.milestoneIndex}/{project.milestoneCount} · Coding cycles: {project.cycles}/{project.maxCycles}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {project.status==="awaiting_approval"&&<button className="min-h-10 rounded-lg bg-amber-400 px-3 font-semibold text-zinc-950" onClick={()=>void work(()=>reviewProject(project))}>Review & approve</button>}
              <button className={button} onClick={()=>openProject(project)}>Open project chat</button>
            </div>
          </li>)}</ul>
          {approval&&<ProjectApprovalCard approval={approval.scope} pending={approvalBusy} error={error||null}
            onApprove={hash=>{void approveProject(hash);}}
            onRequestChanges={()=>{const project=projects.find(p=>p.chatId===approval.chatId);if(project)openProject(project);}}/>}
        </section>
        <RecoveryPanel />
        <MissionsPanel agents={agents} repos={repos} />
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
              <label className="block">Independent review preference<select aria-label="Independent review preference" className={field} value={config.reviewMode} onChange={e => setConfig({ ...config, reviewMode: e.target.value as AgentConfig["reviewMode"] })}><option value="always">Always (default)</option><option value="adaptive">Adaptive</option></select></label>
              <label className="block">Maximum active tasks (1–4)<input className={field} type="number" min={1} max={4} required value={config.maxActiveTasks} onChange={e => setConfig({ ...config, maxActiveTasks: Number(e.target.value) })} /></label>
              <label className="block">Maximum input characters (100–16000)<input className={field} type="number" min={100} max={16000} required value={config.maxInputChars} onChange={e => setConfig({ ...config, maxInputChars: Number(e.target.value) })} /></label>
              <p className="text-xs text-zinc-400">These bound admission and each user turn. Existing runtime deadlines and bounded collaboration apply. No hard dollar or token budget is offered.</p>
              <button className={button} disabled={busy}>Save agent</button>{editing && <button type="button" className={`${button} ml-2`} disabled={busy} onClick={() => { setEditing(null); setConfig(defaults); }}>Cancel editing</button>}
            </form>
          </section>
          <section className="space-y-4 rounded-xl border border-white/10 p-4" aria-labelledby="task-title"><h2 id="task-title" className="text-lg">Assign a task</h2>
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void work(createTask); }}>
              <label className="block">Agent<select aria-label="Agent" className={field} value={agentId} required onChange={e => setAgentId(e.target.value)}><option value="">Choose an agent</option>{agents.filter(a => !a.archived).map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
              <label className="block">Task type<select aria-label="Task type" className={field} value={kind} onChange={e => { setKind(e.target.value as typeof kind); clearHandoff(); }}><option value="general">Research, analysis, finance, writing or code assistance</option><option value="development">Autonomous software development</option></select></label>
              {kind === "development" && <label className="block">Connected repository<select aria-label="Connected repository" className={field} value={repoId} required onChange={e => setRepoId(e.target.value)}><option value="">Choose repository</option>{repos.map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}</select></label>}
              {kind === "general" && <div className="space-y-2 rounded-lg border border-white/10 p-3">
                <label className="flex items-center gap-2"><input type="checkbox" checked={carryContext} disabled={busy || handoffLoading} onChange={e => void chooseHandoff(e.target.checked)} />Carry current conversation context</label>
                <p className="text-xs text-zinc-400">Include the active task’s requirements, decisions and confirmed facts for the selected specialist.</p>
                {handoffLoading && <p role="status" className="text-sm">Verifying source context…</p>}
                {handoffPreview && <div className="text-sm"><p className="font-medium">Active task to carry:</p><p className="whitespace-pre-wrap break-words">{handoffPreview.label}</p><Link className="underline" href={`/conversations/${encodeURIComponent(handoffPreview.handoff.sourceChatId)}`}>View source conversation</Link></div>}
                {handoffError && <p role="alert" className="text-sm text-amber-200">{handoffError}</p>}
              </div>}
              <label className="block">Task instructions<textarea className={field} value={input} rows={5} required maxLength={agents.find(a => a.id === agentId)?.config.maxInputChars ?? 16000} onChange={e => setInput(e.target.value)} /></label>
              <button className={button} disabled={busy || handoffLoading || (carryContext && !handoffPreview)}>Save task for approval</button>
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
            {pendingReply?.taskId === selected.id && <button className={button} disabled={busy} onClick={() => void work(() => start("continue"))}>Retry saved continuation</button>}
            {selected.status === "running" && <button className={button} disabled={busy} onClick={() => void work(() => execute(selected))}>Resume saved request</button>}
            <button className={button} disabled={busy} onClick={() => void work(async () => { const result = await api("/api/agent-tasks", { action: "refresh", id: selected.id }); select(result.task); await load(); })}>Refresh status</button>
            <button className={button} disabled={busy} onClick={() => { localStorage.setItem("katie.activeActorId", selected.actor_id); localStorage.setItem("katie.activeChatId", selected.chat_id); window.location.assign(`/conversations/${encodeURIComponent(selected.chat_id)}`); }}>Open existing workspace</button>
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
