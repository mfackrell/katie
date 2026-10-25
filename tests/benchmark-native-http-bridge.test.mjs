import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHttpBridge} from '../scripts/benchmark/native-http-bridge.mjs';
test('real local HTTP POST traverses durable reservation and trusted receipt',async()=>{
 const calls=[],receipts=[];let provider=0;
 const db={rpc:async(name,args)=>{
  calls.push(name);
  return name==='benchmark_gateway_execution_live'
   ?{data:true,error:null}:{data:'operation-1',error:null};
 }};
 const server=createNativeHttpBridge({db,
  grantToken:'synthetic-'+('z'.repeat(48)),trialId:'trial',executionEpoch:1,
  providerNamespace:'fixture',upperTokens:100,clientToken:'synthetic-fixture-token',
  upstream:async body=>{provider++;assert.equal(body.model,'fixture');
   return {providerRequestId:'provider-1',actualTokens:10,
    body:JSON.stringify({id:'response-1',status:'completed'})};},
  recordReceipt:async receipt=>receipts.push(receipt)
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{
   method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-fixture-token'},
   body:JSON.stringify({model:'fixture',input:'test'})});
  assert.equal(response.status,200);
  assert.equal(provider,1);
  assert.deepEqual(calls,['benchmark_gateway_execution_live','benchmark_grant_reserve']);
  assert.equal(receipts.length,1);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('revoked execution never forwards real HTTP requests',async()=>{
 let sent=0;
 const server=createNativeHttpBridge({db:{rpc:async()=>({data:false,error:null})},
  grantToken:'synthetic-'+('z'.repeat(48)),trialId:'trial',executionEpoch:1,
  providerNamespace:'fixture',upperTokens:100,
  upstream:async()=>{sent++;},recordReceipt:async()=>{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{
   method:'POST',headers:{authorization:'Bearer synthetic-fixture-token'},body:JSON.stringify({model:'fixture'})});
  assert.equal(response.status,403);
  assert.equal(sent,0);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
