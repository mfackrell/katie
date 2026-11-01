// External transport adapters only. All planning/authorization/dispatch functions
// execute their production implementation against a disposable PostgreSQL DB.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const identifier=x=>{assert.match(x,/^[a-z_][a-z_0-9]*$/);return '"'+x+'"';};
export function postgresClient(connection,trace=[]){
 const execute=async(sql,args)=>{try{return {data:(await connection.query(sql,args)).rows,error:null};}catch(error){trace.push({boundary:'database_error',sql:sql.slice(0,180),message:error.message,code:error.code});return {data:null,error:{message:error.message,code:error.code}};}};
 return {
  rpc(name,args={}){identifier(name);const keys=Object.keys(args);keys.forEach(identifier);trace.push({boundary:'rpc',name});const promise=execute(`select ${identifier(name)}(${keys.map((k,i)=>identifier(k)+'=>$'+(i+1)).join(',')}) value`,keys.map(k=>Array.isArray(args[k])?JSON.stringify(args[k]):args[k])).then(r=>({...r,data:r.data?.[0]?.value??null}));promise.abortSignal=()=>promise;return promise;},
  from(table){identifier(table);let filters=[],ordering=[],maximum=null,offset=0,single=false,values=null,operation='select';const args=[];
   const add=(key,op,value)=>{args.push(value);filters.push(identifier(key)+' '+op+' $'+args.length);return q;};
   const run=async()=>{let sql;if(operation==='update'){const sets=Object.entries(values).map(([key,value])=>{args.push(value);return identifier(key)+'=$'+args.length;});sql=`update ${identifier(table)} set ${sets.join(',')}${filters.length?' where '+filters.join(' and '):''} returning *`;}
    else sql=`select to_jsonb(r) value from ${identifier(table)} r${filters.length?' where '+filters.join(' and '):''}${ordering.length?' order by '+ordering.join(','):''}${maximum!==null?' limit '+maximum:''}${offset?' offset '+offset:''}`;
    const r=await execute(sql,args);const rows=r.data?.map(x=>operation==='select'?x.value:x);return {...r,data:single?(rows?.[0]??null):rows};};
   const q={select:()=>q,range:(from,to)=>{assert.ok(Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&from>=0&&to>=from);offset=from;maximum=to-from+1;return q;},or:expression=>{const clauses=expression.split(',').map(part=>{const match=/^([a-z_][a-z_0-9]*)\.(eq|gt|gte|lt|lte)\.(.+)$/.exec(part);assert.ok(match,'Unsupported qualification filter: '+part);args.push(match[3]);return identifier(match[1])+' '+({eq:'=',gt:'>',gte:'>=',lt:'<',lte:'<='}[match[2]])+' $'+args.length;});filters.push('('+clauses.join(' or ')+')');return q;},eq:(k,v)=>add(k,'=',v),neq:(k,v)=>add(k,'<>',v),gt:(k,v)=>add(k,'>',v),gte:(k,v)=>add(k,'>=',v),lt:(k,v)=>add(k,'<',v),lte:(k,v)=>add(k,'<=',v),in:(k,v)=>{args.push(v);filters.push(identifier(k)+'=any($'+args.length+')');return q;},is:(k,v)=>{assert.equal(v,null);filters.push(identifier(k)+' is null');return q;},order:(k,o={})=>{ordering.push(identifier(k)+(o.ascending===false?' desc':' asc'));return q;},limit:n=>{assert.ok(Number.isSafeInteger(n)&&n>=0);maximum=n;return q;},maybeSingle:()=>{single=true;return q;},single:()=>{single=true;return q;},returns:()=>q,abortSignal:()=>q,update:v=>{operation='update';values=v;return q;},then:(yes,no)=>run().then(yes,no)};return q;
  }
 };
}
export function zipJSON(name,value){
 const file=Buffer.from(name),body=Buffer.from(JSON.stringify(value)),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(file.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(file.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+file.length,12);end.writeUInt32LE(local.length+file.length+body.length,16);
 return Buffer.concat([local,file,body,central,file,end]);
}
export function githubTransport({fixture,release,trace,issue}){
 const git=(...args)=>execFileSync('git',['--git-dir',fixture.remote,...args],{encoding:'utf8'}).trim();
 const workflow=()=>JSON.parse(readFileSync(fixture.root+'/workflow.json','utf8'));
 const artifacts=()=>JSON.parse(readFileSync(fixture.root+'/artifacts.json','utf8'));
 const binary=id=>id===2?zipJSON('agent-result.json',fixture.receipt):readFileSync(fixture.root+'/artifact.zip');
 const bound=args=>{assert.equal(args.owner,'mfackrell');assert.equal(args.repo,'katie');};
 return class GitHub{
  users={getAuthenticated:async()=>({data:{login:'mfackrell',type:'User'}})};
  request=async path=>{assert.ok(path.startsWith('GET /repos/mfackrell/katie/actions/'));return {data:path.endsWith('/zip')?binary(Number(path.match(/artifacts\/(\d+)/)[1])):path.includes('/artifacts?')?artifacts():workflow()};};
  repos={compareCommitsWithBasehead:async args=>{bound(args);assert.equal(args.basehead,fixture.baseline+'...'+fixture.completion.reviewedHeadSha);return {data:{files:[{filename:'app/pilot/page.tsx',status:'added',additions:1,deletions:0,patch:git('show',fixture.completion.reviewedHeadSha+':app/pilot/page.tsx')}]}};},get:async args=>{bound(args);return {data:{full_name:'mfackrell/katie',owner:{login:'mfackrell',type:'User'},default_branch:'main',permissions:{push:true}}};},getCommit:async()=>({data:{sha:release}}),getContent:async({path,ref})=>{assert.equal(ref,release);return {data:{type:'file',content:readFileSync(resolve(path)).toString('base64')}};}};
  git={listMatchingRefs:async({ref})=>({data:git('for-each-ref','--format=%(refname) %(objectname)','refs/'+ref).split('\n').filter(Boolean).map(line=>{const[ref,sha]=line.split(' ');return {ref,object:{sha}};})}),getCommit:async({commit_sha})=>({data:{tree:{sha:git('show','-s','--format=%T',commit_sha)},parents:git('show','-s','--format=%P',commit_sha).split(' ').map(sha=>({sha})),message:git('show','-s','--format=%B',commit_sha)}})};
  pulls={get:async args=>{bound(args);assert.equal(args.pull_number,829);assert.ok(fixture.completion);return {data:{number:829,html_url:'https://github.com/mfackrell/katie/pull/829',state:'open',draft:true,merged:false,changed_files:1,head:{sha:fixture.completion.reviewedHeadSha,ref:'agent/synthetic-task2c',repo:{full_name:'mfackrell/katie'}},base:{sha:fixture.baseline,repo:{full_name:'mfackrell/katie'}}}};}};
  actions={listJobsForWorkflowRun:async args=>{bound(args);assert.equal(args.run_id,workflow().id);assert.equal(fixture.completion.completed,true);return {data:{jobs:[{id:829,name:'build',conclusion:'success',html_url:'https://github.com/mfackrell/katie/actions/runs/132'}]}};},downloadJobLogsForWorkflowRun:async args=>{bound(args);assert.equal(args.job_id,829);return {data:fixture.verifierLog};},getWorkflow:async args=>{bound(args);assert.equal(args.workflow_id,'autonomous-development.yml');return {data:{state:'active',path:'.github/workflows/autonomous-development.yml'}};},listWorkflowRuns:async args=>{bound(args);assert.equal(args.workflow_id,'autonomous-development.yml');return {data:{workflow_runs:[workflow()]}};},getWorkflowRun:async({run_id})=>{assert.equal(run_id,workflow().id);return {data:workflow()};},listWorkflowRunArtifacts:async()=>({data:{artifacts:[...artifacts().artifacts,{id:2,name:'agent-completion',expired:false,size_in_bytes:10000}]}}),downloadArtifact:async({artifact_id})=>({data:binary(artifact_id)}),createWorkflowDispatch:async args=>{assert.equal(args.workflow_id,'autonomous-development.yml');assert.equal(args.ref,'main');trace.push({boundary:'workflow_dispatch',args,body:issue.body});}};
  issues={get:async()=>({data:issue}),update:async({body})=>{issue.body=body;trace.push({boundary:'issue_handoff_updated'});return {data:issue};}};
 };
}
