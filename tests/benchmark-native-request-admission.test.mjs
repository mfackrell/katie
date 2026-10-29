import test from 'node:test';
import assert from 'node:assert/strict';
import {admitNativeRequest,createNativeReasoningProvenance} from '../scripts/benchmark/native-request-admission.mjs';
import {forwardAuthorizedModelRequest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
const model='gpt-5.3-codex';
const item={id:'rs_fixture',type:'reasoning',summary:[],encrypted_content:'synthetic-opaque-reasoning'};
const response=(output=[item],usage={input_tokens:3,output_tokens:2,total_tokens:5})=>({
 providerRequestId:'resp_fixture',actualTokens:usage.total_tokens,usage,contentType:'text/event-stream',
 body:'event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'resp_fixture',status:'completed',model,output,usage}})+'\n\n'
});
const bootstrap={model,client_metadata:{session_id:'synthetic'},prompt_cache_key:'synthetic-cache',store:false,
 include:['reasoning.encrypted_content'],input:[{type:'message',id:null,role:'user',content:[{type:'input_text',text:'Build only the approved game.'}]}]};
test('captured SDK bootstrap normalizes only transport fields while preserving inline input and reasoning request',()=>{
 const admitted=admitNativeRequest(bootstrap);
 assert.deepEqual(admitted.body.input,[{type:'message',role:'user',content:bootstrap.input[0].content}]);
 assert.deepEqual(admitted.body.include,bootstrap.include);assert.equal(admitted.body.client_metadata,undefined);assert.equal(admitted.body.prompt_cache_key,undefined);
 assert.equal(bootstrap.input[0].id,null);assert.equal(admitted.opaqueTokens,0);
 for(const input of [[{type:'item_reference',id:'provider-ref'}],[{type:'message',id:'provider-ref',role:'user'}],[{type:'compaction',encrypted_content:'opaque'}]])
  assert.throws(()=>admitNativeRequest({...bootstrap,input}),/UNBOUNDED/);
});
test('opaque reasoning requires exact terminal-response provenance, same model and bridge, and counts every duplicate',()=>{
 const proof=createNativeReasoningProvenance(),body={model,input:[item],max_output_tokens:4096};
 assert.throws(()=>admitNativeRequest(body,proof),/UNBOUNDED/);
 proof.remember(response(),model,4096);
 const one=admitNativeRequest(body,proof),two=admitNativeRequest({...body,input:[item,item]},proof);
 assert.equal(one.opaqueTokens,4096);assert.equal(two.opaqueTokens,8192);assert.deepEqual(one.body.input,[item]);
 assert.equal(one.plaintextBytes,Buffer.byteLength(JSON.stringify({...body,input:[{...item,encrypted_content:''}]})));
 for(const changed of [{...item,encrypted_content:'tampered'},{...item,id:'other'},{...item,summary:[{type:'summary_text',text:'changed'}]}])
  assert.throws(()=>admitNativeRequest({...body,input:[changed]},proof),/UNBOUNDED/);
 assert.throws(()=>admitNativeRequest({...body,model:'other'},proof),/UNBOUNDED/);
 assert.throws(()=>admitNativeRequest(body,createNativeReasoningProvenance()),/UNBOUNDED/);
});
test('unmatched, incomplete and output-overrun receipts cannot establish opaque provenance',()=>{
 const wrongId={...response(),providerRequestId:'wrong'},wrongUsage={...response(),actualTokens:6};
 for(const result of [wrongId,wrongUsage,response([item],{input_tokens:3,output_tokens:4097,total_tokens:4100})]){
  const proof=createNativeReasoningProvenance();
  proof.remember(result,model,4096);
  assert.throws(()=>admitNativeRequest({model,input:[item]},proof),/UNBOUNDED/);
 }
 const proof=createNativeReasoningProvenance(),partial=response();partial.body=partial.body.replaceAll('response.completed','response.incomplete').replace('"status":"completed"','"status":"incomplete"');
 proof.remember(partial,model,4096);assert.throws(()=>admitNativeRequest({model,input:[item]},proof),/UNBOUNDED/);
});
test('actual paid admission reserves normalized bytes and opaque bounds, settles receipts, and fails closed on stage exhaustion',async()=>{
 const proof=createNativeReasoningProvenance(),reserved=[],settled=[];let forwarded=0,deny=false;
 const options={db:{rpc:async(name,args)=>{if(name==='benchmark_gateway_execution_live')return {data:true};reserved.push(args);return deny?{error:{message:'mission capacity exhausted'}}:{data:'operation'};}},
  grantToken:'synthetic-grant-token-long-enough-123',trialId:'trial',executionEpoch:3,model,upperTokens:120000,providerNamespace:'openai-responses',fullMission:true,reasoningProvenance:proof,
  upstream:async body=>{forwarded++;assert.equal(body.max_output_tokens,4096);return response();},recordReceipt:async r=>settled.push(r)};
 await forwardAuthorizedModelRequest({...options,requestBody:bootstrap});
 const replay={...bootstrap,input:[...bootstrap.input,item,{type:'custom_tool_call',call_id:'call',name:'exec',input:'printf safe'},{type:'custom_tool_call_output',call_id:'call',output:[{type:'input_text',text:'safe'}]}]};
 await forwardAuthorizedModelRequest({...options,requestBody:replay});
 const counted=admitNativeRequest({...replay,max_output_tokens:4096},proof);
 assert.equal(reserved[1].p_tokens,counted.plaintextBytes+4096+4096+1024);assert.equal(settled.length,2);assert.equal(forwarded,2);
 deny=true;await assert.rejects(forwardAuthorizedModelRequest({...options,requestBody:replay}),/ADMISSION_DENIED/);assert.equal(forwarded,2);
 const count=reserved.length;
 await assert.rejects(forwardAuthorizedModelRequest({...options,requestBody:{model,input:'x'.repeat(120000)}}),/EXCEEDS_GRANT/);
 await assert.rejects(forwardAuthorizedModelRequest({...options,requestBody:{model,input:[{...item,encrypted_content:'foreign'}]}}),/UNBOUNDED/);
 assert.equal(reserved.length,count);assert.equal(forwarded,2);
});
