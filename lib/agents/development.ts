import {getDevelopmentProjectContext,acceptanceBinding,projectRpc,type Context} from '@/lib/projects/store';
import {digest} from '@/lib/projects/contract';
import { Octokit } from "@octokit/rest";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentRpc, readTask } from "./store";
import type { AgentTask } from "./policy";

export const projectAcceptanceSchema = z.object({
  version: z.literal(1), projectId: z.string().uuid(), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/), passed: z.boolean(),
  checks: z.array(z.object({ name: z.string().trim().min(1).max(200), passed: z.boolean(), detail: z.string().trim().min(1).max(2000) }).strict()).min(1).max(20),
}).strict();
export type ProjectAcceptanceBinding = { projectId: string; contractHash: string; scenarioNames: string[] };
const receiptSchema = z.object({
  version: z.literal(1), repository: z.string().max(200), run_id: z.number().int().positive(),
  issue_number: z.number().int().positive(), pr_url: z.string().max(500).nullable(), outcome: z.enum(["READY", "BLOCKED"]),
  checks: z.object({ build: z.string(), test: z.string(), review: z.string(), repair: z.string(), retest: z.string(), final_review: z.string() }).strict(),
  tested_head_sha:z.string().regex(/^[a-f0-9]{40}$/).nullable().optional(),
  reviewed_head_sha:z.string().regex(/^[a-f0-9]{40}$/).nullable().optional(),
  projectAcceptance: projectAcceptanceSchema.optional(),
}).strict();
export function parseCompletionReceipt(value: unknown, repo: string, issue: number, runId: number, conclusion: string | null, project?: ProjectAcceptanceBinding) {
  const receipt = receiptSchema.parse(value);
  if (receipt.repository !== repo || receipt.issue_number !== issue || receipt.run_id !== runId) throw new Error("Receipt association invalid");
  if (receipt.pr_url && !new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*$`).test(receipt.pr_url)) throw new Error("Invalid receipt PR");
  const c = receipt.checks;
  const passed = c.build === "success" && ((c.repair === "skipped" && c.test === "true" && c.review === "pass" && ["", "skipped"].includes(c.retest) && ["", "skipped"].includes(c.final_review)) || (c.repair === "success" && c.retest === "true" && c.final_review === "pass"));
  const boundHeads=receipt.tested_head_sha===undefined&&receipt.reviewed_head_sha===undefined||typeof receipt.tested_head_sha==='string'&&receipt.tested_head_sha===receipt.reviewed_head_sha;
  const acceptance = receipt.projectAcceptance;
  const browserPassed = !acceptance ? !project : Boolean(project) && acceptance.passed && acceptance.checks.every(check => check.passed)
    && acceptance.headSha === receipt.tested_head_sha && acceptance.headSha === receipt.reviewed_head_sha
    && new Set(acceptance.checks.map(check => check.name)).size === acceptance.checks.length
    && (!project || acceptance.projectId === project.projectId && acceptance.contractHash === project.contractHash
      && project.scenarioNames.length === acceptance.checks.length && project.scenarioNames.every((name, index) => name === acceptance.checks[index].name));
  return { ...receipt, outcome: conclusion === "success" && receipt.outcome === "READY" && receipt.pr_url && passed && boundHeads && browserPassed ? "READY" as const : "BLOCKED" as const };
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
export async function dispatchDevelopment(task: AgentTask, project?: Context, assignmentLease?:string) {
  if (task.status !== "dispatching") return task;
  // Project metadata must eventually be appended by a DB-bound project
  // dispatcher. Ordinary/model-authored assignments cannot mint this authority.
  if (/<!--\s*katie-project\b/.test(task.input + '\n' + task.snapshot.instructions)) {
    return save(task, "blocked", "Project metadata is not permitted in ordinary coding input. A DB-bound approved project dispatcher is required.");
  }
  let projectHeader='';
  if(project){
    const saved=await getDevelopmentProjectContext(task.id,true);
    if(!saved||JSON.stringify(saved)!==JSON.stringify(project)||digest(project.contract)!==project.contractHash)throw Error('Project dispatch does not match approved DB binding');
    const {version,projectId,baseSha,baselineSha,allowedPaths,contractHash,contract}=project;
    projectHeader='<!-- katie-project: '+Buffer.from(JSON.stringify({version,projectId,baseSha,baselineSha,allowedPaths,contractHash,contract})).toString('base64url')+' -->\n\n';
  }
  const claimed = project ? await agentRpc<boolean>("claim_project_dispatch", {p_id:task.id,p_lease:assignmentLease??null,p_hash:project.scopeHash}) : await agentRpc<boolean>("claim_agent_dispatch", { p_id: task.id });
  if (!claimed) return readTask(task.id);
  task = { ...task, external: { attempted: true, ...(project?{projectId:project.projectId}:{}) } };
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
      body: `${marker(task)}\n\n${projectHeader}${task.input}\n\n## Saved agent responsibilities\n${task.snapshot.instructions}\n\nDefinition version: ${task.definition_version}. Approved managed task: ${task.id}.\nUse the existing owner-only implementation, independent tests, review, bounded repair and draft PR workflow. No deployment or automatic merge.`,
    });
    return save(task, "submitted", "Owner-authored issue accepted. Workflow completion has not yet been verified.", { ...task.external,attempted: true, issueNumber: issue.data.number, issueUrl: issue.data.html_url, repository: binding.fullName });
  } catch {
    return save(task, "dispatching", "External acceptance is uncertain. Refresh to reconcile the durable marker; this task will not automatically submit another issue.");
  }
}
// Infrastructure-only recovery: the original immutable PR is re-tested,
// never regenerated. A trusted GitHub test-job log must demonstrate that
// the test harness failed before candidate code or browser acceptance ran.
// The DB RPC checks the exact owner/chat/project/mission, receipt and scope
// under an advisory lock, and preserves coding cycles and earlier charges.
export async function retryImmutableProjectVerification(task: AgentTask, project: {
 id:string;actor_id:string;chat_id:string;active_mission_id:string|null;approved_hash:string|null;approval_hash:string|null;
}): Promise<boolean> {
 if(!project.active_mission_id||!project.approved_hash||project.approved_hash!==project.approval_hash||
   task.status!=='blocked'||task.external.projectId!==project.id)return false;
 const parsed=receiptSchema.safeParse(task.external.receipt);
 if(!parsed.success)return false;
 const receipt=parsed.data;
 if(receipt.outcome!=='BLOCKED'||receipt.checks.test!=='false'||receipt.checks.review!=='pass'||
   receipt.checks.repair!=='failure'||!receipt.pr_url||!receipt.tested_head_sha)return false;
 const issue=Number(task.external.issueNumber),prNumber=Number(receipt.pr_url.split('/').pop());
 if(!Number.isSafeInteger(issue)||issue<1||!Number.isSafeInteger(prNumber)||prNumber<1||
    receipt.issue_number!==issue||task.external.prUrl!==receipt.pr_url)return false;
 const client=github(),binding=await repository(task);
 const [pr,jobs,workflow]=await Promise.all([
  client.pulls.get({owner:binding.owner,repo:binding.repo,pull_number:prNumber}),
  client.actions.listJobsForWorkflowRun({owner:binding.owner,repo:binding.repo,run_id:receipt.run_id,per_page:30}),
  client.actions.getWorkflow({owner:binding.owner,repo:binding.repo,workflow_id:'project-reverify.yml'}),
 ]);
 if(workflow.data.path!=='.github/workflows/project-reverify.yml'||workflow.data.state!=='active')return false;
 if(!pr.data.draft||pr.data.state!=='open'||pr.data.merged||pr.data.head.sha!==receipt.tested_head_sha||
   pr.data.head.repo?.full_name!==binding.fullName||pr.data.base.repo.full_name!==binding.fullName||
   pr.data.base.ref!=='main')return false;
 const testJob=jobs.data.jobs.find(j=>j.name==='test'&&j.conclusion==='success');
 if(!testJob)return false;
 const log=await client.actions.downloadJobLogsForWorkflowRun({owner:binding.owner,repo:binding.repo,job_id:testJob.id});
 const output=typeof log.data==='string'?log.data:Buffer.from(log.data as ArrayBuffer).toString('utf8');
 // Fail closed if verification failure isn't unmistakably about trusted setup.
 const setupFailure=/Isolated baseline npm installation failed|Trusted baseline dependency preparation failed/.test(output);
 const npmFailure=/npm error Exit handler never called|npm error code ENOTCACHED|Isolated baseline npm installation failed|Trusted baseline dependency preparation failed/.test(output);
 // A known read-only test-runner cache mount error is also infrastructure,
 // not evidence that the approved gameplay is wrong. A new verification-only
 // run must still pass every test, review and browser scenario independently.
 const viteCacheFailure=/ENOENT: no such file or directory, mkdir ['"]\\/app\\/node_modules\\/\\.vite['"]/.test(output)
   && /Vitest failed or did not produce a completion report/.test(output);
 if(!(setupFailure&&npmFailure)&&!viteCacheFailure)return false;
 const bindingContext=await getDevelopmentProjectContext(task.id);
 if(!bindingContext||bindingContext.projectId!==project.id||
    bindingContext.scopeHash!==project.approved_hash)return false;
 // The workflow exists on main and reuses the owner-authored issue, draft PR
 // and pinned SHA. No code-generation or repair job exists in this workflow.
 await client.actions.createWorkflowDispatch({owner:binding.owner,repo:binding.repo,workflow_id:'project-reverify.yml',
  ref:'main',inputs:{issue_number:String(issue),pr_number:String(prNumber),expected_sha:receipt.tested_head_sha}});
 const saved=await projectRpc<{status:string}|null>('retry_project_verification',{
  p_id:project.id,p_actor:project.actor_id,p_chat:project.chat_id,
  p_mission:project.active_mission_id,p_issue:issue,p_run:receipt.run_id,p_pr:prNumber,p_head:receipt.tested_head_sha,
 });
 return saved?.status==='running';
}

export async function reconcileDevelopment(task: AgentTask, project?: ProjectAcceptanceBinding) {
  if(!project&&typeof task.external.projectId==='string'){const binding=await getDevelopmentProjectContext(task.id);if(!binding||binding.projectId!==task.external.projectId)throw Error('Saved project binding unavailable');project=acceptanceBinding(binding);}
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
  const verificationSince=typeof task.external.verificationSince==='string'
    ? Date.parse(task.external.verificationSince) : NaN;
  const verificationOnly=Number.isFinite(verificationSince);
  const workflowId=verificationOnly?'project-reverify.yml':'autonomous-development.yml';
  const workflowPath='.github/workflows/'+workflowId;
  const runs = await client.actions.listWorkflowRuns({ owner: binding.owner, repo: binding.repo, workflow_id: workflowId, per_page: 20 });
  for (const run of runs.data.workflow_runs) {
    if (Date.now() > deadline - 15_000) return save(task, task.status, "Refresh reached its bounded time window before finding a verified receipt. Refresh manually to check again.");
    if (run.status !== "completed" || !["issues", "workflow_dispatch"].includes(run.event) || run.repository.full_name !== binding.fullName || run.head_branch !== "main" || run.head_repository?.full_name !== binding.fullName || run.path !== workflowPath || (verificationOnly && (run.event!=='workflow_dispatch'||new Date(run.created_at).getTime()<verificationSince))) continue;
    const artifacts = await client.actions.listWorkflowRunArtifacts({ owner: binding.owner, repo: binding.repo, run_id: run.id, per_page: 20 });
    const artifact = artifacts.data.artifacts.find(a => a.name === "agent-completion" && !a.expired && a.size_in_bytes <= 1_000_000);
    if (!artifact) continue;
    if (Date.now() > deadline - 15_000) return save(task, task.status, "Refresh reached its bounded time window. No new completion status has been inferred.");
    const download = await client.actions.downloadArtifact({ owner: binding.owner, repo: binding.repo, artifact_id: artifact.id, archive_format: "zip" });
    const raw = completionJson(Buffer.from(download.data as ArrayBuffer));
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.issue_number !== issueNumber) continue;
    const receipt = parseCompletionReceipt(raw, binding.fullName, issueNumber, run.id, run.conclusion, project);
    return save(task, receipt.outcome === "READY" ? "ready" : "blocked", receipt.outcome === "READY" ? "Draft ready for owner approval. No merge or deployment." : "Independent workflow tests or review blocked completion.", { ...task.external, runUrl: run.html_url, prUrl: receipt.pr_url, receipt });
  }
  return save(task, task.status, "No verified completion receipt among the latest 20 workflow runs. Refresh manually after workflow completion.");
}

