import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifySdkInputCounts} from '../scripts/benchmark/native-sdk-input-count-probe.mjs';
const fixture=()=>['implementation','review','repair','final-review'].map(phase=>({phase,body:{model:'gpt-5.3-codex',input:'fixed fixture '+phase,tools:[{type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}}}}]}}));
test('counts exactly four validated actual SDK phase fixtures with no response generation',async()=>{
 let calls=0;const result=await qualifySdkInputCounts(JSON.stringify(fixture()),async body=>{calls++;assert.equal(body.model,'gpt-5.3-codex');assert.equal(body.tools[0].name,'exec_command');return {inputTokens:42};});
 assert.equal(calls,4);assert.deepEqual(result.map(x=>x.phase),fixture().map(x=>x.phase));assert.ok(result.every(x=>x.inputTokens===42));
});
test('invalid identity, opaque replay and unknown context fail before any count request',async()=>{
 const bad=[[],fixture().slice(0,3),fixture().reverse()];
 for(const change of [{model:'other'},{previous_response_id:'hidden'},{conversation:'hidden'},{input:[{type:'reasoning',id:'rs',encrypted_content:'opaque'}]},{tools:[{type:'web_search'}]},{input:'x'.repeat(2_000_001)}]){const entries=fixture();entries[3].body={...entries[3].body,...change};bad.push(entries);}
 for(const entries of bad){let calls=0;await assert.rejects(qualifySdkInputCounts(JSON.stringify(entries),async()=>{calls++;return {inputTokens:1};}));assert.equal(calls,0);}
});
test('count failure stops bounded operational qualification without retries',async()=>{
 let calls=0;await assert.rejects(qualifySdkInputCounts(JSON.stringify(fixture()),async()=>{calls++;if(calls===2)throw Error('count unavailable');return {inputTokens:1};}),/count unavailable/);assert.equal(calls,2);
});
