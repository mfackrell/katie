"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { Actor, ChatThread } from "@/lib/types/chat";

interface SidebarProps {
  actors: Actor[];
  chats: ChatThread[];
  activeActorId: string;
  activeChatId: string;
  onSelectActor: (actorId: string) => void;
  onSelectChat: (chatId: string) => void;
  onCreateChat: (actorId: string) => Promise<void>;
  onOpenCreateActor: () => void;
  onOpenCreateSubActor: (actor: Actor) => void;
  onDeleteActor: (actor: Actor) => void;
  onDeleteChat: (chat: ChatThread) => void | Promise<void>;
  onRenameChat: (chatId: string, title: string) => void | Promise<void>;
  onError: (message: string) => void;
  onActorPurposeUpdated: (actor: Actor) => void;
  isCreatingChat: (actorId: string) => boolean;
}

export function Sidebar({
  actors,
  chats,
  activeActorId,
  activeChatId,
  onSelectActor,
  onSelectChat,
  onCreateChat,
  onOpenCreateActor,
  onOpenCreateSubActor,
  onDeleteActor,
  onDeleteChat,
  onRenameChat,
  onError,
  onActorPurposeUpdated,
  isCreatingChat,
}: SidebarProps) {
  const sortedActors = [...actors].sort((a, b) => a.name.localeCompare(b.name));
  const activeActor = actors.find((actor) => actor.id === activeActorId) ?? null;
  const [editing, setEditing] = useState(false);
  const [draftPurpose, setDraftPurpose] = useState(activeActor?.purpose ?? "");
  const [saving, setSaving] = useState(false);
  const [editingChatId, setEditingChatId] = useState("");
  const [draftChatTitle, setDraftChatTitle] = useState("");
  const [savingChatId, setSavingChatId] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoConnectLoading, setRepoConnectLoading] = useState(false);
  const [repoConnectError, setRepoConnectError] = useState("");
  const [repoConnectResult, setRepoConnectResult] = useState<{
    message: string;
    repoId?: string;
    response?: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    setDraftPurpose(activeActor?.purpose ?? "");
    setEditing(false);
    setSaving(false);
  }, [activeActorId, activeActor?.purpose]);

  useEffect(() => {
    if (!editingChatId) {
      return;
    }

    if (!chats.some((chat) => chat.id === editingChatId)) {
      setEditingChatId("");
      setDraftChatTitle("");
    }
  }, [chats, editingChatId]);

  async function handleSave() {
    if (!activeActor || !draftPurpose.trim()) {
      return;
    }

    setSaving(true);
    onActorPurposeUpdated({ ...activeActor, purpose: draftPurpose.trim() });

    try {
      const response = await fetch(`/api/actors?id=${encodeURIComponent(activeActor.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: draftPurpose.trim() }),
      });

      if (response.ok) {
        const payload = (await response.json()) as { actor?: Actor; error?: string };
        if (payload.actor) {
          onActorPurposeUpdated(payload.actor);
          setEditing(false);
          setDraftPurpose(payload.actor.purpose);
        }
      } else {
        const payload = (await response.json()) as { error?: string };
        onError(payload.error ?? "Failed to update system prompt.");
        onActorPurposeUpdated(activeActor);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update system prompt.";
      onError(message);
      onActorPurposeUpdated(activeActor);
    } finally {
      setSaving(false);
    }
  }

  async function handleRepoConnectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedRepoName = repoName.trim();
    if (!normalizedRepoName) {
      setRepoConnectError("Repository name is required.");
      setRepoConnectResult(null);
      return;
    }

    setRepoConnectLoading(true);
    setRepoConnectError("");
    setRepoConnectResult(null);

    try {
      const response = await fetch("/admin/repos/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: normalizedRepoName }),
      });

      let payload: {
        ok?: boolean;
        message?: string;
        error?: string;
        repo_id?: string;
        response?: Record<string, unknown>;
      } = {};
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        payload = (await response.json()) as typeof payload;
      } else {
        const rawBody = await response.text();
        payload = rawBody.trim() ? { error: rawBody } : {};
      }

      if (!response.ok || payload.ok === false) {
        setRepoConnectError(payload.error ?? payload.message ?? "Failed to connect repository.");
        return;
      }

      const responseBody = payload.response ?? {};
      const repoIdValue = payload.repo_id ?? extractRepoId(responseBody);

      setRepoConnectResult({
        message: payload.message ?? "Repository connected successfully.",
        repoId: repoIdValue,
        response: responseBody,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect repository.";
      setRepoConnectError(message);
    } finally {
      setRepoConnectLoading(false);
    }
  }

  function extractRepoId(value: Record<string, unknown>): string | undefined {
    const candidate = value.repo_id;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  }

  return (
    <aside className="relative flex h-full min-h-0 w-full flex-col bg-gradient-to-b from-white/[0.03] via-zinc-950/40 to-zinc-950/80 p-4 sm:p-5">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-sky-400/10 to-transparent" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mb-5 rounded-3xl border border-white/10 bg-white/[0.035] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.25)] backdrop-blur-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-zinc-500">Control plane</p>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-white">Actors</h1>
              <p className="mt-1 text-xs text-zinc-400">Curate specialist routes, branches, and active conversations.</p>
            </div>
            <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
              {sortedActors.length}
            </div>
          </div>
          <button
            className="inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-r from-sky-500 to-emerald-500 px-3 py-2.5 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(16,185,129,0.25)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            onClick={onOpenCreateActor}
          >
            + Create New Actor
          </button>
        </div>

        {activeActor ? (
          <section className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <button
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-xs font-medium text-zinc-300 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white"
              onClick={() => setEditing(true)}
              aria-label="Edit system instruction"
            >
              Edit system instruction
            </button>
          </section>
        ) : null}

        <section className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
            GitHub Repo Connect
          </p>
          <form className="mt-3 space-y-2.5" onSubmit={handleRepoConnectSubmit}>
            <input
              className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-emerald-400"
              type="text"
              value={repoName}
              onChange={(event) => setRepoName(event.target.value)}
              placeholder="mfackrell/katie"
              aria-label="GitHub repository full name"
              disabled={repoConnectLoading}
            />
            <button
              className="inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 transition hover:border-emerald-400/50 hover:bg-emerald-500/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={repoConnectLoading}
            >
              {repoConnectLoading ? "Connecting..." : "Connect GitHub Repo"}
            </button>
          </form>
          {repoConnectError ? (
            <p className="mt-2 text-xs text-red-300">{repoConnectError}</p>
          ) : null}
          {repoConnectResult ? (
            <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs text-emerald-100">
              <p>{repoConnectResult.message}</p>
              {repoConnectResult.repoId ? <p className="mt-1">repo_id: {repoConnectResult.repoId}</p> : null}
              {repoConnectResult.response ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[11px] text-zinc-200">
                  {JSON.stringify(repoConnectResult.response, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </section>

        <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4 pr-1">
          {sortedActors.map((actor) => {
            const actorChats = chats.filter((chat) => chat.actorId === actor.id);
            const activeActor = actor.id === activeActorId;
            const isSubActor = Boolean(actor.parentId);
            const creatingChat = isCreatingChat(actor.id);

            return (
              <div
                key={actor.id}
                className={[
                  "group rounded-3xl border p-3 shadow-[0_14px_40px_rgba(0,0,0,0.18)] transition duration-200",
                  activeActor
                    ? "border-emerald-400/30 bg-gradient-to-br from-emerald-500/12 via-zinc-900/95 to-zinc-950 ring-1 ring-emerald-400/20"
                    : "border-white/8 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.05]",
                  isSubActor ? "ml-2 sm:ml-4" : "",
                ].join(" ")}
              >
                <div className="flex flex-col gap-3 px-1 py-1 sm:flex-row sm:items-start sm:justify-between">
                  <button className="min-w-0 flex-1 text-left" onClick={() => onSelectActor(actor.id)}>
                    <div className="flex items-center gap-2">
                      {isSubActor ? (
                        <span className="text-xs text-emerald-300/80">↳</span>
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-sky-400/80 shadow-[0_0_16px_rgba(56,189,248,0.55)]" />
                      )}
                      <span className={`break-words text-sm font-semibold tracking-tight ${activeActor ? "text-white" : "text-zinc-200"}`}>
                        {actor.name}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-zinc-500">
                      {actor.purpose || "Focused branch inheriting parent behavior."}
                    </p>
                  </button>
                  <div className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-col sm:items-end">
                    <button
                      className="min-h-10 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
                      onClick={async () => {
                        try {
                          await onCreateChat(actor.id);
                        } catch (error) {
                          const message =
                            error instanceof Error ? error.message : "Failed to create chat.";
                          onError(message);
                        }
                      }}
                      title={`New chat for ${actor.name}`}
                      disabled={creatingChat}
                    >
                      {creatingChat ? "Creating..." : "New Chat"}
                    </button>
                    <button
                      className="min-h-10 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white"
                      onClick={() => onOpenCreateSubActor(actor)}
                      title={`Branch from ${actor.name}`}
                    >
                      Branch
                    </button>
                    <button
                      className="min-h-10 rounded-xl border border-red-500/20 bg-red-500/5 px-2.5 py-1 text-[11px] font-medium text-red-200 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-white"
                      onClick={() => onDeleteActor(actor)}
                      title={`Delete ${actor.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-3 border-t border-white/8 pt-3">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">Chats</span>
                    <span className="text-[10px] text-zinc-600">{actorChats.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {actorChats.map((chat) => {
                      const activeChat = chat.id === activeChatId;
                      const isEditingTitle = editingChatId === chat.id;
                      const isSavingTitle = savingChatId === chat.id;
                      return (
                        <div
                          key={chat.id}
                          className={[
                            "flex items-center gap-2 rounded-2xl px-3 py-2 text-xs transition",
                            activeChat
                              ? "border border-white/10 bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                              : "border border-transparent text-zinc-400 hover:border-white/8 hover:bg-white/[0.04] hover:text-zinc-200",
                          ].join(" ")}
                        >
                          {isEditingTitle ? (
                            <div className="flex flex-1 items-center gap-2">
                              <input
                                className="h-8 min-w-0 flex-1 rounded-lg border border-white/15 bg-zinc-900/80 px-2 text-xs text-white outline-none ring-emerald-400/40 placeholder:text-zinc-500 focus:ring-2"
                                value={draftChatTitle}
                                onChange={(event) => setDraftChatTitle(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                disabled={isSavingTitle}
                                maxLength={120}
                                autoFocus
                              />
                              <button
                                className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-200 transition hover:border-emerald-400/45 hover:bg-emerald-500/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isSavingTitle}
                                onClick={async (event) => {
                                  event.stopPropagation();
                                  const nextTitle = draftChatTitle.trim();
                                  if (!nextTitle) {
                                    onError("Chat title cannot be empty.");
                                    return;
                                  }

                                  try {
                                    setSavingChatId(chat.id);
                                    await onRenameChat(chat.id, nextTitle);
                                    setEditingChatId("");
                                    setDraftChatTitle("");
                                  } catch (error) {
                                    const message = error instanceof Error ? error.message : "Failed to rename chat.";
                                    onError(message);
                                  } finally {
                                    setSavingChatId("");
                                  }
                                }}
                                title="Save title"
                              >
                                Save
                              </button>
                              <button
                                className="rounded-lg border border-white/15 bg-white/[0.04] px-2 py-1 text-[10px] font-medium text-zinc-300 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isSavingTitle}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditingChatId("");
                                  setDraftChatTitle("");
                                }}
                                title="Cancel"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="block flex-1 text-left"
                              onClick={() => {
                                onSelectActor(actor.id);
                                onSelectChat(chat.id);
                              }}
                            >
                              <span className="block truncate font-medium">{chat.title}</span>
                            </button>
                          )}
                          <button
                            className="rounded-lg border border-white/15 bg-white/[0.04] px-2 py-1 text-[10px] font-medium text-zinc-300 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditingChatId(chat.id);
                              setDraftChatTitle(chat.title);
                            }}
                            disabled={isEditingTitle}
                            title={`Rename ${chat.title}`}
                          >
                            Edit
                          </button>
                          <button
                            className="rounded-lg border border-red-500/20 bg-red-500/5 px-2 py-1 text-[10px] font-medium text-red-200 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-white"
                            onClick={(event) => {
                              event.stopPropagation();
                              void onDeleteChat(chat);
                            }}
                            title={`Delete ${chat.title}`}
                          >
                            Delete
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </nav>
      </div>

      {activeActor && editing ? (
        <div className="fixed inset-0 z-50 flex min-h-screen items-center justify-center bg-black/80 p-4 backdrop-blur-md sm:p-6">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_35%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.1),transparent_32%)]" />
          <div className="relative flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-zinc-950/95 shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.04] via-transparent to-transparent" />
            <div className="relative flex items-start justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-7">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-zinc-500">Actor setup</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Edit System Instruction</h2>
                <p className="mt-2 text-sm text-zinc-400">Tune this actor&apos;s behavior and execution context without changing any backend logic.</p>
              </div>
              <button
                className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraftPurpose(activeActor.purpose);
                }}
                aria-label="Close editor"
              >
                Close
              </button>
            </div>

            <div className="relative flex min-h-0 flex-1 flex-col px-5 py-5 sm:px-7">
              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Purpose / System Prompt</label>
              <textarea
                className="min-h-0 flex-1 resize-none rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm leading-7 text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                value={draftPurpose}
                onChange={(event) => setDraftPurpose(event.target.value)}
                aria-label="System prompt"
              />
            </div>

            <div className="relative flex justify-end gap-3 border-t border-white/10 px-5 py-5 sm:px-7">
              <button
                className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraftPurpose(activeActor.purpose);
                }}
                aria-label="Cancel"
              >
                Cancel
              </button>
              <button
                className="rounded-2xl border border-emerald-400/40 bg-gradient-to-r from-sky-500 to-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(14,165,233,0.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={saving}
                onClick={handleSave}
                aria-label="Save"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