// Supply the coordinator with observed repository evidence after its trusted
// completion receipt passes. This is bounded, read-only verification; the
// workflow remains responsible for implementation, testing and code review.
export async function developmentEvidence(task: AgentTask, project?: ProjectAcceptanceBinding) {
  if(!project&&typeof task.external.projectId==='string'){const binding=await getDevelopmentProjectContext(task.id);if(!binding||binding.projectId!==task.external.projectId)throw Error('Saved project binding unavailable');project=acceptanceBinding(binding);}
  if(task.status!=="ready")throw new Error("Verified development receipt required");
  const client=github(),binding=await repository(task);
  const receipt=parseCompletionReceipt(task.external.receipt,binding.fullName,Number(task.external.issueNumber),Number((task.external.receipt as Record<string,unknown>)?.run_id),"success",project);
  if(receipt.outcome!=="READY"||receipt.pr_url!==task.external.prUrl)throw new Error("Draft receipt association invalid");
  const number=Number(receipt.pr_url!.split('/').pop());
  const {data:pr}=await client.pulls.get({owner:binding.owner,repo:binding.repo,pull_number:number});
  if(!pr.draft||pr.state!=="open"||pr.merged||pr.head.repo?.full_name!==binding.fullName||pr.base.repo.full_name!==binding.fullName||pr.changed_files>(project?100:30))throw new Error("Draft evidence unavailable or exceeds the configured changed-file verification limit");
  const jobs=await client.actions.listJobsForWorkflowRun({owner:binding.owner,repo:binding.repo,run_id:receipt.run_id,per_page:20});
  const build=jobs.data.jobs.find(j=>j.name==="build"&&j.conclusion==="success");
  if(!build)throw new Error("Verified build job evidence unavailable");
  const jobLog=async(id:number)=>{const log=await client.actions.downloadJobLogsForWorkflowRun({owner:binding.owner,repo:binding.repo,job_id:id});return typeof log.data==='string'?log.data:Buffer.from(log.data as ArrayBuffer).toString('utf8');};
  let testedHead=receipt.tested_head_sha,reviewedHead=receipt.reviewed_head_sha;
  if(testedHead===undefined&&reviewedHead===undefined){
    // Legacy unrepaired runs record their immutable checkout in both native
    // job logs. Repaired legacy runs lack a trustworthy retest SHA.
    if(receipt.checks.repair!=='skipped')throw new Error('Legacy repaired receipt lacks an immutable tested head; revalidate with the updated workflow');
    const test=jobs.data.jobs.find(j=>j.name==='test'&&j.conclusion==='success'),review=jobs.data.jobs.find(j=>j.name==='review'&&j.conclusion==='success');
    if(!test||!review)throw new Error('Immutable test/review evidence unavailable');
    const checkoutHead=(log:string)=>{const lines=log.split(/\r?\n/),at=lines.findIndex(line=>/\[command\].*\bgit log -1 --format=%H\s*$/.test(line));const sha=at>=0?lines[at+1]?.match(/\b([a-f0-9]{40})\s*$/)?.[1]:null;if(!sha)throw new Error('Immutable checkout SHA unavailable');return sha;};
    const [testLog,reviewLog]=await Promise.all([jobLog(test.id),jobLog(review.id)]);
    testedHead=checkoutHead(testLog);reviewedHead=checkoutHead(reviewLog);
  }
  if(!testedHead||testedHead!==reviewedHead||pr.head.sha!==testedHead)throw new Error('Draft head does not match the immutable tested and reviewed commit');
  const [files,raw]=await Promise.all([
    client.repos.compareCommitsWithBasehead({owner:binding.owner,repo:binding.repo,basehead:pr.base.sha+'...'+testedHead,per_page:100}),jobLog(build.id),
  ]);
  if(files.data.files?.length!==pr.changed_files)throw new Error('Incomplete changed-file evidence');
  const excerpts=raw.split(/\r?\n/).filter(line=>/\bPASS:|Validation passed:|focused.{0,100}(?:passed|success)/i.test(line)&&!/console\.log|assert\./.test(line)).slice(0,8).map(line=>line.slice(0,500));
  let patchBytes=0;
  const changedFiles=files.data.files.map(file=>{
    const patch=file.patch;const size=patch?Buffer.byteLength(patch,"utf8"):0;
    const include=Boolean(patch)&&patchBytes+size<=12000;if(include)patchBytes+=size;
    return{path:file.filename,status:file.status,additions:file.additions,deletions:file.deletions,...(include?{patch}:{patchUnavailable:true})};
  });
  const {data:after}=await client.pulls.get({owner:binding.owner,repo:binding.repo,pull_number:number});
  if(!after.draft||after.state!=='open'||after.merged||after.head.sha!==testedHead||after.base.sha!==pr.base.sha||after.head.repo?.full_name!==binding.fullName||after.base.repo.full_name!==binding.fullName)throw new Error('Draft changed while collecting immutable verification evidence');
  return{pullRequest:pr.html_url,draft:pr.draft,branch:pr.head.ref,observedHeadSha:pr.head.sha,testedHeadSha:testedHead,reviewedHeadSha:reviewedHead,baseSha:pr.base.sha,changedFiles,...(project?{projectAcceptance:receipt.projectAcceptance}:{}),
    validation:{buildJob:build.html_url,conclusion:build.conclusion,excerpts,note:"Selected build-log excerpts, not the full log. Patches exceeding the 12 KB evidence allowance are explicitly omitted; the complete changed-file list is retained."}};
}

