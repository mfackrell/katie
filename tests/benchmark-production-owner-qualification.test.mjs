import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
import {frozenProtocol} from '../scripts/benchmark/owner-staging-bootstrap.mjs';
import {readQualification,signQualification,verifyOwnerRun} from '../scripts/benchmark/production-owner-qualification.mjs';
const key='test-only-qualification-key-32-characters-long';
const owner={id:203683423,login:'mfackrell'};
const sha='a'.repeat(40),head='b'.repeat(40);
const payload=()=>({version:1,phase:'commit',authorization:'production-715-30usd-350000tokens-4hours',runId:'12345',runAttempt:1,sha,expiresAt:Date.now()+120000,
 transfer:{issue:715,ownerGithubId:203683423,authorizationCommentId:6424150566,authorizationBodySha256:config.authorizationBodySha256,
 sourceDatabase:config.stagingDatabaseUrl,destinationDatabase:config.productionDatabaseUrl,ownerRunId:'12345',
 experimentId:'11111111-1111-4111-8111-111111111111',deadline:new Date(Date.now()+14400000).toISOString(),protocol:config.protocol}});
const evidence=()=>({payload:payload(),deployedSha:sha,config,
 run:{id:12345,run_attempt:1,event:'workflow_dispatch',head_branch:'main',head_sha:sha,status:'in_progress',actor:owner,triggering_actor:owner,
 repository:{id:1164130400,full_name:'mfackrell/katie',owner},path:config.workflowPath,workflow_id:88},
 workflow:{id:88,path:config.workflowPath,state:'active'},
 comment:{id:config.authorizationCommentId,user:owner,html_url:`https://github.com/mfackrell/katie/issues/715#issuecomment-${config.authorizationCommentId}`,
 body:readFileSync('config/benchmark-715-owner-authorization.txt','utf8').trimEnd()},
 checks:[{id:1,path:'.github/workflows/ci.yml',head_sha:sha,event:'push',head_branch:'main',status:'completed',conclusion:'success'}],
 jobs:[{name:'qualify_gateway / native-gateway',head_sha:sha,run_id:12345,status:'completed',conclusion:'success'}]});
test('production projection is exactly the established staging frozen contract, not a replacement benchmark',()=>{
 assert.deepEqual(config.protocol,frozenProtocol());
 assert.equal(config.authorizationBodySha256,createHash('sha256').update(evidence().comment.body).digest('hex'));
});
test('handoff has domain separation and rejects tampering, expired or future tokens, and native handoff signatures',()=>{
 const p=payload();assert.deepEqual(readQualification(signQualification(p,key),key),p);
 const encoded=signQualification(p,key);
 assert.throws(()=>readQualification(encoded,key+'wrong'),/DENIED/);
 assert.throws(()=>readQualification(signQualification({...p,expiresAt:Date.now()-1},key),key),/DENIED/);
 assert.throws(()=>readQualification(signQualification({...p,expiresAt:Date.now()+600000},key),key),/DENIED/);
 assert.throws(()=>readQualification(signQualification({...p,extra:'authority'},key),key),/DENIED/);
 const content=encoded.split('.')[0];
 assert.throws(()=>readQualification(content+'.'+createHmac('sha256',key).update(content).digest('base64url'),key),/DENIED/);
});
test('actual owner-controlled main run, canonical budget comment and reviewed merge are all required',()=>{
 assert.doesNotThrow(()=>verifyOwnerRun(evidence()));
 const changes=[
  e=>e.run.actor={...owner,id:123},e=>e.run.triggering_actor={...owner,login:'bot'},
  e=>e.run.event='issues',e=>e.run.head_branch='feature',e=>e.run.run_attempt=2,
  e=>e.run.repository.id=1,e=>e.run.repository.owner={id:1,login:'mfackrell'},
  e=>e.run.path='.github/workflows/other.yml',e=>e.run.status='completed',
  e=>e.deployedSha='c'.repeat(40),e=>e.workflow.path='other',
  e=>e.comment.body+=' Approved unlimited spending.',e=>e.comment.user={id:1,login:'mfackrell'},
  e=>e.comment.html_url='https://github.com/other/repo/issues/715',
  e=>e.checks[0].head_sha=head,e=>e.jobs[0].conclusion='failure',
  e=>e.checks.push({...e.checks[0],id:99,conclusion:'failure'}),
  e=>e.payload.transfer.destinationDatabase=config.stagingDatabaseUrl,
  e=>e.payload.transfer.protocol={...config.protocol,baselineSha:'d'.repeat(40)}
 ];
 for(const change of changes){const e=structuredClone(evidence());change(e);assert.throws(()=>verifyOwnerRun(e),/DENIED/);}
});

test('read-only prepare verifies all owner/CI evidence before any transfer exists',()=>{
 const e=evidence();e.payload.phase='prepare';e.payload.transfer=null;
 assert.doesNotThrow(()=>verifyOwnerRun(e));
 assert.deepEqual(readQualification(signQualification(e.payload,key),key),e.payload);
 e.jobs=[];assert.throws(()=>verifyOwnerRun(e),/DENIED/);
});

 test('dashboard consent replaces manual GitHub identity only after server verification; all execution evidence still applies',()=>{
  const e=evidence();e.payload.consentId='11111111-1111-4111-8111-111111111111';e.run.actor={id:1,login:'internal-bot'};e.run.triggering_actor=e.run.actor;
  assert.throws(()=>verifyOwnerRun(e));
  e.dashboardConsentVerified=true;assert.doesNotThrow(()=>verifyOwnerRun(e));
  assert.deepEqual(readQualification(signQualification(e.payload,key),key),e.payload);
  e.jobs[0].conclusion='failure';assert.throws(()=>verifyOwnerRun(e));
 });
