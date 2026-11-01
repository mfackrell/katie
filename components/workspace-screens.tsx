"use client";
import { SelfToolsOwnerSession } from '@/components/self-tools-owner-session';
import { ownerConversationHeaders } from '@/lib/tools/browser-owner-session';
import { LifecycleOwnerApproval } from "@/components/lifecycle-owner-approval";
import { BenchmarkOwnerApproval } from "@/components/benchmark-owner-approval";
import { SpecialistDirectory } from "@/components/specialist-directory";
import Notepad from "@/components/Notepad";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PendingMissionApprovals } from "@/components/pending-mission-approvals";
import {
  useSavedState,
  type UIState,
} from "@/components/saved-workspace-state";
import { useResource } from "@/components/workspace-data";
import {
  actorAudience,
  isActive,
  needsYou,
  topLevelWork,
  workLabel,
  type WorkItem,
} from "@/lib/ui/work";
import { conversationHref, workHref } from "@/lib/ui/links";
import type { Actor, ChatThread } from "@/lib/types/chat";
type UIIndex = { states: UIState[] };
function useUIIndex() {
  const resource = useResource<UIIndex>("/api/ui-state");
  return {
    ...resource,
    byKey: new Map((resource.data?.states ?? []).map((s) => [s.key, s.value])),
  };
}
const quiet =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-40";
const input =
  "w-full rounded-xl border border-white/15 bg-zinc-900 px-4 py-3 text-base outline-none focus:border-emerald-400";
