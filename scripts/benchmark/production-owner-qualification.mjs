import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
const DOMAIN='katie:benchmark715:production-owner-qualification:v1\0';
const deny=()=>{throw Error('PRODUCTION_OWNER_QUALIFICATION_DENIED')};
export function signQualification(payload,key){
 if(typeof key!=='string'||key.length<32)deny();
 const content=Buffer.from(JSON.stringify(payload)).toString('base64url');
 return content+'.'+createHmac('sha256',key).update(DOMAIN+content).digest('base64url');
}
export function readQualification(envelope,key,now=Date.now()){
 if(typeof envelope!=='string'||envelope.length>16000||typeof key!=='string'||key.length<32)deny();
 const match=/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(envelope);
 if(!match)deny();
 const expected=createHmac('sha256',key).update(DOMAIN+match[1]).digest();
 const actual=Buffer.from(match[2],'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(expected,actual))deny();
 let p;try{p=JSON.parse(Buffer.from(match[1],'base64url').toString())}catch{deny()}
 if(p?.version!==1||p.authorization!=='production-715-30usd-350000tokens-4hours'||
  !/^\d{1,16}$/.test(p.runId??'')||!Number.isSafeInteger(p.runAttempt)||p.runAttempt<1||
  !/^[a-f0-9]{40}$/.test(p.sha??'')||!Number.isSafeInteger(p.expiresAt)||
  p.expiresAt<=now||p.expiresAt>now+300000||!['prepare','commit'].includes(p.phase)||
  (p.phase==='commit'?!p.transfer:p.transfer!==null)||
  (p.consentId!==undefined&&!/^[a-f0-9-]{36}$/.test(p.consentId))||
  Object.keys(p).sort().join()!==['version','authorization','phase','runId','runAttempt','sha','expiresAt','transfer',...(p.consentId===undefined?[]:['consentId'])].sort().join())deny();
 return p;
}
export function verifyOwnerRun({payload,run,comment,workflow,checks,jobs,deployedSha,config,dashboardConsentVerified=false}){
 const owner=u=>u?.id===config.ownerGithubId&&u?.login===config.ownerLogin;
 if(payload.sha!==deployedSha||String(run?.id)!==payload.runId||run.run_attempt!==payload.runAttempt||
  run.event!=='workflow_dispatch'||run.head_branch!=='main'||run.head_sha!==payload.sha||
  run.status!=='in_progress'||
  (payload.consentId?dashboardConsentVerified!==true:(!owner(run.actor)||!owner(run.triggering_actor)))||
  run.repository?.id!==config.repositoryId||run.repository?.full_name!==config.repository||
  !owner(run.repository?.owner)||run.path!==config.workflowPath||
  workflow?.id!==run.workflow_id||workflow.path!==config.workflowPath||workflow.state!=='active')deny();
 if(comment?.id!==config.authorizationCommentId||!owner(comment.user)||
  comment.html_url!==`https://github.com/${config.repository}/issues/715#issuecomment-${config.authorizationCommentId}`||
  typeof comment.body!=='string'||createHash('sha256').update(comment.body.trimEnd()).digest('hex')!==config.authorizationBodySha256)deny();
 const ci=checks.filter(c=>c.path==='.github/workflows/ci.yml'&&c.head_sha===payload.sha&&c.event==='push'&&c.head_branch==='main');
 ci.sort((a,b)=>Number(b.id)-Number(a.id));
 if(ci[0]?.status!=='completed'||ci[0]?.conclusion!=='success'||
    !jobs.some(j=>j.name==='qualify_gateway / native-gateway'&&j.head_sha===payload.sha&&
      String(j.run_id)===payload.runId&&j.status==='completed'&&j.conclusion==='success'))deny();
 if(payload.phase==='prepare')return payload;
 const t=payload.transfer;
 if(t.issue!==715||t.ownerGithubId!==config.ownerGithubId||t.authorizationCommentId!==config.authorizationCommentId||
  t.authorizationBodySha256!==config.authorizationBodySha256||t.sourceDatabase!==config.stagingDatabaseUrl||
  t.destinationDatabase!==config.productionDatabaseUrl||!/^\d+$/.test(t.ownerRunId??'')||
  !/^[a-f0-9-]{36}$/.test(t.experimentId??'')||!Number.isFinite(Date.parse(t.deadline))||
  Object.entries(config.protocol).filter(([k])=>k.endsWith('_sha256')||k==='baselineSha')
    .some(([k,v])=>t.protocol?.[k]!==v))deny();
 return payload;
}
