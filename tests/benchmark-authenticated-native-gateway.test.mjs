import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardAuthorizedModelRequest,tokenDigest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
const token='synthetic-only-token-'+('x'.repeat(50));
const request={grantToken:token,trialId:'trial-1',executionEpoch:1,model:'mock',
 requestBody:{model:'mock'},upperTokens:10000,providerNamespace:'fixture'};
test('denied grant never reaches model provider',async()=>{
 let forwarded=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,
 db:{rpc:async(name)=>name==='benchmark_gateway_execution_live'?{data:true,error:null}:{data:null,error:{message:'denied'}}},
 upstream:async()=>{forwarded++;},recordReceipt:async()=>{}}),/ADMISSION_DENIED/);
 assert.equal(forwarded,0);
});
test('every provider retry reserves a distinct operation and records receipt',async()=>{
 const calls=[],receipts=[];
 const db={rpc:async(name,args)=>{if(name==='benchmark_gateway_execution_live')return{data:true,error:null};calls.push([name,args]);return{data:'operation-'+calls.length,error:null}}};
 for(let i=0;i<2;i++)await forwardAuthorizedModelRequest({...request,db,
 upstream:async()=>({providerRequestId:'provider-'+i,actualTokens:24}),
 recordReceipt:async receipt=>receipts.push(receipt)});
 assert.equal(calls.length,2);
 assert.equal(new Set(calls.map(x=>x[1].p_request_key)).size,2);
 assert.deepEqual(receipts.map(x=>x.actualTokens),[24,24]);
 assert.ok(calls.every(x=>x[1].p_digest===tokenDigest(token)));
});
test('uncertain provider outcome retains reservation and never records zero usage',async()=>{
 let released=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,
 db:{rpc:async(name)=>name==='benchmark_gateway_execution_live'?{data:true,error:null}:{data:'held-operation',error:null}},
 upstream:async()=>{throw Error('dropped after forwarding')},
 recordReceipt:async()=>{released++;}}),e=>e.message==='GATEWAY_UPSTREAM_UNCERTAIN'&&e.operationId==='held-operation');
 assert.equal(released,0);
});
test('invalid or short token cannot reach provider',async()=>{
 let started=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,grantToken:'fake',
 db:{rpc:async()=>{started++;return{data:'x',error:null}}},
 upstream:async()=>{started++;},recordReceipt:async()=>{}}),/TOKEN_INVALID/);
 assert.equal(started,0);
});

test('stopped or expired execution cannot forward an upstream attempt',async()=>{
 let calls=0;
 await assert.rejects(forwardAuthorizedModelRequest({...request,
 db:{rpc:async()=>({data:false,error:null})},
 upstream:async()=>{calls++},recordReceipt:async()=>{}
 }),/EXECUTION_STOPPED/);
 assert.equal(calls,0);
});

test('contained four-phase provider cycle meters implementation, review, repair and final review',async()=>{
 const phases=['implementation','review','repair','final-review'];
 const admitted=[],settled=[],seen=new Set();
 const db={rpc:async(name,args)=>{
  if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
  assert.equal(name,'benchmark_full_native_reserve');
  assert.ok(!seen.has(args.p_request_key),'each phase requires a distinct provider admission');
  seen.add(args.p_request_key);admitted.push(args);
  return {data:'op-'+admitted.length,error:null};
 }};
 for(const phase of phases){
  const n=settled.length;
  const result=await forwardAuthorizedModelRequest({...request,fullMission:true,db,
   requestBody:{model:'mock',input:'phase:'+phase},
   upstream:async body=>({providerRequestId:'fixture-'+body.input.slice(6),actualTokens:11,body:'{}'}),
   recordReceipt:async receipt=>settled.push({...receipt,phase})
  });
  assert.equal(result.providerRequestId,'fixture-'+phase);
  assert.equal(settled.length,n+1);
 }
 assert.equal(admitted.length,4);
 assert.equal(settled.length,4);
 assert.equal(new Set(settled.map(x=>x.operationId)).size,4);
 assert.equal(settled.reduce((sum,x)=>sum+x.actualTokens,0),44);
});
test('interrupted phase does not silently replay an unresolved provider call',async()=>{
 let admissions=0,receipts=0;
 const db={rpc:async(name)=>{
  if(name==='benchmark_gateway_execution_live')return {data:true,error:null};
  admissions++;return {data:'unresolved-op',error:null};
 }};
 await assert.rejects(forwardAuthorizedModelRequest({...request,db,fullMission:true,
  upstream:async()=>{throw Error('connection interrupted after submission')},
  recordReceipt:async()=>{receipts++}
 }),/GATEWAY_UPSTREAM_UNCERTAIN/);
 assert.equal(admissions,1);
 assert.equal(receipts,0);
 // Recovery must reconcile the existing admission. It may not assume an
 // interrupted request was free or replay it with a fresh operation identity.
});


