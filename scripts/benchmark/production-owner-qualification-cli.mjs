// Only manually dispatched by the authenticated repository owner. No provider
// credentials, inference, scope approval, task grant, or development dispatch.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import config from '../../config/benchmark-715-production-qualification.json' with {type:'json'};
import {frozenProtocol} from './owner-staging-bootstrap.mjs';
import {signQualification} from './production-owner-qualification.mjs';
import {productionQualificationFetch} from './production-qualification-transport.mjs';
const env=process.env;
const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
const deny=()=>{throw Error('OWNER_PRODUCTION_QUALIFICATION_REFUSED')};
if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REPOSITORY!==config.repository||
 env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_ACTOR!==config.ownerLogin||
 env.GITHUB_TRIGGERING_ACTOR!==config.ownerLogin||env.GITHUB_ACTOR_ID!==String(config.ownerGithubId)||
 event.repository?.id!==config.repositoryId||event.inputs?.authorize!=='true'||
 env.OPENAI_API_KEY||env.CODEX_ACCESS_TOKEN||!env.RUNNER_TEMP||
 env.KATIE_NONFULL_STAGING_CONFIRMED!=='verified'||
 env.KATIE_NONFULL_STAGING_SUPABASE_URL!==config.stagingDatabaseUrl||
 !env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY||!env.KATIE_NONFULL_STAGING_OWNER_ID||
 !env.KATIE_NATIVE_HANDOFF_HMAC_KEY||env.KATIE_NATIVE_HANDOFF_HMAC_KEY.length<32||
 JSON.stringify(frozenProtocol())!==JSON.stringify(config.protocol))deny();
const productionFetch=(options)=>productionQualificationFetch(options,env.VERCEL_AUTOMATION_BYPASS_SECRET);
const ready=await productionFetch({signal:AbortSignal.timeout(15000),redirect:'error'});
if(!ready.ok||(await ready.json()).commitSha!==env.GITHUB_SHA)deny();
// Validate authoritative owner budget statement before fencing its old location.
const auth=await fetch(`https://api.github.com/repos/${config.repository}/issues/comments/${config.authorizationCommentId}`,{
 headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:'application/vnd.github+json'},
 signal:AbortSignal.timeout(10000),redirect:'error'});
if(!auth.ok)deny();
const comment=await auth.json();
if(comment.user?.id!==config.ownerGithubId||comment.user?.login!==config.ownerLogin||
 comment.id!==config.authorizationCommentId||typeof comment.body!=='string'||
 createHash('sha256').update(comment.body.trimEnd()).digest('hex')!==config.authorizationBodySha256)deny();
// All production checks, including current CI/gateway and pricing, must pass
// before the irreversible cross-database budget transfer starts its clock.
const prepare=signQualification({version:1,phase:'prepare',authorization:'production-715-30usd-350000tokens-4hours',
 runId:env.GITHUB_RUN_ID,runAttempt:Number(env.GITHUB_RUN_ATTEMPT),sha:env.GITHUB_SHA,
 expiresAt:Date.now()+120000,transfer:null},env.KATIE_NATIVE_HANDOFF_HMAC_KEY);
const preflight=await productionFetch({method:'POST',headers:{'content-type':'text/plain'},body:prepare,
 signal:AbortSignal.timeout(60000),redirect:'error'});
if(!preflight.ok)throw Error(`PRODUCTION_PREFLIGHT_HTTP_${preflight.status}: staging allowance untouched`);
const stage=createClient(config.stagingDatabaseUrl,env.KATIE_NONFULL_STAGING_SERVICE_ROLE_KEY,
 {auth:{persistSession:false,autoRefreshToken:false}});
// Atomic, idempotent handoff: verify only synthetic receipts exist, then freeze
// those accounts and fence later staging paid replicates. Retry returns this
// same experiment and original deadline; no budget is reset or replenished.
const {data:transfer,error}=await stage.rpc('benchmark_claim_production_transfer',{
 p_owner:env.KATIE_NONFULL_STAGING_OWNER_ID,p_run:env.GITHUB_RUN_ID,p_sha:env.GITHUB_SHA,
 p_authorization_sha:config.authorizationBodySha256,p_protocol:config.protocol});
if(error||!transfer)deny();
writeFileSync(join(env.RUNNER_TEMP,'benchmark-715-production-transfer.json'),JSON.stringify(transfer,null,2)+'\n',{mode:0o600});
const envelope=signQualification({version:1,phase:'commit',authorization:'production-715-30usd-350000tokens-4hours',
 runId:env.GITHUB_RUN_ID,runAttempt:Number(env.GITHUB_RUN_ATTEMPT),sha:env.GITHUB_SHA,
 expiresAt:Date.now()+120000,transfer},env.KATIE_NATIVE_HANDOFF_HMAC_KEY);
const response=await productionFetch({method:'POST',headers:{'content-type':'text/plain'},body:envelope,
 signal:AbortSignal.timeout(60000),redirect:'error'});
if(!response.ok)throw Error(`PRODUCTION_QUALIFICATION_HTTP_${response.status}: transfer checkpoint retained; retry the same workflow without resetting records`);
const receipt=await response.json();
writeFileSync(join(env.RUNNER_TEMP,'benchmark-715-production-qualification.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log('Production #715 owner qualification recorded. No model calls, project approvals or execution grants issued.');
