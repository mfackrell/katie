// Nonbillable capacity planning, NOT game acceptance or a prediction of model usage.
// First requests: real SDK 0.164.0/provider count qualification 40983516129.
// Continuation input envelope: largest retained production input receipt (12,795).
// Output cap and opaque provenance are the unchanged production gateway bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {forwardAuthorizedModelRequest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
import {createNativeReasoningProvenance} from '../scripts/benchmark/native-request-admission.mjs';

const firstInputs={implementation:7139,review:7221,repair:7150,'final-review':7208};
const historicalInputEnvelope=12795,outputCap=4096,spentBefore=195941,assessment=60000;
// Implementation/repair: inspect, edit/test, then receive tool result and conclude.
// Reviews: inspect/test, then receive tool result and decide. This is a planning
// scenario, not a claim that an unconstrained model must use exactly ten calls.
const lifecycle=[['implementation',3],['review',2],['repair',3],['final-review',2]];

async function probe({tokenCapacity,callCapacity}){
 let spent=0,held=0,calls=0,attempts=0,peak=0,currentInput=0;
 const rows=[],db={rpc:async(name,args)=>{
  if(name==='benchmark_gateway_execution_live')return {data:true};
  assert.equal(name,'benchmark_full_native_reserve');attempts++;
  peak=Math.max(peak,spent+args.p_tokens);
  if(calls>=callCapacity||spent+held+args.p_tokens>tokenCapacity)return {data:null,error:{message:'capacity'}};
  held=args.p_tokens;calls++;return {data:'synthetic-operation-'+calls};
 }};
 const provenance=createNativeReasoningProvenance();
 const upstream=async()=>{
  const reasoning={type:'reasoning',id:'rs_'+calls,summary:[],encrypted_content:Buffer.from('synthetic-'+calls).toString('base64')};
  const usage={input_tokens:currentInput,output_tokens:outputCap,total_tokens:currentInput+outputCap};
  const response={id:'synthetic-response-'+calls,status:'completed',usage,output:[reasoning]};
  return {providerRequestId:response.id,actualTokens:usage.total_tokens,usage,body:JSON.stringify(response),contentType:'application/json',reasoning};
 };
 // Explicit synthetic counts model a documented envelope; no network/provider calls.
 upstream.countInputTokens=async body=>({inputTokens:currentInput,requestHash:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
 for(const [phase,phaseCalls] of lifecycle){
  const prior=[];
  for(let i=0;i<phaseCalls;i++){
   currentInput=i===0?firstInputs[phase]:historicalInputEnvelope;
   try{
    const response=await forwardAuthorizedModelRequest({db,grantToken:'synthetic-'+('x'.repeat(40)),trialId:'synthetic-trial',executionEpoch:1,model:'gpt-5.3-codex',requestBody:{model:'gpt-5.3-codex',input:[{role:'user',content:[{type:'input_text',text:'Synthetic capacity envelope'}]},...prior],max_output_tokens:outputCap},upperTokens:120000,upstream,providerNamespace:'synthetic',fullMission:true,requireInputCount:true,reasoningProvenance:provenance,recordReceipt:async r=>{spent+=r.actualTokens;held=0;}});
    prior.push(response.reasoning);rows.push({phase,call:i+1,input:currentInput,actual:response.actualTokens,spent,peak});
   }catch(e){assert.match(e.message,/GATEWAY_ADMISSION_DENIED/);return {completed:false,blockedPhase:phase,blockedCall:i+1,calls,attempts,spent,peak,rows};}
  }
 }
 return {completed:true,calls,attempts,spent,peak,rows};
}

test('current renewal, #861 amendment, and all remaining original-cap tokens fail the conservative ten-call envelope',async()=>{
 for(const [name,tokenCapacity,callCapacity] of [['current-renewal',40780,3],['861-amendment',90780,15],['entire-remaining-development-cap',94059,15]]){
  const result=await probe({tokenCapacity,callCapacity});assert.equal(result.completed,false);assert.ok(result.calls<=callCapacity);assert.ok(result.spent<=tokenCapacity);
  console.log(JSON.stringify({scenario:name,tokenCapacity,callCapacity,...result}));
 }
});
test('exact envelope capacity clears ten calls; one token or one call less fails',async()=>{
 const result=await probe({tokenCapacity:1000000,callCapacity:10});
 assert.equal(result.completed,true);assert.equal(result.calls,10);assert.equal(result.spent,146448);
 assert.equal(result.peak,151568);
 const exact=await probe({tokenCapacity:result.peak,callCapacity:10});assert.equal(exact.completed,true);
 assert.equal((await probe({tokenCapacity:result.peak-1,callCapacity:10})).completed,false);
 assert.equal((await probe({tokenCapacity:result.peak,callCapacity:9})).completed,false);
 const total=spentBefore+result.peak+assessment;
 assert.equal(total,407509);assert.equal(total-350000,57509);
 console.log(JSON.stringify({scenario:'conservative-ten-call-envelope',...result,assessment,spentBefore,totalTokenCeiling:total,shortfallAgainstOriginal:total-350000,cumulativeDevelopmentCallLimit:9+10,note:'Planning envelope with synthetic receipts, not a measured completion cost or guarantee of model behavior.'}));
});
