import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import type { AgentTask } from './policy';
import { getDevelopmentProjectContext, projectRpc } from '@/lib/projects/store';
import { browserContract, digest } from '@/lib/projects/contract';
import type { ProjectAcceptanceBinding } from './development';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const settlementSchema = z.object({
  receiptId: z.string().uuid(), authorizationId: z.string().uuid(),
  projectId: z.string().uuid(), packageId: z.string().uuid(),
  missionId: z.string().uuid(), assignmentId: z.string().uuid(),
  candidateSha: sha, sourceTreeSha: sha, scopeHash: hash, contractHash: hash,
  workflowReceipt: z.record(z.unknown()), qualification: z.record(z.unknown()),
  consumed: z.object({verification:z.record(z.unknown()),browserAcceptance:z.record(z.unknown())}).nullable().optional(),
  binding: z.object({
    version: z.literal(1), projectId: z.string().uuid(), baseSha: sha, baselineSha: sha,
    scopeHash: hash, contractHash: hash, allowedPaths: z.array(z.string()).min(1),
    cumulativePaths: z.array(z.string()).min(1).optional(), contract: browserContract,
  }).passthrough(),
}).passthrough();
export type RetainedReviewSettlement = z.infer<typeof settlementSchema>;

// A failed workflow remains failed. Only the database's authenticated,
// immutable settlement can establish a separate accepted review checkpoint.
// No task.external flag, URL or caller-supplied verdict is an authority source.
export async function loadRetainedReviewSettlement(task: AgentTask, project: ProjectAcceptanceBinding): Promise<RetainedReviewSettlement | null> {
  if (task.status !== 'blocked' || (task.external.receipt as {outcome?: unknown} | undefined)?.outcome !== 'BLOCKED') return null;
  const value = await projectRpc<unknown>('project_development_review_settlement', {p_task: task.id});
  if (value === null) return null;
  const s = settlementSchema.parse(value);
  const context = await getDevelopmentProjectContext(task.id);
  const q = s.qualification, r = s.workflowReceipt;
  if (!context || s.assignmentId !== task.id || s.projectId !== project.projectId
    || s.projectId !== context.projectId || s.scopeHash !== context.scopeHash
    || s.contractHash !== project.contractHash || s.contractHash !== context.contractHash
    || s.binding.projectId !== s.projectId || s.binding.scopeHash !== s.scopeHash
    || s.binding.contractHash !== s.contractHash || digest(s.binding.contract) !== s.contractHash
    || ['version','projectId','baseSha','baselineSha','scopeHash','contractHash','allowedPaths','cumulativePaths','contract']
      .some(key => digest(s.binding[key] ?? null) !== digest(context[key as keyof typeof context] ?? null))
    || project.scenarioNames.length !== s.binding.contract.scenarios.length
    || project.scenarioNames.some((name, i) => name !== s.binding.contract.scenarios[i].name)
    || (project.packageScope && (project.packageScope.baseSha !== s.binding.baseSha || digest(project.packageScope.paths) !== digest(s.binding.allowedPaths)))
    || digest(r) !== digest(task.external.receipt) || r.outcome !== 'BLOCKED'
    || r.repository !== task.repository_full_name || r.issue_number !== Number(task.external.issueNumber)
    || q.kind !== 'retained-final-review-settlement' || q.candidateSha !== s.candidateSha
    || q.sourceTreeSha !== s.sourceTreeSha || q.scopeHash !== s.scopeHash || q.contractHash !== s.contractHash
    || String(q.runId) !== String(r.run_id) || q.workflowConclusion !== 'failure'
    || q.phase !== 'final-review' || q.terminalEvent !== 'turn.completed' || String(q.exitCode) !== '0'
    || typeof q.findings !== 'string' || !q.findings.startsWith('PASS ')) {
    throw Error('Retained review settlement association invalid');
  }
  return s;
}

export async function retainedReviewSource(client: Octokit, repository: {owner:string;repo:string;fullName:string}, s: RetainedReviewSettlement) {
  const {data: commit} = await client.repos.getCommit({owner: repository.owner, repo: repository.repo, ref: s.candidateSha});
  if (commit.sha !== s.candidateSha || commit.commit.tree.sha !== s.sourceTreeSha) throw Error('Retained review candidate source tree changed');
  const {data: delta} = await client.repos.compareCommitsWithBasehead({owner: repository.owner, repo: repository.repo,
    basehead: s.binding.baseSha + '...' + s.candidateSha, per_page: 100});
  if (delta.status !== 'ahead' || delta.merge_base_commit.sha !== s.binding.baseSha || !delta.files?.length || delta.files.length > 100) {
    throw Error('Retained review candidate delta unavailable or divergent');
  }
  const within = (path:string) => s.binding.allowedPaths.some(prefix => path === prefix || prefix.endsWith('/') && path.startsWith(prefix));
  if (delta.files.some(file => !within(file.filename) || file.previous_filename && !within(file.previous_filename))) {
    throw Error('Retained review candidate escaped approved package paths');
  }
  let patchBytes = 0;
  const changedFiles = delta.files.map(file => {
    const size = file.patch ? Buffer.byteLength(file.patch, 'utf8') : 0;
    const include = Boolean(file.patch) && patchBytes + size <= 12000;
    if (include) patchBytes += size;
    return {path:file.filename,status:file.status,additions:file.additions,deletions:file.deletions,
      ...(include ? {patch:file.patch} : {patchUnavailable:true})};
  });
  return {observedHeadSha:s.candidateSha,testedHeadSha:s.candidateSha,reviewedHeadSha:s.candidateSha,sourceTreeSha:s.sourceTreeSha,
    baseSha:s.binding.baseSha,changedFiles,
    packageDelta:{baseSha:s.binding.baseSha,headSha:s.candidateSha,changedFiles:delta.files.flatMap(f => [f.filename,...(f.previous_filename?[f.previous_filename]:[])]).map(path => ({path}))},
    reviewSettlement:{kind:'retained-final-review-settlement' as const,receiptId:s.receiptId,authorizationId:s.authorizationId,
      sourceTreeSha:s.sourceTreeSha,scopeHash:s.scopeHash,contractHash:s.contractHash,workflowOutcome:'BLOCKED' as const},
    validation:{kind:'retained-native-verification' as const,runId:String(s.workflowReceipt.run_id),
      artifactId:s.qualification.artifactId,artifactSha256:s.qualification.artifactSha256,
      verificationDigest:s.qualification.verificationDigest,
      note:'Historical successful candidate verification and independent review were authenticated by the retained settlement; the original workflow remains BLOCKED.'}};
}
