import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID, webcrypto } from 'node:crypto';
const native=createRequire(import.meta.url);
function modules(overrides={}){
 for(const [key,value] of Object.entries(overrides))if(key.startsWith('@/'))overrides[resolve(key.slice(2))]=value;
 const cache=new Map();
 const load=name=>{
  if(name in overrides)return overrides[name];
  if(!name.startsWith('@/')&&!name.startsWith('/')&&!name.startsWith('.'))return native(name);
  let path=name.startsWith('@/')?resolve(name.slice(2)):resolve(name);
  if(path.endsWith('.mjs'))return native(path);
  if(!path.endsWith('.ts'))path=existsSync(path+'.ts')?path+'.ts':resolve(path,'index.ts');
  if(cache.has(path))return cache.get(path);
  const exports={};cache.set(path,exports);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>n.startsWith('.')?load(resolve(dirname(path),n)):load(n),process,Buffer,Date,JSON,console,Set,Map,URL,URLSearchParams,TextEncoder,TextDecoder,Request,Response,Headers,ReadableStream,AbortController,AbortSignal,File,Blob,fetch,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval},{filename:path});
  return exports;
 };
 return load;
}

function repositoryFixture({mode='100644',choosePath='lib/core.ts'}={}){
 const reads=[];let ref;
 class GitHub {
  repos={get:async()=>({data:{default_branch:'main'}}),getCommit:async args=>{ref=args.ref;return{data:{sha:'a'.repeat(40),commit:{tree:{sha:'tree'}}}};}};
  git={getTree:async args=>{reads.push(args);return{data:{truncated:false,tree:[{path:'lib/core.ts',sha:'blob',type:'blob',mode,size:40},{path:'.env.production',sha:'secret',type:'blob',mode:'100644',size:20}]}};},getBlob:async args=>{reads.push(args);return{data:{encoding:'base64',content:Buffer.from('const API_KEY="sk-proj-abcdefghijklmnop";\nexport const value = 42;').toString('base64')}};}};
  actions={listWorkflowRunsForRepo:async args=>{reads.push(args);return{data:{workflow_runs:[{id:1,head_sha:'a'.repeat(40),status:'completed',conclusion:'success'}]}};}};
 }
 const db={from:table=>({select:()=>({eq:(key,value)=>({maybeSingle:async()=>({data:{repository_full_name:'owner/repo'}})})})})};
 const api=modules({'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}})('@/lib/missions/inspection');
 return{api,reads,run:()=>api.repositoryInspection({repository_id:'bound-repo'},'Inspect implementation',async input=>{const manifest=JSON.parse(input);assert.equal(manifest.paths.includes('.env.production'),false);return JSON.stringify({paths:[choosePath]});}),ref:()=>ref};
}
test('repository inspection pins source, reads only selected regular blobs, redacts keys and records actual CI provenance',async()=>{
 const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-only';try{
  const f=repositoryFixture(),r=await f.run();assert.equal(r.sha,'a'.repeat(40));assert.equal(f.ref(),'main');
  assert.equal(r.files[0].blobSha,'blob');assert.match(r.files[0].excerpt,/2: export const value = 42/);assert.doesNotMatch(r.files[0].excerpt,/sk-proj/);
  assert.equal(r.checks[0].headSha,r.sha);assert.equal(f.reads.at(-1).head_sha,r.sha);assert.match(r.limitations.join(' '),/No commands, writes/);
  assert.ok(r.files[0].url.includes('/blob/'+r.sha+'/lib/core.ts'));
 }finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}
});
test('inspection rejects secret paths, traversal, invented paths and symlinks before blob access',async()=>{
 const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-only';try{
  const f=repositoryFixture({choosePath:'.env.production'});await assert.rejects(f.run(),/outside the pinned/);assert.equal(f.reads.some(x=>x.file_sha),false);
  const link=repositoryFixture({mode:'120000'});await assert.rejects(link.run(),/regular/);assert.equal(link.reads.some(x=>x.file_sha),false);
  for(const path of ['../file.ts','.env','config/credentials.json','config/private_key.ts','id.pem'])assert.equal(f.api.inspectablePath(path),false);
 }finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}
});
test('operational evidence is constrained to the bound Executive actor and conversation',async()=>{
 const filters=[];
 const rows={executive_delegations:[{id:'d',mission_id:'m',actor_id:'owner',chat_id:'conversation'}],agent_missions:[{id:'m',status:'running',detail:'CLIENT_SECRET = \"opaque-workflow-secret\"; sk-proj-abcdefghijklmnop '+'.'.repeat(13000)}],mission_assignments:[{id:'j',mission_id:'m'}]};
 const db={from:table=>{const q={select:()=>q,eq:(k,v)=>{filters.push([table,k,v]);return q;},in:(k,v)=>{filters.push([table,k,Array.from(v)]);return q;},order:()=>q,limit:()=>q,returns:async()=>({data:rows[table]}),maybeSingle:async()=>({data:rows[table][0]}),then:resolve=>Promise.resolve({data:rows[table]}).then(resolve)};return q;}};
 const api=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}})('@/lib/missions/inspection');
 const evidence=await api.workflowInspection({id:'m',objective:'Audit operational workflow traces'});
 assert.doesNotMatch(JSON.stringify(evidence),/sk-proj|opaque-workflow-secret/);assert.ok(JSON.stringify(evidence).length<12000);
 assert.equal(evidence.actorId,'owner');assert.equal(evidence.chatId,'conversation');
 assert.ok(filters.some(x=>x[0]==='executive_delegations'&&x[1]==='actor_id'&&x[2]==='owner'));
 assert.ok(filters.some(x=>x[0]==='executive_delegations'&&x[1]==='chat_id'&&x[2]==='conversation'));
 assert.ok(filters.filter(x=>x[1]==='mission_id'&&Array.isArray(x[2])).every(x=>x[2].join(',')==='m'));
 assert.equal(await api.workflowInspection({id:'m',objective:'Write a letter'}),null);
});

test('generic credentials are scrubbed from code, JSON and raw Authorization headers',()=>{
 const {api}=repositoryFixture();
 const source='const AUTH_TOKEN = "opaque-token-123"; const CLIENT_SECRET = "opaque-secret-456"; '+
  '{"token":"opaque-json-789","apiKey":"opaque-key-123","refresh_token":"opaque-refresh-456"}\nAuthorization: Bearer opaque-bearer-789';
 const clean=api.redactInspection(source);
 for(const secret of ['opaque-token-123','opaque-secret-456','opaque-json-789','opaque-key-123','opaque-refresh-456','opaque-bearer-789'])assert.equal(clean.includes(secret),false,secret);
});
