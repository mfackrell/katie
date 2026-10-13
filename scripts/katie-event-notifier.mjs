/** Event-driven GitHub Actions status and review handoff. Never executes checkout content. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_WORKFLOWS = new Set(['Katie autonomous development', 'ci', 'migrate-and-deploy']);
export function validateReceipt(payload, { repository, runId }) {
  if (!payload || payload.version !== 1 || payload.repository !== repository ||
      payload.run_id !== runId || !Number.isSafeInteger(payload.issue_number) ||
      payload.issue_number < 1 || !['READY', 'BLOCKED'].includes(payload.outcome) ||
      (payload.pr_url !== null && (typeof payload.pr_url !== 'string' ||
        !new RegExp('^https://github[.]com/' + repository + '/pull/[1-9][0-9]*))) {
    throw new Error('Invalid or untrusted autonomous completion receipt');
  }
  return payload;
}
export function classifyAgentResult(receipt, conclusion) {
  return conclusion === 'success' && receipt?.outcome === 'READY' ? 'READY' : 'BLOCKED';
}
export function classifyReleaseRuns(runs, sha) {
  const selected = {};
  for (const name of ['ci', 'migrate-and-deploy']) {
    const eligible = runs.filter(r => r.name === name && r.head_sha === sha &&
      r.event === 'push' && r.head_branch === 'main');
    eligible.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    if (!eligible.length || eligible[0].status !== 'completed') return null;
    selected[name] = eligible[0];
  }
  return { status: Object.values(selected).every(r => r.conclusion === 'success') ? 'PASSED' : 'BLOCKED', runs: selected };
}
export function agentNotice({ owner, issue, runId, attempt, result, pr, conclusion, reviewFindings = [], followupUrl = null }) {
  const marker = `<!-- katie-agent-notice:${runId}:${attempt} -->`;
  const status = result === 'READY' ? 'READY — independent tests and review passed' : 'BLOCKED — action required';
  const findings = result === 'BLOCKED' && reviewFindings.length ?
    `\n\nBlocking review findings:\n${reviewFindings.slice(0, 8).map(f => `- ${String(f).slice(0, 700)}`).join('\n')}` : '';
  return `${marker}\n@${owner} **Katie autonomous agent: ${status}**\n\n` +
    `- Development task: #${issue}\n- [Workflow and logs](https://github.com/${process.env.GITHUB_REPOSITORY || 'mfackrell/katie'}/actions/runs/${runId})` +
    `${pr ? `\n- Draft pull request: ${pr}` : '\n- No pull request was created'}` +
    `\n- Workflow conclusion: ${conclusion}${findings}` +
    `${followupUrl ? `\n- Follow-up work item: ${followupUrl}` : ''}` +
    '\n\n**No automatic merge or production deployment occurred.**';
}
export function releaseNotice({ owner, sha, result, repo }) {
  const marker = `<!-- katie-release-notice:${sha} -->`;
  return `${marker}\n@${owner} **Katie main-branch checks: ${result.status === 'PASSED' ? 'PASSED' : 'BLOCKED'}**\n\n` +
    `- Commit: [\`${sha.slice(0, 12)}\`](https://github.com/${repo}/commit/${sha})\n` +
    `- [CI run](https://github.com/${repo}/actions/runs/${result.runs.ci.id}): ${result.runs.ci.conclusion}\n` +
    `- [Database migration run](https://github.com/${repo}/actions/runs/${result.runs['migrate-and-deploy'].id}): ${result.runs['migrate-and-deploy'].conclusion}\n\n` +
    '**These are GitHub checks only. Vercel production readiness has not been verified by this notification.**';
}

function gh(...args) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 }).trim(); }
function api(path) { return JSON.parse(gh('api', path)); }
function ensureLabel(repo, label, color) {
  try { gh('label', 'create', label, '--repo', repo, '--color', color); }
  catch (error) { if (!String(error.stderr || error.message).includes('already exists')) throw error; }
}
function commentsContain(repo, issue, marker) {
  // GitHub CLI streams every page without writing into the checkout or executing issue text.
  return gh('api', '--paginate', `repos/${repo}/issues/${issue}/comments?per_page=100`, '--jq', '.[].body').includes(marker);
}
function postOnce(repo, issue, marker, body) {
  if (commentsContain(repo, issue, marker)) return false;
  gh('issue', 'comment', String(issue), '--repo', repo, '--body', body);
  return true;
}
function downloadArtifact(repo, runId, name) {
  const tmp = mkdtempSync(join(tmpdir(), 'katie-event-'));
  try {
    gh('run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', tmp);
    return JSON.parse(readFileSync(join(tmp, name === 'agent-completion' ? 'agent-result.json' :
      name === 'agent-final-review' ? 'agent-final-review.json' : 'agent-review.json'), 'utf8'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
function tryArtifact(repo, runId, name) {
  try { return downloadArtifact(repo, runId, name); } catch { return null; }
}
function followupIssue(repo, owner, receipt, findings, runId) {
  // Only one bounded follow-up triage issue. Bot-created issues cannot start the
  // owner-only coding workflow, preserving the explicit development authorization.
  const title = `[agent-followup] Review blockers for #${receipt.issue_number} (run ${runId})`;
  const listed = JSON.parse(gh('issue', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,url'));
  const existing = listed.find(x => x.title === title);
  if (existing) return existing.url;
  const body = `Automated review handoff from #${receipt.issue_number}.\n\n` +
    `- Original task: #${receipt.issue_number}\n` +
    `- Draft PR: ${receipt.pr_url || 'not created'}\n` +
    `- [Logs](https://github.com/${repo}/actions/runs/${runId})\n\n` +
    `### Blocking findings\n${findings.length ? findings.map(f => `- ${String(f).slice(0, 1800)}`).join('\n') :
      '- No structured reviewer output available; investigate workflow logs and failed checks.'}\n\n` +
    'This is an automatically queued follow-up for review. It does **not** bypass owner-authored issue authorization, automatically re-run Codex, merge, or deploy.';
  return gh('issue', 'create', '--repo', repo, '--title', title, '--body', body, '--assignee', owner);
}

function handleAgent({ event, repo, owner, dashboard }) {
  const run = event.workflow_run;
  let receipt = tryArtifact(repo, run.id, 'agent-completion');
  const marker = `<!-- katie-agent-notice:${run.id}:${run.run_attempt || 1} -->`;
  if (!receipt) {
    const body = `${marker}\n@${owner} **Katie agent: BLOCKED (missing completion report)**\n\n` +
      `[Inspect workflow](https://github.com/${repo}/actions/runs/${run.id}). ` +
      'This run failed or stopped before producing a verifiable result. No merge or deployment was authorized.';
    postOnce(repo, dashboard, marker, body);
    return;
  }
  receipt = validateReceipt(receipt, { repository: repo, runId: run.id });
  const info = JSON.parse(gh('issue', 'view', String(receipt.issue_number), '--repo', repo, '--json', 'author,title'));
  if (info.author?.login !== owner || !info.title?.startsWith('[agent]')) throw new Error('Receipt did not identify an owner-authorized issue');
  const result = classifyAgentResult(receipt, run.conclusion);
  if (receipt.pr_url) {
    const pr = JSON.parse(gh('pr', 'view', receipt.pr_url, '--repo', repo, '--json', 'headRefName'));
    if (!pr.headRefName.startsWith(`agent/issue-${receipt.issue_number}-${run.id}-`)) {
      throw new Error('Receipt PR does not belong to the completed owner-authorized agent run');
    }
  }
  ensureLabel(repo, 'agent-ready', '2DA44E');
  ensureLabel(repo, 'agent-blocked', 'CF222E');
  gh('issue', 'edit', String(receipt.issue_number), '--repo', repo, '--add-assignee', owner,
    '--add-label', result === 'READY' ? 'agent-ready' : 'agent-blocked');
  const other = result === 'READY' ? 'agent-blocked' : 'agent-ready';
  try { gh('issue', 'edit', String(receipt.issue_number), '--repo', repo, '--remove-label', other); } catch { /* absent label */ }
  let findings = [];
  if (result === 'BLOCKED') {
    const review = tryArtifact(repo, run.id, 'agent-final-review') || tryArtifact(repo, run.id, 'agent-review');
    findings = Array.isArray(review?.blocking_findings) ? review.blocking_findings : [];
  }
  // No repeat follow-up creation for a repeated delivery of the same event.
  if (commentsContain(repo, dashboard, marker)) return;
  const followup = result === 'BLOCKED' ? followupIssue(repo, owner, receipt, findings, run.id) : null;
  const body = agentNotice({ owner, issue: receipt.issue_number, runId: run.id,
    attempt: run.run_attempt || 1, result, pr: receipt.pr_url, conclusion: run.conclusion,
    reviewFindings: findings, followupUrl: followup });
  postOnce(repo, dashboard, marker, body);
}
function handleRelease({ event, repo, owner, dashboard }) {
  const run = event.workflow_run;
  if (run.event !== 'push' || run.head_branch !== 'main' || !/^[0-9a-f]{40}$/.test(run.head_sha || '')) return;
  const response = api(`repos/${repo}/actions/runs?head_sha=${run.head_sha}&per_page=100`);
  const result = classifyReleaseRuns(response.workflow_runs || [], run.head_sha);
  if (!result) return; // The second completed run will trigger its own event immediately.
  const marker = `<!-- katie-release-notice:${run.head_sha} -->`;
  postOnce(repo, dashboard, marker, releaseNotice({ owner, sha: run.head_sha, result, repo }));
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = event.workflow_run;
  if (!run || run.status !== 'completed' || !ALLOWED_WORKFLOWS.has(run.name)) return;
  const repo = process.env.GITHUB_REPOSITORY;
  if (run.head_repository?.full_name !== repo) return;
  const owner = process.env.KATIE_NOTIFICATION_OWNER;
  const dashboard = Number(process.env.KATIE_STATUS_ISSUE);
  if (!repo || !owner || !Number.isSafeInteger(dashboard) || dashboard < 1) throw new Error('Notification target is not configured');
  if (run.name === 'Katie autonomous development') handleAgent({event,repo,owner,dashboard});
  else handleRelease({event,repo,owner,dashboard});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error('Katie event notification failed:', error.message); process.exitCode = 1; });
}
).test(payload.pr_url)))) {
    throw new Error('Invalid or untrusted autonomous completion receipt');
  }
  return payload;
}
export function classifyAgentResult(receipt, conclusion) {
  return conclusion === 'success' && receipt?.outcome === 'READY' ? 'READY' : 'BLOCKED';
}
export function classifyReleaseRuns(runs, sha) {
  const selected = {};
  for (const name of ['ci', 'migrate-and-deploy']) {
    const eligible = runs.filter(r => r.name === name && r.head_sha === sha &&
      r.event === 'push' && r.head_branch === 'main');
    eligible.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    if (!eligible.length || eligible[0].status !== 'completed') return null;
    selected[name] = eligible[0];
  }
  return { status: Object.values(selected).every(r => r.conclusion === 'success') ? 'PASSED' : 'BLOCKED', runs: selected };
}
export function agentNotice({ owner, issue, runId, attempt, result, pr, conclusion, reviewFindings = [], followupUrl = null }) {
  const marker = `<!-- katie-agent-notice:${runId}:${attempt} -->`;
  const status = result === 'READY' ? 'READY — independent tests and review passed' : 'BLOCKED — action required';
  const findings = result === 'BLOCKED' && reviewFindings.length ?
    `\n\nBlocking review findings:\n${reviewFindings.slice(0, 8).map(f => `- ${String(f).slice(0, 700)}`).join('\n')}` : '';
  return `${marker}\n@${owner} **Katie autonomous agent: ${status}**\n\n` +
    `- Development task: #${issue}\n- [Workflow and logs](https://github.com/${process.env.GITHUB_REPOSITORY || 'mfackrell/katie'}/actions/runs/${runId})` +
    `${pr ? `\n- Draft pull request: ${pr}` : '\n- No pull request was created'}` +
    `\n- Workflow conclusion: ${conclusion}${findings}` +
    `${followupUrl ? `\n- Follow-up work item: ${followupUrl}` : ''}` +
    '\n\n**No automatic merge or production deployment occurred.**';
}
export function releaseNotice({ owner, sha, result, repo }) {
  const marker = `<!-- katie-release-notice:${sha} -->`;
  return `${marker}\n@${owner} **Katie main-branch checks: ${result.status === 'PASSED' ? 'PASSED' : 'BLOCKED'}**\n\n` +
    `- Commit: [\`${sha.slice(0, 12)}\`](https://github.com/${repo}/commit/${sha})\n` +
    `- [CI run](https://github.com/${repo}/actions/runs/${result.runs.ci.id}): ${result.runs.ci.conclusion}\n` +
    `- [Database migration run](https://github.com/${repo}/actions/runs/${result.runs['migrate-and-deploy'].id}): ${result.runs['migrate-and-deploy'].conclusion}\n\n` +
    '**These are GitHub checks only. Vercel production readiness has not been verified by this notification.**';
}

