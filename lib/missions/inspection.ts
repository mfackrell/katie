import {Octokit} from '@octokit/rest';
import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {parseJSON,type Mission} from './types';

// A read binding is separate from permission to dispatch a coding workflow.
export {readOnlyRepositoryObjective} from './types';
export function inspectablePath(path:string){
 return path.length<=250&&!path.startsWith('/')&&!path.split('/').some(x=>x==='..'||x==='node_modules'||x==='.git')
  &&!/(?:^|\/)(?:\.env[^/]*|[^/]*(?:secret|credential|private[-_]?key)[^/]*|[^/]*\.(?:pem|key|p12|pfx))$/i.test(path)
  &&!/(?:package-lock|yarn\.lock|pnpm-lock|bun\.lock)/i.test(path)
  &&/\.(?:[cm]?[jt]sx?|json|ya?ml|sql|md|toml|css|html|py|go|rs|sh)$/i.test(path);
}
export function redactInspection(text:string){
 return text.replace(/(?:sk-proj-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{10,}/g,'[REDACTED_SECRET]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi,'Bearer [REDACTED]')
  .replace(/((?:[A-Za-z_][\w-]*[_-])?(?:authorization|api[_-]?key|password|token|secret|credential|private[_-]?key)s?\s*:\s*(?:string|number|boolean|unknown|any)\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s,;]+)/gi,'$1"[REDACTED]"')
  .replace(/((?:[A-Za-z_][\w-]*[_-])?(?:authorization|api[_-]?key|password|token|secret|credential|private[_-]?key)s?["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s,;]+)/gi,(match,prefix:string)=>/:\s*$/.test(prefix)&&/^(?:string|number|boolean|unknown|any|never|object)(?=[)\];,=:{?]|$)/.test(match.slice(prefix.length))?match:prefix+'"[REDACTED]"');
}
export async function repositoryInspection(mission:Mission,instruction:string,choose:(input:string)=>Promise<string>,allowance=16000){
 if(!mission.repository_id)throw Error('Read-only inspection requires a saved connected repository');
 const {data:binding,error}=await getSupabaseAdminClient().from('repo_sync_runs').select('repository_full_name').eq('id',mission.repository_id).maybeSingle<{repository_full_name:string}>();
 if(error||!binding||!/^[-\w.]+\/[-\w.]+$/.test(binding.repository_full_name))throw Error('Saved repository read binding unavailable');
 const token=process.env.GITHUB_TOKEN??process.env.GITHUB_PAT??process.env.GH_TOKEN;
 if(!token)throw Error('Existing server-side GitHub connection unavailable for read-only inspection');
 const gh=new Octokit({auth:token,request:{timeout:15000}}),[owner,repo]=binding.repository_full_name.split('/');
 const info=await gh.repos.get({owner,repo});
 const head=await gh.repos.getCommit({owner,repo,ref:info.data.default_branch});
 const sha=head.data.sha;
 const tree=await gh.git.getTree({owner,repo,tree_sha:head.data.commit.tree.sha,recursive:'true'});
 const all=tree.data.tree.filter(x=>x.type==='blob'&&x.path&&x.sha&&x.size!==undefined&&x.size<=200000&&inspectablePath(x.path));
 // Bound path metadata before any inference; no source text or credentials here.
 const paths:string[]=[];let chars=0;
 for(const item of all){if(chars+item.path!.length+4>18000)break;paths.push(item.path!);chars+=item.path!.length+4;}
 const decision=parseJSON(await choose(JSON.stringify({assignment:instruction,repository:binding.repository_full_name,sha,paths,
  manifestIncomplete:tree.data.truncated||paths.length<all.length,instruction:'Select at most 6 files from these exact paths for the assigned inspection. Return JSON only: {"paths":["path"]}. No invented paths or commands.'}))) as {paths?:unknown};
 if(!Array.isArray(decision.paths)||decision.paths.length<1||decision.paths.length>6||decision.paths.some(p=>typeof p!=='string'||!paths.includes(p)))throw Error('Read-only inspection selected a path outside the pinned source manifest');
 const selected=[...new Set(decision.paths as string[])];
 const quota=Math.min(24000,Math.max(4000,allowance)),perFile=Math.floor(quota/selected.length);
 const files=await Promise.all(selected.map(async path=>{
  const entry=all.find(x=>x.path===path)!;
  // Git blob IDs come from this pinned tree. Symlinks/submodules are never followed.
  if(entry.mode!=='100644'&&entry.mode!=='100755')throw Error('Only regular repository source files may be inspected');
  const blob=await gh.git.getBlob({owner,repo,file_sha:entry.sha!});
  if(blob.data.encoding!=='base64')throw Error('Unsupported source blob encoding');
  const raw=Buffer.from(blob.data.content,'base64').toString('utf8');
  if(raw.includes('\u0000'))throw Error('Binary source rejected');
  const source=redactInspection(raw),lines=source.split('\n');let excerpt='',throughLine=0;
  for(const line of lines){const numbered=`${throughLine+1}: ${line}\n`;if(excerpt.length+numbered.length>perFile)break;excerpt+=numbered;throughLine++;}
  return{path,blobSha:entry.sha,sourceHash:createHash('sha256').update(raw).digest('hex'),url:`https://github.com/${owner}/${repo}/blob/${sha}/${path}`,
   totalLines:lines.length,throughLine,truncated:throughLine<lines.length,excerpt};
 }));
 const checks=await gh.actions.listWorkflowRunsForRepo({owner,repo,head_sha:sha,per_page:8}).then(r=>r.data.workflow_runs.map(r=>({id:r.id,name:r.name,status:r.status,conclusion:r.conclusion,headSha:r.head_sha,url:r.html_url}))).catch(()=>null);
 return{kind:'read_only_repository_inspection',repository:binding.repository_full_name,sha,observedAt:new Date().toISOString(),files,checks,
  limitations:['Only the saved connected repository was read. No commands, writes, issues, PRs, deployments or production changes were performed.',
   'Secret-bearing spans may be redacted. Redacted text is not raw source and cannot establish a syntax or type error at the redaction boundary without independent evidence.',
   'Files and excerpts are a bounded selection, not proof that the entire source or running application was inspected. Cite exact inspected lines and identify missing coverage.',
   ...(tree.data.truncated||paths.length<all.length?['The source manifest was truncated; omitted paths were not inspected.']:[]),
   ...(checks===null?['CI history unavailable.']:['CI statuses are existing same-commit GitHub records, not tests executed by this worker.'])]};
}

/** Operational audits only receive the missions explicitly delegated in the same
 * Executive conversation. No arbitrary SQL, table names, user chats or secrets. */
export async function workflowInspection(mission:Mission){
 if(!/\baudit\b/i.test(mission.objective)||!/\b(?:workflow|operational|assignment histor|execution record)/i.test(mission.objective))return null;
 const db=getSupabaseAdminClient();
 const {data:binding,error}=await db.from('executive_delegations').select('actor_id,chat_id').eq('mission_id',mission.id).maybeSingle<{actor_id:string;chat_id:string}>();
 if(error)throw Error('Operational inspection binding unavailable');if(!binding)return null;
 const {data:delegations,error:de}=await db.from('executive_delegations').select('id,mission_id,status,capability,created_at,updated_at').eq('actor_id',binding.actor_id).eq('chat_id',binding.chat_id).order('created_at',{ascending:false}).limit(10).returns<{id:string;mission_id:string|null;status:string;capability:string;created_at:string;updated_at:string} >();
 if(de)throw Error('Scoped delegation trace unavailable');
 const ids=(delegations??[]).flatMap(d=>d.mission_id?[d.mission_id]:[]);if(!ids.includes(mission.id))throw Error('Mission missing from scoped operational trace');
 const [missions,jobs]=await Promise.all([
  db.from('agent_missions').select('id,status,calls,routing_calls,actual_tokens,reserved_tokens,token_allowance,detail,created_at,updated_at').in('id',ids).limit(10),
  db.from('mission_assignments').select('id,mission_id,job_key,role,status,attempts,detail,created_at,updated_at').in('mission_id',ids).order('updated_at',{ascending:false}).limit(25)
 ]);
 if(missions.error||jobs.error)throw Error('Scoped execution trace unavailable');
 const text=JSON.stringify({delegations,missions:missions.data,jobs:jobs.data},(_key,value)=>typeof value==='string'?redactInspection(value):value);
 const clean=JSON.parse(text) as {missions:Array<Record<string,unknown>>};
 return{kind:'scoped_workflow_trace',observedAt:new Date().toISOString(),actorId:binding.actor_id,chatId:binding.chat_id,
  trace:text.length<=12000?clean:{missions:clean.missions.map(m=>({...m,detail:typeof m.detail==='string'?m.detail.slice(0,400):m.detail})),omitted:'Assignment/delegation details exceed the bounded evidence envelope.'},
  limitations:['Only saved missions delegated in this Executive conversation were queried. No other chat content, provider secrets, database-wide logs or live browser behavior was inspected.']};
}
