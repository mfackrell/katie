"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useResource } from "@/components/workspace-data";
import { actorAudience } from "@/lib/ui/work";
import { conversationHref } from "@/lib/ui/links";
import type { Actor, ChatThread } from "@/lib/types/chat";
import type { UIState } from "@/components/saved-workspace-state";
import type { ManagedAgent } from "@/lib/agents/policy";

type Registry = {
  id: string;
  actor_id: string;
  slug: string;
  title: string;
  description: string;
  capabilities: string[];
  status: string;
  adapter: string;
  version: number;
};
type Card = {
  id: string;
  actor: Actor;
  name: string;
  description: string;
  kind: "executive" | "orchestrator" | "single" | "worker";
  registry?: Registry;
  managed?: ManagedAgent;
};
const button =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-40";
const field =
  "mt-2 w-full rounded-lg border border-white/15 bg-zinc-900 p-3 text-sm";
async function change(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error ?? "The change could not be saved.");
  return data;
}

function AgentControls({
  card,
  actors,
  onChanged,
}: {
  card: Card;
  actors: Actor[];
  onChanged: () => void;
}) {
  const [instructions, setInstructions] = useState(
    card.managed?.config.instructions ?? card.actor.purpose,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    setInstructions(card.managed?.config.instructions ?? card.actor.purpose);
  }, [card.actor.purpose, card.managed?.config.instructions]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (card.managed)
        await change("/api/agents", "POST", {
          id: card.managed.id,
          config: { ...card.managed.config, instructions },
        });
      else
        await change(
          `/api/actors?id=${encodeURIComponent(card.actor.id)}`,
          "PATCH",
          { purpose: instructions },
        );
      setNotice("System instructions saved.");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const descendants = new Set([card.actor.id]);
    let size = 0;
    while (size !== descendants.size) {
      size = descendants.size;
      for (const actor of actors)
        if (actor.parentId && descendants.has(actor.parentId))
          descendants.add(actor.id);
    }
    const message = card.registry
      ? `Remove “${card.name}” from available orchestrators? New assignments will be disabled. Existing assignments, chats and history will be retained.`
      : card.managed
        ? `Remove “${card.name}” from available workers? Its saved tasks and history will be retained.`
        : `Permanently delete “${card.actor.name}”${descendants.size > 1 ? ` and ${descendants.size - 1} child agents` : ""}, including their chats and memory? This cannot be undone.`;
    if (!window.confirm(message)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (card.registry)
        await change(
          `/api/specialists?id=${encodeURIComponent(card.registry.id)}&version=${card.registry.version}`,
          "DELETE",
        );
      else if (card.managed)
        await change("/api/agents", "POST", {
          id: card.managed.id,
          config: card.managed.config,
          archive: true,
        });
      else
        await change(
          `/api/actors?id=${encodeURIComponent(card.actor.id)}`,
          "DELETE",
        );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="mt-4 rounded-lg border border-white/15 p-3">
      <summary className="cursor-pointer text-sm">
        System instructions & agent settings
      </summary>
      <form onSubmit={(event) => void save(event)} className="mt-4 space-y-3">
        <label className="block text-sm">
          {card.registry
            ? `Shared coordinator system instructions · ${card.actor.name}`
            : "System instructions"}
          <textarea
            aria-label={`System instructions for ${card.name}`}
            className={field}
            rows={10}
            required
            maxLength={card.managed ? 12000 : undefined}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        {card.registry && (
          <p className="text-xs leading-5 text-zinc-400">
            These instructions belong to {card.actor.name} and are shared by its
            conversations and orchestrators. Team workers have separate
            versioned instructions below in Internal task agents.
          </p>
        )}
        <button
          className={button}
          disabled={busy || !instructions.trim() || !!card.managed?.archived}
        >
          {busy ? "Saving…" : "Save system instructions"}
        </button>
        <button
          type="button"
          className={`${button} ml-2 text-red-300`}
          disabled={busy || !!card.managed?.archived}
          onClick={() => void remove()}
        >
          {card.registry
            ? "Remove orchestrator"
            : card.managed
              ? "Remove worker"
              : "Delete agent"}
        </button>
        {card.registry && (
          <p className="text-xs text-zinc-400">
            A specialist orchestrator is a registered team capability, not a
            separate chat identity. Its configuration and saved assignments
            remain available in{" "}
            <Link className="underline" href="/settings/advanced">
              Advanced management
            </Link>
            .
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-emerald-300">
            {notice}
          </p>
        )}
      </form>
    </details>
  );
}

