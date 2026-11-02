import test,{after} from 'node:test';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';

const cases=[];
function record(name,kind='negative'){cases.push({name,kind,verdict:'PASS',evidenceClass:'DETERMINISTIC_FIXTURE',validator:'actual production code'});}
after(()=>{if(process.env.KATIE_TASK4A_CASE_REPORT)writeFileSync(process.env.KATIE_TASK4A_CASE_REPORT,JSON.stringify({version:1,task:'4A',headSha:process.env.QUALIFICATION_HEAD_SHA??null,cases},null,2)+'\n');});
const host='katie-abcdef123-mark-fackrells-projects.vercel.app';
const origin='https://'+host;
const sha='a'.repeat(40);
const projectId=randomUUID();
const contractHash='b'.repeat(64);
const pattern='^katie-([a-z0-9]{9})-mark-fackrells-projects\\.vercel\\.app$';

async function withFixtureEnv(run){
 const keys=['GITHUB_TOKEN','PROJECT_PREVIEW_BYPASS_SECRET','PROJECT_PREVIEW_HOST_PATTERN'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.GITHUB_TOKEN='fixture-only-github-token';
 process.env.PROJECT_PREVIEW_BYPASS_SECRET='fixture-only-edge-secret';
 process.env.PROJECT_PREVIEW_HOST_PATTERN=pattern;
 try{return await run();}
 finally{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
}
const edgeResponse=(cookie='_vercel_jwt=fixture-cookie; Path=/; Secure; HttpOnly',location='/')=>
 new Response(null,{status:302,headers:{'set-cookie':cookie,location}});
const cookieRequest=async(_url,options)=>{
 assert.equal(options.redirect,'manual');
 assert.equal(options.headers['x-vercel-protection-bypass'],'fixture-only-edge-secret');
 return edgeResponse();
};

test('Task 4A: source-bound immutable URL validator rejects aliases, paths, queries and invalid hosts',async()=>{
 await withFixtureEnv(async()=>{
  const {immutablePreviewUrl}=modules()('@/lib/agents/development');
  assert.equal(immutablePreviewUrl(origin),origin+'/');record('valid immutable Vercel deployment origin','positive');
  for(const candidate of [
   origin+'/other',origin+'/?x=1',origin+'/#fragment',
   'https://katie-git-feature-mark-fackrells-projects.vercel.app',
   'https://katie-mark-fackrells-projects.vercel.app',
   'https://katie-abcdef12-mark-fackrells-projects.vercel.app',
   'https://katie-abcdef123-other-team.vercel.app',
   'https://other-abcdef123-mark-fackrells-projects.vercel.app',
   'https://katie-abcdef123-mark-fackrells-projects.vercel.app.evil.test',
   'http://'+host,'https://user@'+host,'https://'+host+':8443/',
  ]){assert.equal(immutablePreviewUrl(candidate),null,candidate);record('reject immutable URL: '+candidate);}
 });
});

test('Task 4A: protected access fails closed with exact-host cookies and no credential-free success',async()=>{
 await withFixtureEnv(async()=>{
  const {previewCookies,PreviewAccessUnavailable}=modules()('@/lib/projects/preview');
  const cookies=await previewCookies(origin,cookieRequest);
  assert.equal(cookies.length,1);
  assert.equal(cookies[0].domain,host);
  assert.equal(cookies[0].name,'_vercel_jwt');
  assert.equal(cookies[0].httpOnly,true);
  assert.equal(cookies[0].secure,true);
  assert.equal(JSON.stringify(cookies).includes('fixture-only-edge-secret'),false);record('valid edge-only host-scoped Secure HttpOnly cookie','positive');
  delete process.env.PROJECT_PREVIEW_BYPASS_SECRET;
  let called=false;
  await assert.rejects(previewCookies(origin,async()=>{called=true;return new Response('Unprotected app',{status:200});}),/requires authentication/);
  assert.equal(called,false,'missing credential may never be treated as an unprotected success');record('missing bypass credential cannot accept HTTP 200');
  process.env.PROJECT_PREVIEW_BYPASS_SECRET='fixture-only-edge-secret';
  for(const [name,response] of [
   ['missing cookie',new Response(null,{status:302,headers:{location:'/'}})],
   ['expired max-age',edgeResponse('_vercel_jwt=old; Secure; HttpOnly; Max-Age=0')],
   ['unusable short max-age',edgeResponse('_vercel_jwt=old; Secure; HttpOnly; Max-Age=1')],
   ['expired expires',edgeResponse('_vercel_jwt=old; Secure; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT')],
   ['parent-domain cookie',edgeResponse('_vercel_jwt=bad; Secure; HttpOnly; Domain=.vercel.app')],
   ['wrong host cookie',edgeResponse('_vercel_jwt=bad; Secure; HttpOnly; Domain=other.vercel.app')],
   ['non-root path cookie',edgeResponse('_vercel_jwt=bad; Secure; HttpOnly; Path=/other')],
   ['not HttpOnly',edgeResponse('_vercel_jwt=bad; Secure')],
   ['not Secure',edgeResponse('_vercel_jwt=bad; HttpOnly')],
   ['non-authenticated 200',new Response('App',{status:200})],
   ['off-origin redirect',edgeResponse('_vercel_jwt=bad; Secure; HttpOnly','https://attacker.test/')],
   ['invalid redirect',edgeResponse('_vercel_jwt=bad; Secure; HttpOnly','https://%')],
  ]){
   await assert.rejects(previewCookies(origin,async()=>response),PreviewAccessUnavailable,name);record('reject cookie: '+name);
  }
  const reauth=await previewCookies(origin,async()=>edgeResponse('_vercel_jwt=ok; Secure; HttpOnly; Max-Age=120','/'));
  assert.equal(reauth[0].value,'ok');record('usable expiring Max-Age cookie','positive');
  assert.ok(reauth[0].expires <= Math.floor(Date.now()/1000)+120,'browser cookie expiry cannot outlive Vercel cookie');
  let crossHostCalls=0;
  await assert.rejects(previewCookies('https://katie-abcdef124-other-team.vercel.app',async()=>{crossHostCalls++;return edgeResponse();}),PreviewAccessUnavailable);
  assert.equal(crossHostCalls,0,'secret cannot be forwarded to another deployment or team');record('cross-deployment credential forwarding rejected');
 });
});

test('Task 4A: reject untrusted contract paths before minting or transmitting a Preview cookie',async()=>{
 await withFixtureEnv(async()=>{
  const {verifyDeployedPreview}=modules()('@/lib/projects/preview');
  const preview={url:origin,headSha:sha,deploymentId:1,statusId:2};
  for(const path of ['https://attacker.test/steal','//attacker.test/steal','/%2f%2fattacker.test/steal']){
   let requests=0,renders=0;
   const contract={path,scenarios:[{name:'state',steps:[{action:'expectVisible',selector:'#state'}]}]};
   await assert.rejects(verifyDeployedPreview(preview,contract,projectId,async()=>{
    requests++;return edgeResponse();
   },async()=>{renders++;return[];}),undefined,path);
   assert.equal(requests,0,'Invalid path must not initiate even the credential-minting request');
   assert.equal(renders,0,'Invalid path must not launch browser assertions');
   record('reject pre-authentication contract path: '+path);
  }
 });
});

test('Task 4A: immutable Preview root is required before authentication',async()=>{
 await withFixtureEnv(async()=>{
  const {verifyDeployedPreview}=modules()('@/lib/projects/preview');
  const contract={path:'/pilot',scenarios:[{name:'state',steps:[{action:'expectVisible',selector:'#state'}]}]};
  for(const url of [origin+'/other',origin+'/?ignored=1','https://katie-git-feature-mark-fackrells-projects.vercel.app/']){
   let requests=0;
   await assert.rejects(verifyDeployedPreview({url,headSha:sha,deploymentId:1,statusId:2},contract,projectId,async()=>{
    requests++;return edgeResponse();
   }),undefined,url);
   assert.equal(requests,0,'Mutable or non-root Preview URL cannot trigger an authenticated request');
   record('reject non-immutable acceptance origin: '+url);
  }
  const requests=[];
  const passed=await verifyDeployedPreview({url:origin+'/pilot',headSha:sha,deploymentId:1,statusId:2},contract,projectId,async (url,options)=>{
   requests.push(String(url));
   return options.headers?.['x-vercel-protection-bypass']?edgeResponse():new Response('Fixture application',{status:200});
  },async()=>[{name:'state',passed:true,detail:'Bound approved fixture'}]);
  assert.equal(requests.length,2);
  assert.equal(requests[1],origin+'/pilot','App HTTP request must match approved path');
  assert.equal(passed.passed,true);
  record('approved app path on immutable deployment succeeds','positive');
 });
});

test('Task 4A: reachability check blocks cross-origin redirects before browser execution',async()=>{
 await withFixtureEnv(async()=>{
  const {verifyDeployedPreview,PreviewAccessUnavailable}=modules()('@/lib/projects/preview');
  const preview={url:origin+'/pilot',headSha:sha,deploymentId:1,statusId:2};
  const contract={path:'/pilot',scenarios:[{name:'state',steps:[{action:'expectVisible',selector:'#state'}]}]};
  let renders=0,requests=0;
  const request=async(_url,options)=>{
   requests++;
   return options.headers?.['x-vercel-protection-bypass']?edgeResponse():new Response(null,{status:302,headers:{location:'https://attacker.test/'}});
  };
  await assert.rejects(verifyDeployedPreview(preview,contract,projectId,request,async()=>{renders++;return[];}),PreviewAccessUnavailable);
  assert.equal(requests,2);
  assert.equal(renders,0);record('off-origin app redirect blocked before rendering');
 });
});

test('Task 4A: production deployment discovery validates real receipt, draft SHA, bot status, immutable origin and fresh head',async()=>{
 await withFixtureEnv(async()=>{
  const binding={projectId,contractHash,scenarioNames:['state']};
  const accepted={version:1,repository:'mfackrell/katie',run_id:42,issue_number:88,
   pr_url:'https://github.com/mfackrell/katie/pull/99',outcome:'READY',
   checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'skipped',final_review:'skipped'},
   tested_head_sha:sha,reviewed_head_sha:sha,
   projectAcceptance:{version:1,projectId,contractHash,headSha:sha,passed:true,
    checks:[{name:'state',passed:true,detail:'Actual local rendered assertion fixture'}]}};
  const task={id:randomUUID(),repository_id:randomUUID(),repository_full_name:'mfackrell/katie',status:'ready',
   external:{issueNumber:88,receipt:accepted}};
  const basePr={number:99,state:'open',draft:true,merged:false,
   head:{sha,repo:{full_name:'mfackrell/katie'}},base:{repo:{full_name:'mfackrell/katie'}}};
  const deploy={id:101,sha,creator:{login:'vercel[bot]'},production_environment:false,environment:'Preview'};
  const status={id:202,state:'success',creator:{login:'vercel[bot]'},environment:'Preview',environment_url:origin};
  let settings={pr:basePr,afterPr:null,deployment:deploy,status,prReads:0,dbRepo:'mfackrell/katie',ghReads:0};
  class Octokit {
   pulls={get:async()=>{settings.prReads++;return {data:settings.afterPr&&settings.prReads===2?settings.afterPr:settings.pr};}};
   repos={
    listDeployments:async()=>{settings.ghReads++;return {data:settings.deployment?[settings.deployment]:[]};},
    listDeploymentStatuses:async()=>({data:settings.status?[settings.status]:[]})
   };
  }
  const db={from:table=>{assert.equal(table,'repo_sync_runs');return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{repository_full_name:settings.dbRepo},error:null})};}};
  const {developmentPreview}=modules({
   '@octokit/rest':{Octokit},
   '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db}
  })('@/lib/agents/development');
  const reset=()=>{settings={...settings,pr:basePr,afterPr:null,deployment:deploy,status,prReads:0,ghReads:0,dbRepo:'mfackrell/katie'};};
  reset();const valid=await developmentPreview(task,binding);
  assert.equal(valid.headSha,sha);assert.equal(valid.deploymentId,101);assert.equal(valid.statusId,202);
  assert.equal(valid.url,origin+'/');assert.equal(settings.prReads,2);record('same-head approved draft and Vercel bot success','positive');
  const negatives=[
   ['wrong connected repository',{dbRepo:'another/repo'},'reject'],
   ['PR repository mismatch',{pr:{...basePr,head:{...basePr.head,repo:{full_name:'other/repo'}}}},'reject'],
   ['PR head already stale',{pr:{...basePr,head:{...basePr.head,sha:'b'.repeat(40)}}},'reject'],
   ['PR head changes during status verification',{afterPr:{...basePr,head:{...basePr.head,sha:'b'.repeat(40)}}},'reject'],
   ['wrong deployed SHA',{deployment:{...deploy,sha:'b'.repeat(40)}},'missing'],
   ['production presented as preview',{deployment:{...deploy,production_environment:true}},'missing'],
   ['not a preview environment',{deployment:{...deploy,environment:'Production'}},'missing'],
   ['forged deployment creator',{deployment:{...deploy,creator:{login:'imposter'}}},'missing'],
   ['pending provider status',{status:{...status,state:'pending'}},'missing'],
   ['failed provider status',{status:{...status,state:'failure'}},'missing'],
   ['forged status creator',{status:{...status,creator:{login:'imposter'}}},'missing'],
   ['missing status',{status:null},'missing'],
   ['missing deployment',{deployment:null},'missing'],
   ['mutable branch alias',{status:{...status,environment_url:'https://katie-git-feature-mark-fackrells-projects.vercel.app'}},'missing'],
   ['wrong deployment nonce',{status:{...status,environment_url:'https://katie-abcdef12-mark-fackrells-projects.vercel.app'}},'missing'],
   ['different Vercel project',{status:{...status,environment_url:'https://other-abcdef123-mark-fackrells-projects.vercel.app'}},'missing'],
   ['environment URL with path',{status:{...status,environment_url:origin+'/other'}},'missing'],
  ];
  for(const [name,change,expected] of negatives){
   reset();settings={...settings,...change};
   if(expected==='reject')await assert.rejects(developmentPreview(task,binding),undefined,name);
   else assert.equal(await developmentPreview(task,binding),null,name);
   record('reject GitHub deployment evidence: '+name);
  }
  reset();await assert.rejects(developmentPreview({...task,status:'blocked'},binding),/Head-bound/);record('non-ready task rejected');
  await assert.rejects(developmentPreview({...task,external:{...task.external,receipt:{...accepted,tested_head_sha:'b'.repeat(40)}}},binding),/Head-bound/);record('invalid completion receipt rejected');
  await assert.rejects(developmentPreview({...task,external:{...task.external,receipt:{...accepted,projectAcceptance:{...accepted.projectAcceptance,projectId:randomUUID()}}}},binding),/Head-bound/);
  await assert.rejects(developmentPreview({...task,external:{...task.external,receipt:{...accepted,projectAcceptance:undefined}}},binding),/Head-bound/);
  assert.ok(settings.ghReads===0,'invalid completion receipts never inspect deployments');
 });
});