test('reserves the actual bounded envelope and caps provider output',async()=>{
 let reserved,forwarded;
 await forwardAuthorizedModelRequest({...request,
  requestBody:{model:'mock',input:'small fixture',max_output_tokens:50},
  db:{rpc:async(name,args)=>name==='benchmark_gateway_execution_live'?{data:true,error:null}:(reserved=args.p_tokens,{data:'op',error:null})},
  upstream:async body=>(forwarded=body,{providerRequestId:'receipt',actualTokens:15}),
  recordReceipt:async()=>{}
 });
 assert.equal(forwarded.max_output_tokens,50);
 assert.ok(reserved>=Buffer.byteLength(JSON.stringify(forwarded),'utf8')+50);
});
test('oversized or unbounded provider inputs cannot create billable admission',async()=>{
 for(const body of [{model:'mock',input:'x'.repeat(12000)},
  {model:'mock',input:[{type:'input_image',image_url:'https://example.com/img'}]}]){
  let admission=0;
  await assert.rejects(forwardAuthorizedModelRequest({...request,requestBody:body,
   db:{rpc:async name=>{if(name==='benchmark_gateway_execution_live')return {data:true,error:null};admission++;return{data:'op',error:null}}},
   upstream:async()=>{throw Error('must not reach provider')},recordReceipt:async()=>{}
  }),/GATEWAY_(REQUEST_EXCEEDS_GRANT|UNBOUNDED_INPUT_DENIED)/);
  assert.equal(admission,0);
 }
});

test('provider-expanded references and files are denied before reservation',async()=>{
 const inputs=[{model:'mock',input:'hello',previous_response_id:'resp_1'},
 {model:'mock',input:[{role:'user',content:[{type:'input_file',file_url:'https://example.com/a.pdf'}]}]},
 {model:'mock',input:'hello',conversation:'conv_1'}];
 for(const requestBody of inputs){let reserved=0;
  await assert.rejects(forwardAuthorizedModelRequest({...request,requestBody,
   db:{rpc:async name=>name==='benchmark_gateway_execution_live'?{data:true,error:null}:(reserved++,{data:'op',error:null})},
   upstream:async()=>{throw Error('must not forward')},recordReceipt:async()=>{}}),/GATEWAY_UNBOUNDED_INPUT_DENIED/);
  assert.equal(reserved,0);
 }
});

test('bounded inline Codex custom tool call and output are admitted',async()=>{
 let admitted=0,forwarded=0;
 await forwardAuthorizedModelRequest({...request,
  requestBody:{model:'mock',input:[{type:'custom_tool_call',call_id:'call_1',name:'exec',input:'echo ok'},{type:'custom_tool_call_output',call_id:'call_1',output:'ok'}],max_output_tokens:100},
  db:{rpc:async name=>name==='benchmark_gateway_execution_live'?{data:true,error:null}:(admitted++,{data:'op',error:null})},
  upstream:async()=>{forwarded++;return{providerRequestId:'provider-tool',actualTokens:200}},recordReceipt:async()=>{}});
 assert.equal(admitted,1);assert.equal(forwarded,1);
});
