import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createResponsesProvider} from '../scripts/benchmark/native-provider-receipts.mjs';
import {forwardAuthorizedModelRequest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
const hash=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
function fixture(){
 const events=[];
 const upstream=async body=>{events.push('inference');return {providerRequestId:'fixture-response',actualTokens:7204,body:'{}'};};
 upstream.countInputTokens=async body=>{events.push('count');return {inputTokens:7139,requestHash:hash(body)};};
 const args={db:{rpc:async(name,p)=>{events.push(name);if(name==='benchmark_gateway_execution_live')return{data:true};assert.ok(p.p_tokens<=40780);return{data:'operation'};}},grantToken:'x'.repeat(48),trialId:'trial',executionEpoch:1,model:'gpt-5.3-codex',requestBody:{model:'gpt-5.3-codex',input:'fixed synthetic text '.repeat(1900)},upperTokens:120000,upstream,providerNamespace:'openai-responses',recordReceipt:async()=>events.push('receipt')};
 return {args,events};
}
test('authoritative count admits 7k input within 40780 remaining without byte-ratio guesses',async()=>{
 const {args,events}=fixture();let reserved;
 const rpc=args.db.rpc;args.db.rpc=async(n,p)=>{if(n==='benchmark_grant_reserve')reserved=p.p_tokens;return rpc(n,p);};
 await forwardAuthorizedModelRequest(args);
 assert.equal(reserved,7139+4096+1024);
 assert.deepEqual(events,['benchmark_gateway_execution_live','count','benchmark_grant_reserve','inference','receipt']);
});
test('count and inference bind detached deeply frozen identical context',async()=>{
 const {args}=fixture();const original=args.requestBody;let counted;
 args.upstream.countInputTokens=async body=>{counted=body;assert.ok(Object.isFrozen(body));original.input='changed';return {inputTokens:7139,requestHash:hash(body)};};
 const call=args.upstream;const wrapped=async body=>{assert.equal(body,counted);assert.notEqual(body.input,original.input);return call(body);};
 wrapped.countInputTokens=args.upstream.countInputTokens;args.upstream=wrapped;
 await forwardAuthorizedModelRequest(args);
});
test('bad counts and request hashes fail before reservation or inference',async()=>{
 const missing=fixture();missing.args.requireInputCount=true;delete missing.args.upstream.countInputTokens;
 await assert.rejects(forwardAuthorizedModelRequest(missing.args),/COUNT_UNAVAILABLE/);assert.deepEqual(missing.events,['benchmark_gateway_execution_live']);
 for(const result of [null,{inputTokens:-1},{inputTokens:1.5},{inputTokens:120001},{inputTokens:NaN},{inputTokens:7139,requestHash:'wrong'}]){
  const {args,events}=fixture();args.upstream.countInputTokens=async body=>result&&({...result,requestHash:result.requestHash??hash(body)});
  await assert.rejects(forwardAuthorizedModelRequest(args),/GATEWAY_INPUT_COUNT_INVALID/);
  assert.deepEqual(events,['benchmark_gateway_execution_live']);
 }
 const {args,events}=fixture();args.upstream.countInputTokens=async()=>{throw Error('GATEWAY_INPUT_COUNT_UNAVAILABLE');};
 await assert.rejects(forwardAuthorizedModelRequest(args),/COUNT_UNAVAILABLE/);assert.deepEqual(events,['benchmark_gateway_execution_live']);
});
test('authentication, schema, byte size and atomic budget gates precede inference',async()=>{
 for(const type of ['stopped','schema','bytes']){
  const {args,events}=fixture();if(type==='stopped')args.db.rpc=async()=>({data:false});
  if(type==='schema')args.requestBody.previous_response_id='opaque';
  if(type==='bytes')args.requestBody.input='x'.repeat(2_000_001);
  await assert.rejects(forwardAuthorizedModelRequest(args));assert.ok(!events.includes('count'));assert.ok(!events.includes('inference'));
 }
 const {args,events}=fixture();args.db.rpc=async n=>n==='benchmark_gateway_execution_live'?{data:true}:{error:{message:'mission capacity exhausted'}};
 await assert.rejects(forwardAuthorizedModelRequest(args),/GATEWAY_ADMISSION_DENIED/);assert.deepEqual(events,['count']);
});
test('provider count uses fixed endpoint and exact context projection only',async()=>{
 let seen;
 const provider=createResponsesProvider({apiKey:'secret'.repeat(10),fetchImpl:async(url,options)=>{seen={url:String(url),options};return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:7139}));}});
 const body={model:'gpt-5.3-codex',input:'text',instructions:'rules',tools:[],tool_choice:'auto',parallel_tool_calls:true,reasoning:{effort:'low'},text:{format:{type:'text'}},truncation:'disabled',stream:true,max_output_tokens:4096,store:false,include:[],metadata:{}};
 const result=await provider.countInputTokens(body);
 assert.equal(result.inputTokens,7139);assert.equal(result.requestHash,hash(body));
 assert.equal(seen.url,'https://api.openai.com/v1/responses/input_tokens');assert.equal(seen.options.method,'POST');assert.equal(seen.options.redirect,'error');assert.ok(seen.options.signal instanceof AbortSignal);
 const {stream,max_output_tokens,store,include,metadata,...context}=body;assert.deepEqual(JSON.parse(seen.options.body),context);
});
test('count adapter rejects unavailable/malformed results and noncanonical origins',async()=>{
 for(const response of [()=>new Response('{}'),()=>new Response('{'),()=>new Response('x'.repeat(4097)),()=>new Response(JSON.stringify({object:'response.input_tokens',input_tokens:-1})),()=>new Response('',{status:429}),()=>{throw Error('timeout secret');}]){
  const provider=createResponsesProvider({apiKey:'secret'.repeat(10),fetchImpl:async()=>response()});await assert.rejects(provider.countInputTokens({model:'gpt-5.3-codex',input:'x'}),/^Error: GATEWAY_INPUT_COUNT_(INVALID|UNAVAILABLE)$/);
 }
 for(const baseUrl of ['http://api.openai.com','https://api.openai.com:444','https://user:password@api.openai.com','https://other.invalid'])assert.throws(()=>createResponsesProvider({apiKey:'secret'.repeat(10),baseUrl}),/UNAPPROVED/);
});
