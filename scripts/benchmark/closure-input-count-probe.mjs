// Nonbillable provider counting only. There is no generation endpoint in this script.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const fixture=JSON.parse(gunzipSync(Buffer.from(readFileSync('tests/fixtures/take-eleven-completion-count.json.gz.b64','utf8').trim(),'base64')));
assert.equal(fixture.synthetic,true);assert.equal(fixture.requests.length,16);
const counted=[],cache=new Map();
for(const row of fixture.requests){
 assert.equal(row.countBody.model,'gpt-5.3-codex');
 assert.ok(!row.countBody.tools?.length,'Closure never authorizes hosted tools');
 const key=JSON.stringify(row.countBody);
 let input=cache.get(key);
 if(input===undefined){
  const r=await fetch('https://api.openai.com/v1/responses/input_tokens',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY,'content-type':'application/json'},body:key,signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200,'Complete frozen closure count body must be admitted');
  const result=await r.json();assert.equal(result.object,'response.input_tokens');assert.ok(Number.isSafeInteger(result.input_tokens)&&result.input_tokens>=0);
  input=result.input_tokens;cache.set(key,input);
 }
 counted.push({...row,inputTokens:input,reservation:input+256+row.outputTokens});
 console.log(JSON.stringify({phase:row.phase,role:row.role,candidateCharacters:row.candidateCharacters,inputTokens:input,outputTokens:row.outputTokens,reservation:input+256+row.outputTokens}));
}
for(const phase of ['development','assessment'])for(const candidate of [12000,24000,48000]){
 const rows=counted.filter(r=>r.phase===phase&&(r.candidateCharacters===candidate||r.role.endsWith('_router')));
 assert.equal(rows.length,4);
 const reservation=rows.reduce((n,r)=>n+r.reservation,0);
 assert.ok(reservation<=60000,phase+' four-call completion envelope exceeds protected60k');
 const exposure=rows.reduce((n,r)=>n+Math.ceil((r.inputTokens+256)*1.75+r.outputTokens*14),0);
 console.log(JSON.stringify({result:'DO_COMPLETION_COUNT_PASS',phase,candidateCharacters:candidate,calls:4,reservationTokens:reservation,protectedTokens:60000,conservativeExposureMicrousd:exposure}));
}
