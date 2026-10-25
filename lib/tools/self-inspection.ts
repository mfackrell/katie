import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { runModelTools, type ScopedTool, type ToolAudit } from './loop';
import type { ChatGenerateParams, LlmProvider } from '@/lib/providers/types';
import { authorizeSelfToolCaller } from './authorization';

// Remote response shapes; runtime checks below gate data used as evidence.
interface Commit { sha: string; parents?: {sha: string}[]; html_url?: string }
interface TreeEntry {type: string; path: string}
interface Check {name: string; status: string; conclusion: string; html_url: string}
interface Status {context: string; state: string}
interface Deployment {uid: string; state: string; target: string; url: string; meta?: {githubCommitSha?: string}}
interface Alias {alias: string}
interface InspectionResponse {
  sha: string; truncated: boolean; tree?: TreeEntry[]; encoding: string; content: string; size: number;
  total_count: number; check_runs?: Check[]; state: string; statuses?: Status[];
  deployments?: Deployment[]; meta?: {githubCommitSha?: string; githubCommitOrg?: string; githubCommitRepo?: string};
  projectId: string; readyState: string; target: string; aliases?: Alias[]; deployment?: {id: string};
}

const empty = z.object({}).strict();
const pathSchema = z.object({ path: z.string().max(240).regex(/^(?:[\w@().-]+\/)*[\w@().-]+$/).refine(p =>
  !p.split('/').some(s => s === '..' || s === '.' || /(?:\.(?:pem|key|p12|pfx|jks)$|^id_(?:rsa|ed25519)|service[-_]?account|credential|secret|(?:^|[._-])(?:tokens?|api[-_]?keys?|passwords?)(?:[._-]|$))/i.test(s) || /^(?:\.env|\.aws|\.git|\.npmrc|\.netrc|credentials|secrets?)(?:\.|$)/i.test(s)), 'Sensitive or invalid path'),
}).strict();
const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const blocked = (reason: string) => ({ status: 'blocked', reason });

