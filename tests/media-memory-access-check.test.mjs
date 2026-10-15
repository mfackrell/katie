import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAnonymousChatAccess} from '../scripts/media-memory-access-check.mjs';
test('access probe sends only an invalid empty request and fails closed for reachable or unavailable application routes',async()=>{
 for(const status of [200,400,404,500]){
  const result=await checkAnonymousChatAccess('https://owner-app.invalid',async(url,options)=>{
   assert.equal(String(url),'https://owner-app.invalid/api/chat');assert.equal(options.body,'{}');
   assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');
   assert.deepEqual(options.headers,{'content-type':'application/json'});
   return new Response(null,{status});
  });assert.equal(result.anonymousDenied,false);
 }
 assert.equal((await checkAnonymousChatAccess('https://owner-app.invalid',async()=>{throw Error('offline');})).anonymousDenied,false);
});
test('access probe distinguishes authentication denial from an arbitrary redirect',async()=>{
 for(const status of [401,403])assert.equal((await checkAnonymousChatAccess('https://owner-app.invalid',async()=>new Response(null,{status}))).anonymousDenied,true);
 assert.equal((await checkAnonymousChatAccess('https://owner-app.invalid',async()=>new Response(null,{status:302,headers:{location:'https://vercel.com/sso-api?returnUrl=redacted'}}))).anonymousDenied,true);
 assert.equal((await checkAnonymousChatAccess('https://owner-app.invalid',async()=>new Response(null,{status:302,headers:{location:'https://example.invalid/public'}}))).anonymousDenied,false);
});
test('access probe refuses credentials and arbitrary resource URLs',async()=>{
 for(const url of ['http://owner-app.invalid','https://user:password@owner-app.invalid','https://owner-app.invalid/private','https://owner-app.invalid?token=secret'])await assert.rejects(checkAnonymousChatAccess(url,async()=>{throw Error('must not fetch');}),/bare HTTPS origin/);
});