function gh(...args) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 }).trim(); }
function api(path) { return JSON.parse(gh('api', path)); }
function ensureLabel(repo, label, color) {
  try { gh('label', 'create', label, '--repo', repo, '--color', color); }
  catch (error) { if (!String(error.stderr || error.message).includes('already exists')) throw error; }
}
function commentsContain(repo, issue, marker) {
  // GitHub CLI streams every page without writing into the checkout or executing issue text.
  return gh('api', '--paginate', `repos/${repo}/issues/${issue}/comments?per_page=100`, '--jq', '.[].body').includes(marker);
}
function postOnce(repo, issue, marker, body) {
  if (commentsContain(repo, issue, marker)) return false;
  gh('issue', 'comment', String(issue), '--repo', repo, '--body', body);
  return true;
}
function downloadArtifact(repo, runId, name) {
  const tmp = mkdtempSync(join(tmpdir(), 'katie-event-'));
  try {
    gh('run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', tmp);
    return JSON.parse(readFileSync(join(tmp, name === 'agent-completion' ? 'agent-result.json' :
      name === 'agent-final-review' ? 'agent-final-review.json' : 'agent-review.json'), 'utf8'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
function tryArtifact(repo, runId, name) {
  try { return downloadArtifact(repo, runId, name); } catch { return null; }
}
function followupIssue(repo, owner, receipt, findings, runId) {
  // Only one bounded follow-up triage issue. Bot-created issues cannot start the
  // owner-only coding workflow, preserving the explicit development authorization.
  const title = `[agent-followup] Review blockers for #${receipt.issue_number} (run ${runId})`;
  const listed = JSON.parse(gh('issue', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,url'));
  const existing = listed.find(x => x.title === title);
  if (existing) return existing.url;
  const body = `Automated review handoff from #${receipt.issue_number}.\n\n` +
    `- Original task: #${receipt.issue_number}\n` +
    `- Draft PR: ${receipt.pr_url || 'not created'}\n` +
    `- [Logs](https://github.com/${repo}/actions/runs/${runId})\n\n` +
    `### Blocking findings\n${findings.length ? findings.map(f => `- ${String(f).slice(0, 1800)}`).join('\n') :
      '- No structured reviewer output available; investigate workflow logs and failed checks.'}\n\n` +
    'This is an automatically queued follow-up for review. It does **not** bypass owner-authored issue authorization, automatically re-run Codex, merge, or deploy.';
  return gh('issue', 'create', '--repo', repo, '--title', title, '--body', body, '--assignee', owner);
}

function handleAgent({ event, repo, owner, dashboard }) {
  const run = event.workflow_run;
  let receipt = tryArtifact(repo, run.id, 'agent-completion');
  const marker = `<!-- katie-agent-notice:${run.id}:${run.run_attempt || 1} -->`;
  if (!receipt) {
    const body = `${marker}\n@${owner} **Katie agent: BLOCKED (missing completion report)**\n\n` +
      `[Inspect workflow](https://github.com/${repo}/actions/runs/${run.id}). ` +
      'This run failed or stopped before producing a verifiable result. No merge or deployment was authorized.';
    postOnce(repo, dashboard, marker, body);
    return;
  }
  receipt = validateReceipt(receipt, { repository: repo, runId: run.id });
  const info = JSON.parse(gh('issue', 'view', String(receipt.issue_number), '--repo', repo, '--json', 'author,title'));
  if (info.author?.login !== owner || !info.title?.startsWith('[agent]')) throw new Error('Receipt did not identify an owner-authorized issue');
  const result = classifyAgentResult(receipt, run.conclusion);
  if (receipt.pr_url) {
    const pr = JSON.parse(gh('pr', 'view', receipt.pr_url, '--repo', repo, '--json', 'headRefName'));
    if (!pr.headRefName.startsWith(`agent/issue-${receipt.issue_number}-${run.id}-`)) {
      throw new Error('Receipt PR does not belong to the completed owner-authorized agent run');
    }
  }
  ensureLabel(repo, 'agent-ready', '2DA44E');
  ensureLabel(repo, 'agent-blocked', 'CF222E');
  gh('issue', 'edit', String(receipt.issue_number), '--repo', repo, '--add-assignee', owner,
    '--add-label', result === 'READY' ? 'agent-ready' : 'agent-blocked');
  const other = result === 'READY' ? 'agent-blocked' : 'agent-ready';
  try { gh('issue', 'edit', String(receipt.issue_number), '--repo', repo, '--remove-label', other); } catch { /* absent label */ }
  let findings = [];
  if (result === 'BLOCKED') {
    const review = tryArtifact(repo, run.id, 'agent-final-review') || tryArtifact(repo, run.id, 'agent-review');
    findings = Array.isArray(review?.blocking_findings) ? review.blocking_findings : [];
  }
  // No repeat follow-up creation for a repeated delivery of the same event.
  if (commentsContain(repo, dashboard, marker)) return;
  const followup = result === 'BLOCKED' ? followupIssue(repo, owner, receipt, findings, run.id) : null;
  const body = agentNotice({ owner, issue: receipt.issue_number, runId: run.id,
    attempt: run.run_attempt || 1, result, pr: receipt.pr_url, conclusion: run.conclusion,
    reviewFindings: findings, followupUrl: followup });
  postOnce(repo, dashboard, marker, body);
}
function handleRelease({ event, repo, owner, dashboard }) {
  const run = event.workflow_run;
  if (run.event !== 'push' || run.head_branch !== 'main' || !/^[0-9a-f]{40}$/.test(run.head_sha || '')) return;
  const response = api(`repos/${repo}/actions/runs?head_sha=${run.head_sha}&per_page=100`);
  const result = classifyReleaseRuns(response.workflow_runs || [], run.head_sha);
  if (!result) return; // The second completed run will trigger its own event immediately.
  const marker = `<!-- katie-release-notice:${run.head_sha} -->`;
  postOnce(repo, dashboard, marker, releaseNotice({ owner, sha: run.head_sha, result, repo }));
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = event.workflow_run;
  if (!run || run.status !== 'completed' || !ALLOWED_WORKFLOWS.has(run.name)) return;
  const repo = process.env.GITHUB_REPOSITORY;
  if (run.head_repository?.full_name !== repo) return;
  const owner = process.env.KATIE_NOTIFICATION_OWNER;
  const dashboard = Number(process.env.KATIE_STATUS_ISSUE);
  if (!repo || !owner || !Number.isSafeInteger(dashboard) || dashboard < 1) throw new Error('Notification target is not configured');
  if (run.name === 'Katie autonomous development') handleAgent({event,repo,owner,dashboard});
  else handleRelease({event,repo,owner,dashboard});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error('Katie event notification failed:', error.message); process.exitCode = 1; });
}