/** All resource selectors are server-owned. Model arguments can only narrow scope. */
export function createSelfInspectionTools(input: {
  actorId: string; chatId: string; requestId: string; pinnedSha?: string;
  fetchJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}): ScopedTool[] {
  let pinnedSha = input.pinnedSha && /^[a-f0-9]{40}$/.test(input.pinnedSha) ? input.pinnedSha : undefined;
  const github = async (path: string, signal: AbortSignal) => {
    const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? process.env.GH_TOKEN;
    if (!token) throw new Error('GitHub connection requires a server-side GITHUB_TOKEN with read access to mfackrell/katie.');
    return await input.fetchJson(`https://api.github.com/repos/mfackrell/katie/${path}`, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal) as InspectionResponse;
  };
  const pin = async (signal: AbortSignal) => {
    if (pinnedSha) return pinnedSha;
    const commit = await github('commits/HEAD', signal);
    if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) return null;
    return pinnedSha = commit.sha;
  };
  return [
    { name: 'github_commits', description: 'List recent commit SHAs and parent SHAs from the pinned own repository source.', parameters: objectSchema(), validate: empty,
      execute: async (_, signal) => {
        const sha = await pin(signal); if (!sha) return blocked('GitHub source pin unavailable.');
        const commits = await github(`commits?sha=${sha}&per_page=10`, signal);
        if (!Array.isArray(commits)) return blocked('GitHub commit history unavailable.');
        return { sha, commits: commits.map((c: Commit) => ({sha:c.sha,parents:c.parents?.map(p=>p.sha),url:c.html_url})) };
      } },
    { name: 'github_source', description: 'Pin Katie own repository HEAD to an immutable SHA and list source paths. This is repository HEAD, not verified production SHA.', parameters: objectSchema(), validate: empty,
      execute: async (_, signal) => {
        const sha = await pin(signal);
        if (!sha) return blocked('Cannot authenticate and pin mfackrell/katie source. Check the GitHub connection.');
        const tree = await github(`git/trees/${sha}?recursive=1`, signal);
        return { repository: 'mfackrell/katie', sha, truncated: tree.truncated === true || (tree.tree?.length ?? 0) > 800,
          paths: tree.tree?.filter((p: TreeEntry) => p.type === 'blob' && pathSchema.safeParse({path:p.path}).success).slice(0,800).map((p: TreeEntry) => p.path) };
      } },
    { name: 'production_runtime_revision', description: 'Report the commit SHA injected by Vercel into this running server. Runtime-reported evidence only; not independent alias verification.', parameters: objectSchema(), validate: empty,
      execute: async () => {
        const sha = process.env.VERCEL_GIT_COMMIT_SHA;
        if (!sha || !/^[a-f0-9]{40}$/.test(sha)) return blocked('Runtime revision unavailable.');
        return {status:'runtime_reported',sha,source:'VERCEL_GIT_COMMIT_SHA',limitation:'Does not independently prove Vercel alias assignment or acceptance tests.'};
      } },
    { name: 'github_read_file', description: 'Read a bounded UTF-8 source file at the pinned own repository SHA. Secret/config credential paths are denied.',
      parameters: objectSchema({path:{type:'string',maxLength:240}}, ['path']), validate: pathSchema,
      execute: async (args, signal) => {
        const {path} = pathSchema.parse(args); const sha = await pin(signal);
        if (!sha) return blocked('GitHub source pin unavailable. Connect GitHub first.');
        const file = await github(`contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, signal);
        if (file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 24000) return blocked('File is not a bounded readable source file.');
        return { repository: 'mfackrell/katie', sha, path, blobSha: file.sha, text: Buffer.from(file.content, 'base64').toString('utf8') };
      } },
    { name: 'github_ci', description: 'Inspect check runs and commit statuses for the pinned own repository SHA.', parameters: objectSchema(), validate: empty,
      execute: async (_, signal) => {
        const sha = await pin(signal); if (!sha) return blocked('GitHub source pin unavailable.');
        const checks = await github(`commits/${sha}/check-runs?per_page=50`, signal);
        const statuses = await github(`commits/${sha}/status?per_page=50`, signal);
        return { sha, totalChecks: checks.total_count, checks: checks.check_runs?.map((c: Check)=>({name:c.name,status:c.status,conclusion:c.conclusion,url:c.html_url})),
          state: statuses.state, statuses: statuses.statuses?.map((c: Status)=>({context:c.context,state:c.state})), acceptance: 'Check status alone does not authorize merge or deployment.' };
      } },
    { name: 'supabase_schema', description: 'Inspect column metadata for scoped application request and tool receipt tables; no arbitrary SQL or secret values.', parameters: objectSchema(), validate: empty,
      execute: async () => {
        const {data,error} = await getSupabaseAdminClient().rpc('self_tool_schema', {});
        return error ? blocked('Scoped schema RPC is unavailable. Apply the reviewed self-tool migration through the authorized migration workflow.') : { tables:data };
      } },
    { name: 'supabase_request_receipts', description: 'Read application request status and tool receipts for this actor and chat only. No arbitrary SQL or other actors rows.', parameters: objectSchema(), validate: empty,
      execute: async () => {
        const db = getSupabaseAdminClient();
        const requests = await db.from('chat_requests').select('request_id,status,assistant_model,created_at').eq('actor_id',input.actorId).eq('chat_id',input.chatId).order('created_at',{ascending:false}).limit(10).returns();
        if (requests.error) return blocked('Supabase application read unavailable; verify server-side service credential and table access.');
        const receipts = await db.from('self_tool_receipts').select('request_id,sequence,phase,tool,provider,model,created_at').eq('actor_id',input.actorId).eq('chat_id',input.chatId).order('created_at',{ascending:false}).limit(20).returns();
        if (receipts.error) return blocked('Scoped tool receipt read unavailable. Apply the reviewed receipt migration first.');
        return { scope: {actorId:input.actorId,chatId:input.chatId}, requests: requests.data, receipts:receipts.data };
      } },
    { name: 'vercel_deployments', description: 'Inspect connected Vercel project deployment metadata. Requires server-side VERCEL_TOKEN and VERCEL_PROJECT_ID; never exposes credentials.', parameters: objectSchema(), validate: empty,
      execute: async (_, signal) => {
        const token = process.env.VERCEL_TOKEN, project = process.env.VERCEL_PROJECT_ID, team = process.env.VERCEL_TEAM_ID;
        if (!token) return blocked('Vercel management connection missing: configure VERCEL_TOKEN server-side with access to the connected Katie project. Redeploy configuration, then retry inspection. Git-triggered deployments do not verify management access.');
        if (!project) return blocked('Vercel connection missing VERCEL_PROJECT_ID. Bind the Katie project server-side before inspection.');
        const query = new URLSearchParams({projectId:project,limit:'5', ...(team ? {teamId:team} : {})});
        const data = await input.fetchJson(`https://api.vercel.com/v6/deployments?${query}`, {Authorization:`Bearer ${token}`}, signal) as InspectionResponse;
        return { projectId: project, deployments: data.deployments?.map((d: Deployment)=>({id:d.uid,state:d.state,target:d.target,url:d.url,sha:d.meta?.githubCommitSha})),
          limitation: 'Deployment metadata does not verify production alias, runtime logs or acceptance.' };
      } },
    { name: 'vercel_production', description: 'Verify READY production deployment SHA and Katie production alias through connected Vercel management API.', parameters: objectSchema(), validate: empty,
      execute: async (_, signal) => {
        const token=process.env.VERCEL_TOKEN, project=process.env.VERCEL_PROJECT_ID, team=process.env.VERCEL_TEAM_ID;
        if (!token || !project) return blocked('Vercel connection requires server-side VERCEL_TOKEN and VERCEL_PROJECT_ID (and VERCEL_TEAM_ID for a team project). No production verification has occurred.');
        const query=new URLSearchParams({projectId:project,target:'production',limit:'5',...(team?{teamId:team}:{})});
        const headers={Authorization:`Bearer ${token}`};
        const list=await input.fetchJson(`https://api.vercel.com/v6/deployments?${query}`,headers,signal) as InspectionResponse;
        const deployment=list.deployments?.find((d: Deployment)=>d.target==='production'&&d.state==='READY');
        if (!deployment || typeof deployment.uid!=='string' || !/^[a-zA-Z0-9_-]+$/.test(deployment.uid)) return blocked('No READY production deployment found for the connected project.');
        const teamQuery=team?`?${new URLSearchParams({teamId:team})}`:'';
        const detail=await input.fetchJson(`https://api.vercel.com/v13/deployments/${deployment.uid}${teamQuery}`,headers,signal) as InspectionResponse;
        const aliases=await input.fetchJson(`https://api.vercel.com/v2/deployments/${deployment.uid}/aliases${teamQuery}`,headers,signal) as InspectionResponse;
        const alias=await input.fetchJson(`https://api.vercel.com/v4/aliases/katie-mu.vercel.app${teamQuery}`,headers,signal) as InspectionResponse;
        const sha=detail.meta?.githubCommitSha;
        if (alias.projectId!==project || alias.deployment?.id!==deployment.uid || detail.meta?.githubCommitOrg!=='mfackrell' || detail.meta?.githubCommitRepo!=='katie' || detail.projectId!==project || detail.readyState!=='READY' || detail.target!=='production' || typeof sha!=='string' || !/^[a-f0-9]{40}$/.test(sha) || !aliases.aliases?.some((a: Alias)=>a.alias==='katie-mu.vercel.app')) return blocked('Production project, READY state, SHA or katie-mu.vercel.app alias could not be verified.');
        return {status:'verified',projectId:project,deploymentId:deployment.uid,sha,state:'READY',alias:'katie-mu.vercel.app',verifiedAt:new Date().toISOString()};
      } },
    { name: 'change_capability', description: 'Report required approval and connection checkpoints for GitHub changes, Supabase DML/migrations, Vercel deployment/rollback and logs. Does not authorize or perform mutations.',
      parameters: objectSchema({resource:{type:'string',enum:['github','supabase','vercel']}},['resource']), validate:z.object({resource:z.enum(['github','supabase','vercel'])}).strict(),
      execute: async args => {
        const {resource} = z.object({resource:z.enum(['github','supabase','vercel'])}).parse(args);
        return blocked(resource === 'github' ? 'Repository writes require the existing source-bound, owner-approved development task workflow and independent CI/review. This inspection tool cannot mint approval, edit unrelated branches, merge or deploy.' : resource === 'supabase'
          ? 'Supabase writes/migrations require a reviewed, owner-authorized scoped application operation. No arbitrary SQL executor or management logs connection is enabled by this tool; service-role REST access is not Supabase management API access.'
          : 'Deploy/rollback requires owner-authorized immutable commit, green CI, independent review, verified acceptance and connected Vercel management credentials. Runtime logs need a separately scoped redacted log reader. No deployment is authorized by inspection.');
      } },
  ];
}

