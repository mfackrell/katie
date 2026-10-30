// Counts only. This file cannot call the generative Responses endpoint.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const rows=JSON.parse(readFileSync(join(process.env.RUNNER_TEMP,'native-sdk-completion-count-requests.json'),'utf8'));
assert.equal(rows.length,10);
let spent=0,peak=0,dollars=5486348,dollarPeak=dollars;
for(const [index,{phase,body}] of rows.entries()){
 assert.equal(body.model,'gpt-5.3-codex');
 const opaque=(body.input??[]).filter(x=>x.type==='reasoning').length*4096;
 // Synthetic encrypted reasoning is not a real provider reference. Remove it
 // from plaintext counting and reserve its full generation cap separately.
 const plain={...body,input:body.input.filter(x=>x.type!=='reasoning')};
 const fields=['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','truncation'];
 const payload=Object.fromEntries(fields.filter(k=>plain[k]!==undefined).map(k=>[k,plain[k]]));
 const response=await fetch('https://api.openai.com/v1/responses/input_tokens',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200,'Count endpoint must accept the actual normalized SDK context');
 const count=await response.json();assert.equal(count.object,'response.input_tokens');assert.ok(Number.isSafeInteger(count.input_tokens));
 const input=count.input_tokens+opaque,actual=input+4096,hold=actual+1024;
 peak=Math.max(peak,spent+hold);spent+=actual;dollarPeak=Math.max(dollarPeak,dollars+hold*14);dollars+=Math.ceil(input*1.75+4096*14);
 console.log(JSON.stringify({phase,call:index+1,plaintextInputTokens:count.input_tokens,opaqueHeadroom:opaque,outputCap:4096,reservation:hold,cumulativeConservativeTokens:spent}));
}
assert.ok(peak<=234059,'Native lifecycle must leave60k for DO closure');
assert.ok(195941+spent+60000+60000<=550000,'Full token envelope');
assert.ok(Math.max(dollarPeak,dollars+(60000+60000)*14)<=10000000,'Full conservative dollar envelope');
console.log(JSON.stringify({result:'COMPLETE_FROZEN_SDK_COUNT_PASS',spent,peak,historicalProvisionMicrousd:5486348,closureTokens:60000,assessmentTokens:60000,totalConservativeExposureMicrousd:Math.max(dollarPeak,dollars+120000*14)}));