// Delivery is evidence from GitHub's deployment/status APIs, never a URL
// invented by a model or a successful local browser check.
export function verifiedPreviewUrl(raw: unknown, approvedOrigins: readonly string[] = []): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const vercel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/i.test(url.hostname);
    const configured = approvedOrigins.some(origin => {
      try { const allowed = new URL(origin); return allowed.protocol === 'https:' && allowed.origin === origin && !allowed.username && !allowed.password && url.origin === allowed.origin; }
      catch { return false; }
    });
    return vercel || configured ? url.href : null;
  } catch { return null; }
}
// A Vercel deployment URL has a provider-assigned nine-character nonce.
// The owner config fixes project/team names and captures that nonce; branch,
// project and custom aliases are not delivery evidence even if they are HTTPS.
export function immutablePreviewUrl(raw:unknown,approvedOrigins:readonly string[]=[]):string|null{
 const safe=verifiedPreviewUrl(raw,approvedOrigins),rule=process.env.PROJECT_PREVIEW_HOST_PATTERN;if(!safe||!rule||!rule.startsWith('^')||!rule.endsWith('$'))return null;
 try{const u=new URL(safe),nonce=new RegExp(rule).exec(u.hostname)?.[1];return u.hostname.endsWith('.vercel.app')&&!u.hostname.includes('-git-')&&typeof nonce==='string'&&/^[a-z0-9]{9}$/.test(nonce)?safe:null;}catch{return null;}
}
export async function developmentPreview(task: AgentTask, project: ProjectAcceptanceBinding, approvedOrigins: readonly string[] = []) {
  const receipt = parseCompletionReceipt(task.external.receipt, task.repository_full_name ?? '', Number(task.external.issueNumber), Number((task.external.receipt as Record<string, unknown>)?.run_id), 'success', project);
  if (task.status !== 'ready' || receipt.outcome !== 'READY' || !receipt.tested_head_sha) throw Error('Head-bound project acceptance required before preview delivery');
  const client = github(), binding = await repository(task);
  // Recheck live PR identity/head; an old READY receipt cannot bless a changed PR.
  const { data: pr } = await client.pulls.get({ owner: binding.owner, repo: binding.repo, pull_number: Number(receipt.pr_url!.split('/').pop()) });
  if (pr.state !== 'open' || !pr.draft || pr.merged || pr.head.sha !== receipt.tested_head_sha || pr.head.repo?.full_name !== binding.fullName || pr.base.repo.full_name !== binding.fullName) throw Error('Preview draft no longer matches verified project head');
  const deployments = await client.repos.listDeployments({ owner: binding.owner, repo: binding.repo, sha: receipt.tested_head_sha, per_page: 20 });
  const previewDeadline=Date.now()+45000;
  for (const deployment of deployments.data) {
    if(Date.now()>=previewDeadline)break;
    if (deployment.creator?.login?.toLowerCase()!=='vercel[bot]' || deployment.sha !== receipt.tested_head_sha || deployment.production_environment !== false || !/^preview(?:\s|$|[-_/])/i.test(deployment.environment)) continue;
    const statuses = await client.repos.listDeploymentStatuses({ owner: binding.owner, repo: binding.repo, deployment_id: deployment.id, per_page: 1 });
    const status = statuses.data[0];
    const url = status?.state === 'success' && status.creator?.login?.toLowerCase()==='vercel[bot]' ? immutablePreviewUrl(status.environment_url, approvedOrigins) : null;
    if (url && (!status.environment || status.environment === deployment.environment)) {
      const { data: after } = await client.pulls.get({ owner: binding.owner, repo: binding.repo, pull_number: pr.number ?? Number(receipt.pr_url!.split('/').pop()) });
      if (after.state !== 'open' || !after.draft || after.merged || after.head.sha !== receipt.tested_head_sha || after.head.repo?.full_name !== binding.fullName || after.base.repo.full_name !== binding.fullName) throw Error('Preview draft changed during delivery verification');
      return { url, headSha: deployment.sha, deploymentId: deployment.id, statusId: status.id, provider:'vercel',immutable:true };
    }
  }
  return null;
}
