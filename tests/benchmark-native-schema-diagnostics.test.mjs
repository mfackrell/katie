import test from 'node:test';
import assert from 'node:assert/strict';
import {admitNativeRequest,nativeAdmissionDiagnostic,nativeSchemaShape} from '../scripts/benchmark/native-request-admission.mjs';
import {retrieveNativeResponseShapes} from '../scripts/benchmark/native-response-shape-forensics.mjs';
import {forwardAuthorizedModelRequest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
const model='gpt-5.3-codex';
const message=part=>({model,input:[{type:'message',role:'assistant',phase:'commentary',content:[part]}]});
const part={type:'output_text',text:'private text',annotations:[],logprobs:[]};
test('empty replay metadata and narrow plaintext namespace/name fields remain fully byte counted',()=>{
 for(const namespace of [undefined,null,'functions']){
  const input=[{type:'message',role:'assistant',content:[part]},
   {type:'function_call',call_id:'call',name:'exec_command',namespace,arguments:'{}'},
   {type:'function_call_output',call_id:'call',name:'exec_command',namespace,output:'private tool result'},
   {type:'custom_tool_call',call_id:'custom',name:'patch',namespace,input:'private patch'},
   {type:'custom_tool_call_output',call_id:'custom',name:'patch',output:'done'}];
  const body={model,input};const admitted=admitNativeRequest(body);
  assert.deepEqual(admitted.body,body);assert.equal(admitted.plaintextBytes,Buffer.byteLength(JSON.stringify(body)));assert.equal(admitted.opaqueTokens,0);
 }
 for(const logprobs of [null,{},'private',[{token:'private',logprob:-1}]])assert.throws(()=>admitNativeRequest(message({...part,logprobs})),/UNBOUNDED/);
 for(const namespace of [[],{},42,true])assert.throws(()=>admitNativeRequest({model,input:[{type:'function_call',call_id:'call',name:'exec',namespace,arguments:'{}'}]}),/UNBOUNDED/);
 for(const field of ['encrypted_content','encrypted_function_args','internal_chat_message_metadata_passthrough','unknown'])assert.throws(()=>admitNativeRequest({model,input:[{type:'function_call',call_id:'call',name:'exec',arguments:'{}',[field]:'opaque'}]}),/UNBOUNDED/);
});
test('each structural denial gives fixed reason and content-free known-field classifications',()=>{
 const secret='PRIVATE_SECRET_SENTINEL';
 const cases=[
  [null,'request-object'],[{model,[secret]:secret},'request-fields'],
  [{client_metadata:{[secret]:1}},'client-metadata'],[{prompt_cache_key:42},'prompt-cache-key'],
  [{instructions:{[secret]:secret}},'instructions-type'],[{input:{}},'input-type'],[{store:true},'stored-context'],[{truncation:'auto'},'automatic-truncation'],[{include:[secret]},'include-fields'],
  [{input:[null]},'input-item-object'],
  [{input:[{type:'reasoning',id:'id',encrypted_content:secret,[secret]:secret}]},'reasoning-fields'],
  [{input:[{type:'reasoning',id:'id',encrypted_content:secret,summary:[{type:secret}]}]},'reasoning-summary'],
  [{input:[{type:'reasoning',id:'id',encrypted_content:secret,content:[{type:secret}]}]},'reasoning-content'],
  [{input:[{type:'reasoning',id:'id',encrypted_content:secret}]},'reasoning-provenance'],
  [{input:[{type:'function_call',call_id:'id',name:'exec',arguments:'{}',namespace:{[secret]:secret}}]},'tool-call-fields'],
  [{input:[{type:'function_call_output',call_id:42,output:secret}]},'tool-output-fields'],
  [{input:[{role:'assistant',content:secret}]},'text-array'],[message(null),'text-part-object'],
  [message({...part,type:secret}),'text-part-type'],[message({...part,text:{[secret]:secret}}),'text-part-text'],
  [message({...part,[secret]:secret}),'text-part-fields'],[message({...part,annotations:[{[secret]:secret}]}),'text-part-annotations'],[message({...part,logprobs:[{[secret]:secret}]}),'text-part-logprobs'],
  [{input:[{role:secret,content:[part]}]},'message-role'],[{input:[{role:'assistant',content:[part],[secret]:secret}]},'message-fields'],
  [{input:[{role:'assistant',content:[part],type:secret}]},'message-type'],[{input:[{role:'assistant',content:[part],id:42}]},'message-id'],[{input:[{role:'assistant',content:[part],phase:secret}]},'message-phase']];
 for(const [body,reason]of cases){let error;try{admitNativeRequest(body);}catch(e){error=e;}assert.ok(error,reason);assert.equal(error.message,'GATEWAY_UNBOUNDED_INPUT_DENIED');const d=nativeAdmissionDiagnostic(error);assert.equal(d.reason,reason);assert.ok(!JSON.stringify(d).includes(secret));}
 assert.equal(nativeAdmissionDiagnostic(Object.assign(Error('GATEWAY_UNBOUNDED_INPUT_DENIED'),{admissionDiagnostic:{secret}})),undefined);
 const shape=nativeSchemaShape({output:[{type:'message',content:[{...part,text:secret}]}],[secret]:secret});
 assert.equal(shape.unknownFieldCount,1);assert.ok(!JSON.stringify(shape).includes(secret));assert.equal(shape.fields.output.items[0].fields.content.items[0].fields.logprobs.count,0);
});
test('new plaintext fields cannot bypass quantitative bounds and nontext failures are diagnosed before reserve',async()=>{
 let reserves=0,upstream=0;const base={db:{rpc:async name=>{if(name==='benchmark_gateway_execution_live')return {data:true};reserves++;return {data:'op'};}},grantToken:'synthetic-long-grant-token-value',trialId:'trial',executionEpoch:1,model,upperTokens:120000,providerNamespace:'openai',recordReceipt:async()=>{},upstream:async()=>{upstream++;}};
 await assert.rejects(forwardAuthorizedModelRequest({...base,requestBody:{model,input:[{type:'function_call',name:'exec',call_id:'call',namespace:'x'.repeat(120000),arguments:'{}'}]}}),/EXCEEDS_GRANT/);
 try{await forwardAuthorizedModelRequest({...base,requestBody:{model,input:[{type:'input_image',image_url:'private-image'}]}});assert.fail();}catch(e){assert.equal(nativeAdmissionDiagnostic(e).reason,'nontext-input');assert.ok(!JSON.stringify(nativeAdmissionDiagnostic(e)).includes('private-image'));}
 assert.equal(reserves,0);assert.equal(upstream,0);
});
test('incident forensics makes only fixed existing-response GETs and emits no content or credentials',async()=>{
 const seen=[],secret='PRIVATE_PROVIDER_KEY_123456789';
 const results=await retrieveNativeResponseShapes({apiKey:secret,fetchImpl:async(url,options)=>{seen.push({url,options});return {ok:true,status:200,text:async()=>JSON.stringify({id:'private-id',status:'completed',output:[{type:'message',content:[{...part,text:secret}]}],['private-field-'+secret]:secret})};}});
 assert.equal(seen.length,2);for(const {url,options}of seen){assert.match(url,/^https:\/\/api.openai.com\/v1\/responses\/resp_[a-f0-9]+$/);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+secret);assert.ok(!('body'in options));}
 assert.ok(!JSON.stringify(results).includes(secret));assert.ok(!JSON.stringify(results).includes('private-id'));assert.equal(results[0].responseState,'completed');
 const absent=await retrieveNativeResponseShapes({apiKey:secret,fetchImpl:async()=>({ok:false,status:404})});assert.ok(absent.every(x=>x.outcome==='not-retained'));
});
