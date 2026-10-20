export type WorkSource = "project" | "mission" | "task";
export type WorkItem = {
  key: string;
  source: WorkSource;
  id: string;
  title: string;
  status: string;
  coordinationState?: string;
  phase: string;
  detail: string | null;
  updatedAt: string | null;
  chatId: string | null;
  specialist: string;
  parentKey: string | null;
  isTest: boolean;
  result: string | null;
  reviewState: string;
  deliveryState: string;
  children?: WorkItem[];
};
export function workKey(source: WorkSource, id: string) {
  return `${source}:${id}`;
}
export function testCandidate(title: string) {
  return /^(?:QA\b|acceptance[ -]|pilot[ -]|test[ :_-]|\[test\])/i.test(title);
}
export function actorAudience(actor: {
  managedAgentId?: string;
  name: string;
}) {
  return actor.managedAgentId
    ? "worker"
    : testCandidate(actor.name)
      ? "test-candidate"
      : "conversation";
}
export function workLabel(item: WorkItem): string {
  if (["cancelled", "rejected"].includes(item.coordinationState ?? ""))
    return "Stopped";
  if (item.status === "completed") {
    if (item.deliveryState === "pending") return "Delivering result";
    if (item.deliveryState === "delivered") return "Result ready";
    return "Execution completed";
  }
  const labels: Record<string, string> = {
    draft: "Draft",
    proposed: "Draft",
    queued: "Queued",
    accepted: "Queued",
    running: "Working",
    planning: "Working",
    reviewing: "Reviewing",
    revising: "Revising",
    awaiting_approval: "Needs approval",
    awaiting_clarification: "Needs your answer",
    blocked: "Blocked",
    failed: "Failed",
    stopped: "Stopped",
    cancelled: "Stopped",
    recovering: "Recovering",
    pr_ready: "Draft PR ready",
  };
  return labels[item.status] ?? item.status.replaceAll("_", " ");
}
export function needsYou(item: WorkItem) {
  if (["cancelled", "rejected"].includes(item.coordinationState ?? ""))
    return false;
  return ["awaiting_approval", "awaiting_clarification", "blocked"].includes(
    item.status,
  );
}
export function isActive(item: WorkItem) {
  if (["cancelled", "rejected"].includes(item.coordinationState ?? ""))
    return false;
  return !["completed", "failed", "stopped", "cancelled"].includes(item.status);
}
export function topLevelWork(items: WorkItem[]) {
  const keys = new Set(items.map((i) => i.key));
  const attach = (item: WorkItem, seen: Set<string>): WorkItem => ({
    ...item,
    children: items
      .filter((c) => c.parentKey === item.key && !seen.has(c.key))
      .map((c) => attach(c, new Set([...seen, c.key]))),
  });
  return items
    .filter((i) => !i.parentKey || !keys.has(i.parentKey))
    .map((i) => attach(i, new Set([i.key])));
}