type WorkResponse = {
  items: WorkItem[];
  warnings: string[];
  checkedAt: string;
  limit: number;
};
function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Update time unavailable";
}
function DeleteChatButton({ chat, onDeleted }: { chat: ChatThread; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (deleting || !window.confirm(`Permanently delete “${chat.title}” and its messages? This cannot be undone.`)) return;
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/chats?id=${encodeURIComponent(chat.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete this chat. Please try again.");
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this chat.");
    } finally {
      setDeleting(false);
    }
  }
  return <div className="shrink-0">
    <button type="button" className="min-h-11 rounded-lg px-3 text-sm text-zinc-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40" aria-label={`Delete chat: ${chat.title}`} disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete"}</button>
    {error && <p role="alert" className="max-w-48 text-xs text-red-300">{error}</p>}
  </div>;
}
function Status({ item }: { item: WorkItem }) {
  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs ${needsYou(item) ? "border-amber-400/30 text-amber-200" : "border-white/10 text-zinc-300"}`}
    >
      {workLabel(item)}
    </span>
  );
}
function Heading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
          {description}
        </p>
      </div>
      {children}
    </header>
  );
}
function ErrorState({
  error,
  retry,
  checked,
}: {
  error: string;
  retry: () => unknown;
  checked?: string | null;
}) {
  return error ? (
    <div
      role="alert"
      className="my-4 rounded-xl border border-amber-400/30 p-4 text-sm text-amber-100"
    >
      {error}
      {checked && (
        <p className="mt-1">
          Last checked {date(checked)}. Showing saved status.
        </p>
      )}
      <button className={`${quiet} ml-3`} onClick={() => void retry()}>
        Retry connection
      </button>
    </div>
  ) : null;
}
function WorkRow({ item }: { item: WorkItem }) {
  return (
    <Link
      href={workHref(item.source, item.id)}
      className="block border-b border-white/10 py-5 hover:bg-white/[0.025]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 max-w-2xl break-words font-medium">
          {item.title.length > 150
            ? item.title.slice(0, 150) + "…"
            : item.title}
        </h3>
        <Status item={item} />
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        {item.specialist} · {item.phase.replaceAll("_", " ")} ·{" "}
        {date(item.updatedAt)}
      </p>
      {item.detail && (
        <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{item.detail}</p>
      )}
      {!!item.children?.length && (
        <p className="mt-2 text-xs text-zinc-500">
          {item.children.length} linked activities
        </p>
      )}
    </Link>
  );
}
export function HomeScreen() {
  const preferences = useUIIndex();
  const work = useResource<WorkResponse>("/api/work"),
    chats = useResource<{ chats: ChatThread[] }>("/api/chats"),
    actors = useResource<{ actors: Actor[] }>("/api/actors");
  const attention = topLevelWork(work.data?.items ?? []).filter(
    (i) => needsYou(i) && !i.isTest,
  );
  const actorsById = new Map((actors.data?.actors ?? []).map((actor) => [actor.id, actor]));
  const visibleIds = new Set(
    (actors.data?.actors ?? [])
      .filter((a) => actorAudience(a) === "conversation")
      .map((a) => a.id),
  );
  const recent = (chats.data?.chats ?? [])
    .filter(
      (c) =>
        visibleIds.has(c.actorId) &&
        !preferences.byKey.get(`chat:${c.id}`)?.archived,
    )
    .sort(
      (a, b) =>
        Number(preferences.byKey.get(`chat:${b.id}`)?.pinned ?? false) -
          Number(preferences.byKey.get(`chat:${a.id}`)?.pinned ?? false) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, 5);
  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-10">
      <Heading
        title="Welcome back"
        description="Continue your work or ask Katie for something new."
      />
      <Link
        href="/conversations/new"
        className="mb-10 flex items-center justify-between rounded-2xl border border-white/15 bg-zinc-900 p-6"
      >
        <div>
          <h2 className="text-xl font-medium">
            What would you like to get done?
          </h2>
          <p className="mt-2 text-zinc-400">Ask Katie…</p>
        </div>
        <span className="rounded-xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-zinc-950">
          Start →
        </span>
      </Link>
      <section aria-labelledby="attention-title">
        <div className="flex justify-between">
          <h2 id="attention-title" className="text-lg font-semibold">
            Needs your attention
          </h2>
          <Link href="/work?filter=needs" className="text-sm text-emerald-300">
            View all
          </Link>
        </div>
        <ErrorState
          error={work.error}
          retry={work.refresh}
          checked={work.checked}
        />
        <LifecycleOwnerApproval />
        <BenchmarkOwnerApproval />
        <PendingMissionApprovals />
        {work.loading ? (
          <p className="py-6 text-zinc-400">Checking current work…</p>
        ) : !attention.length && !work.error && !work.data?.warnings.length ? (
          <p className="py-6 text-sm text-zinc-500">
            No project decisions or blockers found. Any pending coding approvals
            appear above.
          </p>
        ) : (
          attention.map((item) => <WorkRow key={item.key} item={item} />)
        )}
        {work.data?.warnings.map((w) => (
          <p key={w} className="mt-2 text-sm text-amber-200">
            {w}
          </p>
        ))}
      </section>
      <section className="mt-10">
        <div className="flex justify-between">
          <h2 className="text-lg font-semibold">Continue where you left off</h2>
          <Link className="text-sm text-emerald-300" href="/conversations">
            All conversations
          </Link>
        </div>
        <ErrorState
          error={chats.error || actors.error}
          retry={() => {
            void chats.refresh();
            void actors.refresh();
          }}
        />
        {recent.map((chat) => (
          <div key={chat.id} className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 pr-2">
          <Link
            className="min-w-0 flex flex-1 flex-wrap justify-between gap-3 rounded-xl p-4 hover:bg-white/5"
            href={conversationHref(chat.id)}
          >
            <div className="min-w-0">
              <p className="break-words font-medium">{chat.title}</p>
              <p className="mt-1 text-sm text-zinc-400">
                With {actorsById.get(chat.actorId)?.name}
              </p>
            </div>
            <span className="text-xs text-zinc-500">
              {date(chat.updatedAt)}
            </span>
          </Link>
          <DeleteChatButton chat={chat} onDeleted={() => void chats.refresh()} />
          </div>
        ))}
        {!recent.length && !chats.loading && (
          <p className="mt-4 text-sm text-zinc-500">
            Your conversations will appear here.
          </p>
        )}
      </section>
      <section className="mt-10">
        <h2 className="text-lg font-semibold">New results</h2>
        {topLevelWork(work.data?.items ?? [])
          .filter(
            (i) =>
              i.deliveryState === "delivered" &&
              !i.isTest &&
              (!preferences.byKey.get(`work:${i.key}`)?.readAt ||
                (preferences.byKey.get(`work:${i.key}`)?.readAt ?? "") <
                  (i.updatedAt ?? "")),
          )
          .slice(0, 4)
          .map((i) => (
            <WorkRow key={i.key} item={i} />
          ))}
        <p className="mt-4 text-xs text-zinc-500">
          Delivered results are shown separately from execution and review.
          Opening a result marks that saved revision as read.
        </p>
      </section>
    </div>
  );
}
export function ConversationsScreen() {
  const preferences = useUIIndex();
  const chats = useResource<{ chats: ChatThread[] }>("/api/chats"),
    actors = useResource<{ actors: Actor[] }>("/api/actors"),
    params = useSearchParams(),
    router = useRouter();
  const query = params.get("q") ?? "",
    include = params.get("internal") === "1",
    page = Math.max(1, Number(params.get("page")) || 1);
  const byId = new Map((actors.data?.actors ?? []).map((a) => [a.id, a]));
  const list = (chats.data?.chats ?? [])
    .filter((c) => {
      const actor = byId.get(c.actorId);
      return (
        actor &&
        (include ||
          (actorAudience(actor) === "conversation" &&
            !preferences.byKey.get(`actor:${actor.id}`)?.archived &&
            !preferences.byKey.get(`chat:${c.id}`)?.archived)) &&
        `${c.title} ${actor.name}`.toLowerCase().includes(query.toLowerCase())
      );
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  function filter(q: string, all = include, p = 1) {
    const search = new URLSearchParams({ q, page: String(p) });
    if (all) search.set("internal", "1");
    router.replace(`/conversations?${search}`, { scroll: false });
  }
  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-10">
      <Heading
        title="Conversations"
        description="Find a discussion without remembering which specialist helped."
      >
        <Link href="/conversations/new" className={quiet}>
          + New conversation
        </Link>
      </Heading>
      <input
        className={input}
        aria-label="Search conversations"
        placeholder="Search conversation titles or specialists"
        value={query}
        onChange={(e) => filter(e.target.value)}
      />
      <label className="mt-4 flex min-h-11 items-center gap-2 text-sm text-zinc-400">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => filter(query, e.target.checked)}
        />{" "}
        Include internal workers and possible tests
      </label>
      <ErrorState
        error={chats.error || actors.error}
        retry={() => {
          void chats.refresh();
          void actors.refresh();
        }}
      />
      {chats.loading ? (
        <p role="status" className="mt-6">
          Loading conversations…
        </p>
      ) : (
        list.slice((page - 1) * 25, page * 25).map((chat) => (
          <div key={chat.id} className="flex items-center gap-2 border-b border-white/10">
          <Link
            href={conversationHref(chat.id)}
            className="min-w-0 flex flex-1 flex-wrap items-center justify-between gap-3 py-5"
          >
            <div className="min-w-0">
              <h2 className="break-words font-medium">{chat.title}</h2>
              <p className="mt-1 text-sm text-zinc-500">
                With {byId.get(chat.actorId)?.name}
              </p>
            </div>
            <time className="text-xs text-zinc-500">
              {date(chat.updatedAt)}
            </time>
          </Link>
          <DeleteChatButton chat={chat} onDeleted={() => void chats.refresh()} />
          </div>
        ))
      )}
      {!list.length && !chats.loading && (
        <p className="py-8 text-zinc-400">
          No matching conversations. Start a conversation or change your search.
        </p>
      )}
      <div className="mt-6 flex items-center gap-3">
        <button
          className={quiet}
          disabled={page <= 1}
          onClick={() => filter(query, include, page - 1)}
        >
          Previous
        </button>
        <span className="text-sm text-zinc-400">
          Page {page} · {list.length} conversations
        </span>
        <button
          className={quiet}
          disabled={page * 25 >= list.length}
          onClick={() => filter(query, include, page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
export function NewConversationScreen() {
  const actors = useResource<{ actors: Actor[] }>("/api/actors"),
    params = useSearchParams(),
    router = useRouter(),
    [text, setText] = useState(params.get("request") ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    guard = useRef(false);
  const creationId = useRef(crypto.randomUUID());
  const specialist = params.get("specialist");
  const actorId = params.get("actor"),
    available = (actors.data?.actors ?? []).filter(
      (a) => actorAudience(a) === "conversation",
    ),
    actor =
      available.find((a) => a.id === actorId) ??
      (!actorId
        ? available.find((a) => a.name.toLowerCase() === "katie")
        : undefined);
  async function create() {
    if (!actor || guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: await ownerConversationHeaders(),
        body: JSON.stringify({
          id: creationId.current,
          actorId: actor.id,
          title: text.trim().slice(0, 90) || "New conversation",
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw Error(payload.error ?? "Could not create conversation");
      if (text.trim())
        window.sessionStorage.setItem(
          `katie.draft.v1.${payload.chat.id}`,
          specialist
            ? `Ask ${specialist.replaceAll("_", " ")} orchestrator to ${text}`
            : text,
        );
      router.push(conversationHref(payload.chat.id));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create conversation",
      );
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <Heading
        title="What would you like to get done?"
        description={
          actor
            ? `Start with ${actor.name}${specialist ? " and the " + specialist.replaceAll("_", " ") + " specialist" : ""}. Describe your outcome; send it in the conversation when ready.`
            : "Loading available conversation specialist…"
        }
      />
      {actor?.actorKind !== "executive" && <SelfToolsOwnerSession />}
      <ErrorState error={actors.error || error} retry={actors.refresh} />
      <textarea
        autoFocus
        rows={6}
        className={input}
        aria-label="Your request"
        placeholder="Describe what you need…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <Link href="/specialists" className="text-sm text-zinc-400 underline">
          Choose a specialist
        </Link>
        <button
          className="min-h-11 rounded-xl bg-emerald-400 px-6 py-3 font-semibold text-zinc-950 disabled:opacity-40"
          disabled={busy || !actor}
          onClick={() => void create()}
        >
          {busy ? "Opening…" : "Open conversation"}
        </button>
      </div>
      {!actors.loading && !actor && (
        <p className="mt-4 text-amber-200">
          The requested specialist is unavailable. Choose an existing
          specialist.
        </p>
      )}
    </div>
  );
}
export function WorkScreen() {
  const preferences = useUIIndex();
  const work = useResource<WorkResponse>("/api/work"),
    params = useSearchParams(),
    router = useRouter(),
    filter = params.get("filter") ?? "active",
    query = params.get("q") ?? "",
    include = params.get("tests") === "1",
    page = Math.max(1, Number(params.get("page")) || 1);
  function change(key: string, value: string) {
    const p = new URLSearchParams(params.toString());
    p.set(key, value);
    if (key !== "page") p.set("page", "1");
    router.replace(`/work?${p}`, { scroll: false });
  }
  const items = topLevelWork(work.data?.items ?? []).filter(
    (i) =>
      (include ||
        (!i.isTest && !preferences.byKey.get(`work:${i.key}`)?.archived)) &&
      `${i.title} ${i.specialist} ${i.detail ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "needs" && needsYou(i)) ||
        (filter === "results" && i.deliveryState === "delivered") ||
        (filter === "active" && isActive(i))),
  );
  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-10">
      <Heading
        title="Work"
        description="Track outcomes, decisions, and delivered results in one place."
      >
        <Link href="/conversations/new" className={quiet}>
          Ask Katie
        </Link>
      </Heading>
      <div
        className="mb-5 flex flex-wrap gap-2"
        role="group"
        aria-label="Work filters"
      >
        {[
          ["active", "Active"],
          ["needs", "Needs you"],
          ["results", "Results"],
          ["all", "All"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={filter === key}
            className={`${quiet} ${filter === key ? "bg-white/10 text-white" : "text-zinc-400"}`}
            onClick={() => change("filter", key)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        className={input}
        aria-label="Search work"
        value={query}
        placeholder="Search outcomes, specialists, or details"
        onChange={(e) => change("q", e.target.value)}
      />
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-zinc-400">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => change("tests", e.target.checked ? "1" : "0")}
        />{" "}
        Include possible test runs
      </label>
      <ErrorState
        error={work.error}
        retry={work.refresh}
        checked={work.checked}
      />
      {work.data?.warnings.map((w) => (
        <p className="my-2 text-sm text-amber-200" key={w}>
          {w}
        </p>
      ))}
      {work.loading ? (
        <p role="status" className="py-6">
          Loading current work…
        </p>
      ) : (
        items
          .slice((page - 1) * 20, page * 20)
          .map((i) => <WorkRow key={i.key} item={i} />)
      )}
      {!items.length && !work.loading && (
        <p className="py-8 text-zinc-400">
          No matching work. Ask Katie for an outcome or select All to find past
          work.
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          className={quiet}
          disabled={page <= 1}
          onClick={() => change("page", String(page - 1))}
        >
          Previous
        </button>
        <span className="text-sm text-zinc-400">
          Page {page} · {items.length} outcomes
        </span>
        <button
          className={quiet}
          disabled={page * 20 >= items.length}
          onClick={() => change("page", String(page + 1))}
        >
          Next
        </button>
      </div>
      <p className="mt-6 text-xs text-zinc-500">
        Latest {work.data?.limit ?? 500} records per source. Unlinked legacy
        missions and complete technical history remain in{" "}
        <Link href="/settings/advanced" className="underline">
          Advanced
        </Link>
        . Test detection is a name-based suggestion, not verified provenance.
      </p>
    </div>
  );
}
export function WorkDetailScreen({ reference }: { reference: string }) {
  const saved = useSavedState(`work:${reference}`);
  const saveState = saved.save;
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (saved.state) setNotes(saved.state.value.notes ?? "");
  }, [saved.state]);
  const work = useResource<WorkResponse>("/api/work"),
    params = useSearchParams(),
    router = useRouter(),
    tab = params.get("tab") ?? "overview",
    item = work.data?.items.find(
      (i) => i.key === decodeURIComponent(reference),
    ),
    children = work.data?.items.filter((i) => i.parentKey === reference) ?? [];
  useEffect(() => {
    if (
      tab === "results" &&
      saved.state &&
      (!saved.state.value.readAt ||
        (saved.state.value.readAt ?? "") < (item?.updatedAt ?? ""))
    )
      void saveState({ readAt: new Date().toISOString() });
  }, [tab, saved.state, saveState, item?.updatedAt]);
  const [activity, setActivity] = useState<
      Array<{
        id: string;
        role: string;
        status: string;
        detail?: string;
        result?: unknown;
      }>
    >([]),
    [activityError, setActivityError] = useState("");
  useEffect(() => {
    if (!item || item.source !== "mission") return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/missions?id=${encodeURIComponent(item.id)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw Error("Activity unavailable");
        const payload = await response.json();
        if (active) {
          setActivity(payload.jobs ?? []);
          setActivityError("");
        }
      } catch {
        if (active)
          setActivityError(
            "Activity unavailable. The saved outcome remains intact.",
          );
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [item]);
  if (work.loading)
    return (
      <p role="status" className="p-8">
        Loading work…
      </p>
    );
  if (!item)
    return (
      <div className="p-8">
        <ErrorState error={work.error} retry={work.refresh} />
        <h1 className="text-xl">Work item unavailable</h1>
        <p className="mt-2 text-zinc-400">
          It may be outside the current inventory or unavailable to this
          workspace.
        </p>
        <Link className={`${quiet} mt-4`} href="/work?filter=all">
          Open all work
        </Link>
        <Link
          className={`${quiet} ml-2`}
          href={`/settings/advanced?${reference.startsWith("mission:") ? "mission" : "task"}=${encodeURIComponent(reference.split(":").at(-1) ?? "")}`}
        >
          Legacy history
        </Link>
      </div>
    );
  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-10">
      <Link href="/work" className="mb-6 inline-block text-sm text-zinc-400">
        ← Work
      </Link>
      <Heading
        title={
          item.title.length > 160 ? item.title.slice(0, 160) + "…" : item.title
        }
        description={`${item.specialist} · Updated ${date(item.updatedAt)}`}
      >
        <Status item={item} />
      </Heading>
      <ErrorState
        error={work.error}
        retry={work.refresh}
        checked={work.checked}
      />
      {item.chatId && (
        <Link
          className="mb-6 inline-block text-emerald-300 underline"
          href={conversationHref(item.chatId)}
        >
          Open original conversation →
        </Link>
      )}
      {item.source === "task" && (
        <Link
          className={`${quiet} mb-4`}
          href={`/settings/advanced?task=${encodeURIComponent(item.id)}`}
        >
          Manage saved task
        </Link>
      )}
      {item.source === "mission" && (
        <PendingMissionApprovals missionId={item.id} />
      )}
      <nav
        className="mb-7 flex flex-wrap gap-2"
        aria-label="Work detail sections"
      >
        {["overview", "conversation", "results", "activity"].map((name) => (
          <button
            key={name}
            aria-current={tab === name ? "page" : undefined}
            className={`${quiet} capitalize ${tab === name ? "bg-white/10" : ""}`}
            onClick={() => {
              const p = new URLSearchParams(params.toString());
              p.set("tab", name);
              router.replace(`${workHref(item.source, item.id)}?${p}`, {
                scroll: false,
              });
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <div className="space-y-6">
          <section className="rounded-xl border border-white/10 p-5">
            <h2 className="font-semibold">Requested outcome</h2>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-zinc-300">
              {item.title}
            </p>
          </section>
          <section>
            <h2 className="font-semibold">Current state</h2>
            <p className="mt-2 text-zinc-300">
              {item.phase.replaceAll("_", " ")}
            </p>
            <p className="mt-2 text-sm text-zinc-400">
              {item.detail ??
                "No further detail recorded. Open the original conversation for the approved scope."}
            </p>
            {needsYou(item) && item.chatId && (
              <Link
                className={`${quiet} mt-4`}
                href={conversationHref(item.chatId)}
              >
                {item.status === "awaiting_approval"
                  ? "Review scope"
                  : "Open question or blocker"}
              </Link>
            )}
            <p className="mt-3 text-xs text-zinc-500">
              Execution: {item.status}
              {item.coordinationState
                ? ` · Coordination: ${item.coordinationState}`
                : ""}{" "}
              · Review: {item.reviewState} · Delivery: {item.deliveryState}
            </p>
          </section>
          <section className="space-y-3">
            <button
              className={quiet}
              disabled={!saved.state || saved.saving}
              onClick={() =>
                void saved.save({ archived: !saved.state?.value.archived })
              }
            >
              {saved.state?.value.archived
                ? "Restore in Work list"
                : "Hide from daily Work list"}
            </button>
            <h2 className="font-semibold">Work notes</h2>
            <textarea
              className={input}
              aria-label="Work notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={12000}
            />
            <button
              className={quiet}
              disabled={!saved.state || saved.saving}
              onClick={() => void saved.save({ notes })}
            >
              {saved.saving ? "Saving…" : "Save notes"}
            </button>
            <p className="text-xs text-zinc-500">
              Saved with this work item. Notes are not silently added to another
              specialist’s context.
            </p>
            {saved.error && (
              <p role="alert" className="text-sm text-amber-200">
                {saved.error}
              </p>
            )}
          </section>
          {children.length > 0 && (
            <section>
              <h2 className="font-semibold">Linked activity</h2>
              {children.map((c) => (
                <WorkRow key={c.key} item={c} />
              ))}
            </section>
          )}
        </div>
      )}
      {tab === "conversation" && (
        <section>
          <h2 className="font-semibold">Continue in the original discussion</h2>
          <p className="my-3 text-sm text-zinc-400">
            Follow-ups stay with this outcome and its existing context.
          </p>
          {item.chatId && (
            <Link className={quiet} href={conversationHref(item.chatId)}>
              Open conversation
            </Link>
          )}
        </section>
      )}
      {tab === "results" && (
        <section>
          <h2 className="font-semibold">Saved result</h2>
          <p className="my-3 text-sm text-zinc-400">
            {item.deliveryState === "pending"
              ? "Execution completed; delivery to the original conversation is still pending."
              : item.reviewState}
          </p>
          {item.result ? (
            <>
              <div className="whitespace-pre-wrap break-words rounded-xl border border-white/10 p-5 text-sm leading-7">
                {item.result}
              </div>
              <button
                className={`${quiet} mt-4`}
                onClick={() =>
                  void navigator.clipboard.writeText(item.result ?? "")
                }
              >
                Copy result
              </button>
            </>
          ) : (
            <p className="text-sm text-zinc-500">
              Open the original conversation to inspect files, review evidence,
              and any draft PR. A draft PR is distinct from a production
              release.
            </p>
          )}
        </section>
      )}
      {tab === "activity" && (
        <section>
          <h2 className="mb-4 font-semibold">Handoffs and checks</h2>
          {activityError && (
            <p role="alert" className="text-amber-200">
              {activityError}
            </p>
          )}
          {activity.map((a) => (
            <details
              key={a.id}
              className="mb-3 rounded-xl border border-white/10 p-4"
            >
              <summary className="cursor-pointer capitalize">
                {a.role} · {a.status}
              </summary>
              <p className="mt-3 text-sm">{a.detail}</p>
              {a.result != null && (
                <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-400">
                  {JSON.stringify(a.result, null, 2)}
                </pre>
              )}
            </details>
          ))}
          {children.map((c) => (
            <WorkRow key={c.key} item={c} />
          ))}
          {!activity.length && !children.length && (
            <p className="text-sm text-zinc-400">
              Detailed activity is available in the original conversation or
              Advanced history.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
export function SpecialistsScreen({ id }: { id?: string }) {
  return <SpecialistDirectory id={id} />;
}
export function SettingsScreen() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-10">
      <Notepad />
      <Heading
        title="Settings"
        description="Connections, context, preferences, and expert controls."
      />
      {[
        [
          "Connections",
          "Select repository source in a conversation’s Context panel. Connecting a repository never authorizes code changes.",
        ],
        [
          "Preferences",
          "Model selection is Automatic unless you explicitly override it in conversation settings.",
        ],
        [
          "Memory and context",
          "Conversation history and actor memory keep their existing boundaries. Context is visible within each conversation.",
        ],
        [
          "Usage",
          "Execution limits remain enforced by existing workflows. No additional dollar or token cap is implied.",
        ],
        [
          "Personal notes",
          "The Notes tool stores notes in this browser only. It does not automatically attach them to work.",
        ],
      ].map(([title, description]) => (
        <section key={title} className="border-b border-white/10 py-5">
          <h2 className="font-semibold">{title}</h2>
          {title === "Connections" && (
            <Link
              className="mt-2 inline-block min-h-11 py-3 text-sm text-emerald-300 underline"
              href="/settings/connections"
            >
              Manage connections
            </Link>
          )}
          <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
        </section>
      ))}
      <section className="py-6">
        <h2 className="font-semibold">Advanced</h2>
        <p className="my-3 text-sm text-zinc-400">
          Internal workers, saved assignments, recovery history, and raw
          configuration.
        </p>
        <Link href="/settings/advanced" className={quiet}>
          Open Advanced
        </Link>
        <Link href="/legacy" className={`${quiet} ml-2`}>
          Previous interface
        </Link>
      </section>
    </div>
  );
}
