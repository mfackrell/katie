import { Octokit } from "@octokit/rest";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentRpc, readTask } from "./store";
import type { AgentTask } from "./policy";

const receiptSchema = z.object({
  version: z.literal(1), repository: z.string().max(200), run_id: z.number().int().positive(),
  issue_number: z.number().int().positive(), pr_url: z.string().max(500).nullable(), outcome: z.enum(["READY", "BLOCKED"]),
  checks: z.object({ build: z.string(), test: z.string(), review: z.string(), repair: z.string(), retest: z.string(), final_review: z.string() }).strict(),
}).strict();
export function parseCompletionReceipt(value: unknown, repo: string, issue: number, runId: number, conclusion: string | null) {
  const receipt = receiptSchema.parse(value);
  if (receipt.repository !== repo || receipt.issue_number !== issue || receipt.run_id !== runId) throw new Error("Receipt association invalid");
  if (receipt.pr_url && !new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*$`).test(receipt.pr_url)) throw new Error("Invalid receipt PR");
  const c = receipt.checks;
  const passed = c.build === "success" && ((c.repair === "skipped" && c.test === "true" && c.review === "pass" && ["", "skipped"].includes(c.retest) && ["", "skipped"].includes(c.final_review)) || (c.repair === "success" && c.retest === "true" && c.final_review === "pass"));
  return { ...receipt, outcome: conclusion === "success" && receipt.outcome === "READY" && receipt.pr_url && passed ? "READY" as const : "BLOCKED" as const };
}
// Read one fixed JSON file in a bounded GitHub artifact. No filesystem extraction or shell.
export function completionJson(zip: Buffer): unknown {
  if (zip.length > 1_000_000) throw new Error("Artifact too large");
  for (let p = Math.max(0, zip.length - 65557); p <= zip.length - 22; p++) {
    if (zip.readUInt32LE(p) !== 0x06054b50) continue;
    let offset = zip.readUInt32LE(p + 16);
    const count = zip.readUInt16LE(p + 10);
    if (count > 10) throw new Error("Too many artifact entries");
    for (let n = 0; n < count; n++) {
      if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid artifact");
      const method = zip.readUInt16LE(offset + 10), size = zip.readUInt32LE(offset + 20), unpacked = zip.readUInt32LE(offset + 24);
      const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
      const local = zip.readUInt32LE(offset + 42);
      offset += 46 + nameLength + extra + comment;
      if (name !== "agent-result.json") continue;
      if (size > 65536 || unpacked > 65536 || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("Receipt exceeds bounds");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + size > zip.length) throw new Error("Truncated receipt");
      const compressed = zip.subarray(start, start + size);
      const bytes = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: 65536 }) : null;
      if (!bytes || bytes.length !== unpacked) throw new Error("Invalid receipt compression");
      return JSON.parse(bytes.toString("utf8"));
    }
  }
  throw new Error("Completion receipt missing");
}
async function boundedGithubFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const response = await fetch(input, init);
  if (!response.body) return response;
  const limit = 8 * 1024 * 1024;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("GitHub response exceeded bounds");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
}
function github() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN;
  if (!token) throw new Error("Blocked integration: no existing server-side GitHub credential configured.");
  return new Octokit({ auth: token, request: { timeout: 15000, fetch: boundedGithubFetch } });
}
async function repository(task: AgentTask) {
  const { data, error } = await getSupabaseAdminClient().from("repo_sync_runs").select("repository_full_name").eq("id", task.repository_id).maybeSingle<{ repository_full_name: string }>();
  if (error || !data || data.repository_full_name !== task.repository_full_name || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(data.repository_full_name)) throw new Error("Blocked integration: connected repository unavailable.");
  const [owner, repo] = data.repository_full_name.split("/");
  return { owner, repo, fullName: data.repository_full_name };
}
async function save(task: AgentTask, status: string, details: string | null, external = task.external) {
  const { error } = await getSupabaseAdminClient().from("agent_tasks").eq("id", task.id).eq("request_id", task.request_id).update({ status, details, external, updated_at: new Date().toISOString() });
  if (error) throw new Error("Unable to persist development status");
  return { ...task, status, details, external };
}
const marker = (task: AgentTask) => `<!-- katie-managed-task:${task.id} -->`;
export async function dispatchDevelopment(task: AgentTask) {
  if (task.status !== "dispatching") return task;
  const claimed = await agentRpc<boolean>("claim_agent_dispatch", { p_id: task.id });
  if (!claimed) return readTask(task.id);
  task = { ...task, external: { attempted: true } };
  let client: Octokit, binding: Awaited<ReturnType<typeof repository>>;
  try {
    client = github(); binding = await repository(task);
    const [user, repo] = await Promise.all([client.users.getAuthenticated(), client.repos.get(binding)]);
    if (user.data.type !== "User" || repo.data.owner.type !== "User" || user.data.login.toLowerCase() !== repo.data.owner.login.toLowerCase()) {
      return save(task, "blocked", "Blocked integration: GitHub credential must authenticate as the repository's human owner. App, bot, organization-member and collaborator credentials cannot authorize this owner-only workflow.");
    }
    if (repo.data.owner.login.toLowerCase() !== binding.owner.toLowerCase()) return save(task, "blocked", "Blocked integration: repository owner mismatch.");
    try {
      const workflow = await client.actions.getWorkflow({ owner: binding.owner, repo: binding.repo, workflow_id: "autonomous-development.yml" });
      if (workflow.data.path !== ".github/workflows/autonomous-development.yml" || workflow.data.state !== "active") throw new Error("Workflow unavailable");
    } catch { return save(task, "blocked", "Blocked integration: the existing autonomous-development workflow is unavailable or disabled. No coding issue was submitted."); }
  } catch (error) { return save(task, "blocked", error instanceof Error && error.message.startsWith("Blocked integration:") ? error.message : "Blocked integration: unable to verify authenticated repository owner."); }
  try {
    const issue = await client.issues.create({ owner: binding.owner, repo: binding.repo,
      title: `[agent] ${task.input.split("\n")[0].slice(0, 180)}`,
      body: `${marker(task)}\n\n${task.input}\n\n## Saved agent responsibilities\n${task.snapshot.instructions}\n\nDefinition version: ${task.definition_version}. Approved managed task: ${task.id}.\nUse the existing owner-only implementation, independent tests, review, bounded repair and draft PR workflow. No deployment or automatic merge.`,
    });
    return save(task, "submitted", "Owner-authored issue accepted. Workflow completion has not yet been verified.", { attempted: true, issueNumber: issue.data.number, issueUrl: issue.data.html_url, repository: binding.fullName });
  } catch {
    return save(task, "dispatching", "External acceptance is uncertain. Refresh to reconcile the durable marker; this task will not automatically submit another issue.");
  }
}
export async function reconcileDevelopment(task: AgentTask) {
  const deadline = Date.now() + 60_000;
  if (!["submitted", "dispatching", "ready", "blocked"].includes(task.status)) return task;
  const client = github(), binding = await repository(task);
  let issueNumber = Number(task.external.issueNumber);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    if (!task.external.attempted || task.status === "blocked") return task;
    const issues = await client.issues.listForRepo({ owner: binding.owner, repo: binding.repo, state: "all", creator: binding.owner, per_page: 100, sort: "created", direction: "desc" });
    const issue = issues.data.find(i => !i.pull_request && i.user?.login.toLowerCase() === binding.owner.toLowerCase() && i.title.startsWith("[agent]") && (i.body ?? "").length <= 65536 && i.body?.includes(marker(task)));
    if (!issue) return save(task, "dispatching", "No matching issue in the latest 100 owner issues. Acceptance remains uncertain; automatic resubmission is disabled.");
    issueNumber = issue.number;
    task = await save(task, "submitted", "Reconciled accepted issue; awaiting verified workflow receipt.", { ...task.external, issueNumber, issueUrl: issue.html_url, repository: binding.fullName });
  }
  const runs = await client.actions.listWorkflowRuns({ owner: binding.owner, repo: binding.repo, workflow_id: "autonomous-development.yml", per_page: 20 });
  for (const run of runs.data.workflow_runs) {
    if (Date.now() > deadline - 15_000) return save(task, task.status, "Refresh reached its bounded time window before finding a verified receipt. Refresh manually to check again.");
    if (run.status !== "completed" || !["issues", "workflow_dispatch"].includes(run.event) || run.repository.full_name !== binding.fullName || run.head_branch !== "main" || run.head_repository?.full_name !== binding.fullName || run.path !== ".github/workflows/autonomous-development.yml") continue;
    const artifacts = await client.actions.listWorkflowRunArtifacts({ owner: binding.owner, repo: binding.repo, run_id: run.id, per_page: 20 });
    const artifact = artifacts.data.artifacts.find(a => a.name === "agent-completion" && !a.expired && a.size_in_bytes <= 1_000_000);
    if (!artifact) continue;
    if (Date.now() > deadline - 15_000) return save(task, task.status, "Refresh reached its bounded time window. No new completion status has been inferred.");
    const download = await client.actions.downloadArtifact({ owner: binding.owner, repo: binding.repo, artifact_id: artifact.id, archive_format: "zip" });
    const raw = completionJson(Buffer.from(download.data as ArrayBuffer));
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.issue_number !== issueNumber) continue;
    const receipt = parseCompletionReceipt(raw, binding.fullName, issueNumber, run.id, run.conclusion);
    return save(task, receipt.outcome === "READY" ? "ready" : "blocked", receipt.outcome === "READY" ? "Draft ready for owner approval. No merge or deployment." : "Independent workflow tests or review blocked completion.", { ...task.external, runUrl: run.html_url, prUrl: receipt.pr_url, receipt });
  }
  return save(task, task.status, "No verified completion receipt among the latest 20 workflow runs. Refresh manually after workflow completion.");
}