function AgentCard({
  card,
  actors,
  chats,
  archived,
  onChanged,
  detail = false,
}: {
  card: Card;
  actors: Actor[];
  chats: ChatThread[];
  archived: Set<string>;
  onChanged: () => void;
  detail?: boolean;
}) {
  const router = useRouter();
  const active = chats
    .filter((chat) => chat.actorId === card.actor.id && !archived.has(chat.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const href = `/conversations/new?actor=${encodeURIComponent(card.actor.id)}${card.registry ? `&specialist=${encodeURIComponent(card.registry.slug)}` : ""}`;
  return (
    <article className="min-w-0 rounded-xl border border-white/10 p-5">
      <p className="text-xs font-medium text-emerald-300">
        {card.kind === "executive"
          ? "Executive · creates and manages autonomous specialists"
          : card.kind === "orchestrator"
          ? "Specialist orchestrator · coordinates a team"
          : card.kind === "worker"
            ? "Internal task agent · isolated worker"
            : "Single-task agent · direct conversation"}
        {card.registry && card.registry.status !== "active"
          ? ` · ${card.registry.status}`
          : ""}
      </p>
      <h2 className="mt-2 text-lg font-semibold">{card.name}</h2>
      <p className="my-3 break-words text-sm leading-6 text-zinc-400">
        {card.description}
      </p>
      <label className="block text-sm">
        {card.registry
          ? `Active chats with ${card.actor.name} (shared coordinator)`
          : "Active chats"}
        <select
          aria-label={`Active chats for ${card.name}`}
          className={field}
          value=""
          disabled={!active.length}
          onChange={(event) => {
            if (event.target.value)
              router.push(conversationHref(event.target.value));
          }}
        >
          <option value="">
            {active.length
              ? `Choose a chat (${active.length})`
              : "No active chats"}
          </option>
          {active.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        {card.kind !== "worker" &&
          (!card.registry || card.registry.status === "active") && (
            <Link className={button} href={href}>
              New chat
            </Link>
          )}
        {!detail && (
          <Link
            className={button}
            href={`/specialists/${encodeURIComponent(card.id)}`}
          >
            About
          </Link>
        )}
        {card.kind === "worker" && (
          <Link className={button} href="/settings/advanced">
            Saved tasks
          </Link>
        )}
      </div>
      {detail && !!card.registry?.capabilities.length && (
        <p className="mt-4 text-sm text-zinc-400">
          Capabilities:{" "}
          {card.registry.capabilities
            .map((value) => value.replaceAll("_", " "))
            .join(", ")}
        </p>
      )}
      {card.kind === "executive" ? (
        <p className="mt-4 text-xs text-zinc-400">System identity. Management rules are enforced by the Executive runtime, not editable chatbot instructions.</p>
      ) : <AgentControls card={card} actors={actors} onChanged={onChanged} />}
    </article>
  );
}

export function SpecialistDirectory({ id }: { id?: string }) {
  const router = useRouter();
  const actors = useResource<{ actors: Actor[] }>("/api/actors"),
    registry = useResource<{ specialists: Registry[] }>("/api/specialists"),
    chats = useResource<{ chats: ChatThread[] }>("/api/chats"),
    saved = useResource<{ states: UIState[] }>("/api/ui-state"),
    managed = useResource<{ agents: ManagedAgent[] }>("/api/agents");
  const [query, setQuery] = useState(""),
    [creating, setCreating] = useState(false),
    [kind, setKind] = useState("single"),
    [name, setName] = useState(""),
    [purpose, setPurpose] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const all = actors.data?.actors ?? [],
    entries = registry.data?.specialists ?? [];
  const state = new Map(
    (saved.data?.states ?? []).map((value) => [value.key, value.value]),
  );
  const archived = new Set(
    (saved.data?.states ?? [])
      .filter((value) => value.key.startsWith("chat:") && value.value.archived)
      .map((value) => value.key.slice(5)),
  );
  
  const cards: Card[] = all
    .filter((actor) => !actor.managedAgentId)
    .map((actor) => {
      const executive = actor.actorKind === "executive";
      return {
        id: `persona:${actor.id}`,
        actor,
        name: executive ? "Executive Orchestrator" : actor.name,
        kind: executive ? "executive" : "single",
        description: executive
          ? "Coordinates specialist orchestrators and their independently reviewed teams. Continue an existing discussion or start a new assignment."
          : state.get(`actor:${actor.id}`)?.summary ||
            actor.routingProfile?.summary ||
            "An individual agent with its own instructions and conversation memory.",
      };
    });
  for (const entry of entries) {
    const actor = all.find((actor) => actor.id === entry.actor_id);
    if (actor?.actorKind === "executive" && entry.status !== "retired")
      cards.push({
        id: `capability:${entry.id}`,
        actor,
        name: entry.title,
        description: entry.description,
        kind: "orchestrator",
        registry: entry,
      });
  }
  for (const worker of managed.data?.agents ?? []) {
    const actor = all.find((actor) => actor.id === worker.actor_id);
    if (actor && !worker.archived)
      cards.push({
        id: `persona:${actor.id}`,
        actor,
        name: worker.config.name,
        description:
          "Runs isolated, bounded tasks with saved instructions. Managed tasks retain their original instruction snapshots.",
        kind: "worker",
        managed: worker,
      });
  }
  const selected = cards.find((card) => card.id === id);
  function refresh() {
    void actors.refresh();
    void managed.refresh();
    void chats.refresh();
    void registry.refresh();
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (kind === "orchestrator") {
      const executive = all.find((actor) => actor.actorKind === "executive");
      if (!executive) {
        setError("Executive is unavailable. Reload the directory.");
        return;
      }
      router.push(
        `/conversations/new?actor=${encodeURIComponent(executive.id)}&request=${encodeURIComponent(`Create a ${name.trim()} orchestrator`)}`,
      );
      return;
    }
    setBusy(true);
    try {
      await change("/api/actors", "POST", {
        name: name.trim(),
        purpose: purpose.trim(),
        reviewMode: "always",
      });
      setCreating(false);
      setName("");
      setPurpose("");
      refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Agent creation failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const errors = [
    actors.error,
    registry.error,
    chats.error,
    saved.error,
    managed.error,
  ].filter(Boolean);
  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">
            {selected?.name ?? "Specialists"}
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Orchestrators coordinate teams. Single-task agents work directly
            with you.
          </p>
        </div>
        <button className={button} onClick={() => setCreating(!creating)}>
          + Create agent
        </button>
      </header>
      {!!errors.length && (
        <div
          role="alert"
          className="mb-5 rounded-xl border border-amber-400/30 p-4 text-sm text-amber-200"
        >
          Some directory data could not load.{" "}
          <button
            className="underline"
            onClick={() => {
              refresh();
              void saved.refresh();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {creating && (
        <form
          onSubmit={(event) => void create(event)}
          className="mb-7 space-y-4 rounded-xl border border-emerald-400/30 p-5"
        >
          <h2 className="font-semibold">Create agent</h2>
          <label className="block text-sm">
            Agent type
            <select
              className={field}
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="single">Single-task agent</option>
              <option value="orchestrator">Specialist orchestrator</option>
            </select>
          </label>
          <label className="block text-sm">
            {kind === "orchestrator"
              ? "Specialty (for example, research)"
              : "Agent name"}
            <input
              className={field}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {kind === "single" ? (
            <label className="block text-sm">
              System instructions
              <textarea
                className={field}
                rows={7}
                required
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </label>
          ) : (
            <p className="text-sm text-zinc-400">
              Continue with Executive to provision and independently test the
              team. Review and send the request in the new conversation;
              unsupported capabilities remain pending.
            </p>
          )}
          <button className={button} disabled={busy}>
            {busy
              ? "Creating…"
              : kind === "single"
                ? "Create single-task agent"
                : "Continue with Executive"}
          </button>
          <button
            type="button"
            className={`${button} ml-2`}
            onClick={() => setCreating(false)}
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-red-300">
              {error}
            </p>
          )}
        </form>
      )}
      {id ? (
        selected ? (
          <>
            <AgentCard
              card={selected}
              actors={all}
              chats={chats.data?.chats ?? []}
              archived={archived}
              onChanged={refresh}
              detail
            />
            <Link className={`${button} mt-5`} href="/specialists">
              Back to specialists
            </Link>
          </>
        ) : (
          <p>
            {actors.loading || registry.loading
              ? "Loading specialist…"
              : "Specialist unavailable."}{" "}
            <Link href="/specialists" className="underline">
              Open catalog
            </Link>
          </p>
        )
      ) : (
        <>
          <input
            className={field}
            aria-label="Search specialists"
            placeholder="Search agents or capabilities"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {(["executive", "orchestrator", "single", "worker"] as const).map((group) => {
            const visible = cards.filter(
              (card) =>
                card.kind === group &&
                `${card.name} ${card.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()) &&
                (group !== "single" ||
                  (actorAudience(card.actor) === "conversation" &&
                    !state.get(`actor:${card.actor.id}`)?.archived &&
                    !["test", "worker"].includes(
                      state.get(`actor:${card.actor.id}`)?.audience ?? "",
                    ))),
            );
            const content = (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {visible.map((card) => (
                  <AgentCard
                    key={card.id}
                    card={card}
                    actors={all}
                    chats={chats.data?.chats ?? []}
                    archived={archived}
                    onChanged={refresh}
                  />
                ))}
                {!visible.length && (
                  <p className="text-sm text-zinc-500">
                    {actors.loading ? "Loading agents…" : "No matching agents."}
                  </p>
                )}
              </div>
            );
            return group === "worker" ? (
              <details
                key={group}
                className="mt-9 rounded-xl border border-white/10 p-5"
              >
                <summary className="cursor-pointer font-semibold">
                  Internal task agents ({visible.length})
                </summary>
                <p className="mt-2 text-sm text-zinc-400">
                  Team workers are kept separate from agents you chat with
                  directly.
                </p>
                {content}
              </details>
            ) : (
              <section
                key={group}
                className="mt-9"
                aria-label={
                  group === "executive" ? "Executive Orchestrator" : group === "orchestrator"
                    ? "Specialist Orchestrators"
                    : "Single-task agents"
                }
              >
                <h2 className="text-xl font-semibold">
                  {group === "executive" ? "Executive Orchestrator" : group === "orchestrator"
                    ? "Specialist Orchestrators"
                    : "Single-task agents"}
                </h2>
                {content}
              </section>
            );
          })}
          <Link href="/settings/advanced" className={`${button} mt-6`}>
            Advanced assignments & history
          </Link>
        </>
      )}
    </div>
  );
}