async function boundedJson(url: string, headers: Record<string,string>, signal: AbortSignal) {
  const response = await fetch(url,{headers,signal,cache:'no-store',redirect:'error'});
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Inspection HTTP ${response.status}`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length;
    if (size > 2_000_000) throw new Error('Inspection response exceeds bounds'); chunks.push(value); }
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runSelfInspection(input: {
  request: Pick<Request, 'headers'>;
  actorId: string; chatId: string; requestId: string; provider: LlmProvider; params: ChatGenerateParams;
  deadlineMs: number; onRecord?(record: ToolAudit): void;
}) {
  const db = getSupabaseAdminClient();
  let ownerId: string;
  const authorize = async () => {
    ownerId = await authorizeSelfToolCaller(input.request, input.actorId, input.chatId);
    const request = await db.from('chat_requests').select('actor_id,chat_id,status').eq('request_id',input.requestId).maybeSingle<{actor_id:string;chat_id:string;status:string}>();
    const actor = await db.from('actors').select('name,actor_kind').eq('id',input.actorId).maybeSingle<{name:string;actor_kind:string}>();
    const chat = await db.from('chats').select('actor_id').eq('id',input.chatId).maybeSingle<{actor_id:string}>();
    if (request.error || actor.error || chat.error || request.data?.actor_id !== input.actorId || request.data.chat_id !== input.chatId || request.data.status !== 'processing' || chat.data?.actor_id !== input.actorId || actor.data?.name.trim().toLowerCase() !== 'katie' || actor.data.actor_kind !== 'standard') throw new Error('Self-tool actor/chat/request authorization denied');
  };
  await authorize();
  const checkpoints = await db.from('self_tool_receipts').select('sequence,tool,phase,result').eq('request_id',input.requestId)
    .eq('actor_id',input.actorId).eq('chat_id',input.chatId).order('sequence',{ascending:false}).limit(32)
    .returns<{sequence:number;tool:string;phase:string;result?:{sha?:string}}>();
  if (checkpoints.error) throw new Error('Durable tool receipts unavailable; apply the reviewed self-tool migration before inspection');
  const sequenceStart = Math.max(0,...(checkpoints.data ?? []).map(r=>r.sequence));
  const pinnedSha = checkpoints.data?.find(r=>['github_source','github_read_file','github_commits','github_ci'].includes(r.tool)&&r.phase==='completed'&&/^[a-f0-9]{40}$/.test(r.result?.sha ?? ''))?.result?.sha;
  return runModelTools({ ...input, sequenceStart, authorize, tools:createSelfInspectionTools({...input,pinnedSha,fetchJson:boundedJson}),
    audit: async record => {
      const {error} = await db.from('self_tool_receipts').insert({request_id:input.requestId,actor_id:input.actorId,chat_id:input.chatId,
        owner_id:ownerId,
        sequence:record.sequence,phase:record.phase,tool:record.tool,provider:record.provider,model:record.model,
        ...(record.arguments ? {arguments:record.arguments} : {}), ...(record.result ? {result:record.result} : {})});
      if (error) throw new Error('Durable tool audit unavailable; execution stopped');
    },
  });
}
