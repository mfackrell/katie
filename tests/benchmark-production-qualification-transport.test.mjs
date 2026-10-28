import test from 'node:test';
import assert from 'node:assert/strict';
import {productionQualificationFetch} from '../scripts/benchmark/production-qualification-transport.mjs';

test('production transport fails before any request without an access credential',()=>{
 for(const value of [undefined,'','bad\r\nheader'])
  assert.throws(()=>productionQualificationFetch({},value,()=>assert.fail('network called')),/PRODUCTION_VERCEL_ACCESS_REQUIRED/);
});
test('access credential is confined to the fixed endpoint and redirects cannot forward it',async()=>{
 const response={ok:true};
 for(const method of ['GET','POST']) {
  const actual=await productionQualificationFetch({method,headers:{'content-type':'text/plain'},redirect:'follow',body:method==='POST'?'signed-envelope':undefined},'synthetic-access',async(url,options)=>{
   assert.equal(url,'https://katie-mu.vercel.app/api/benchmark/715/owner-qualification');
   assert.equal(options.redirect,'error');
   assert.equal(options.headers.get('x-vercel-protection-bypass'),'synthetic-access');
   assert.equal(options.headers.get('content-type'),'text/plain');
   assert.equal(options.body,method==='POST'?'signed-envelope':undefined);
   return response;
  });
  assert.equal(actual,response);
 }
});
