// Fast isolated preflight: the VM's captured fetch must be the synthetic
// transport before any mission-backed OpenAI provider is constructed.
import assert from 'node:assert/strict';
import {modules} from './load-project-modules.mjs';

const originalFetch=globalThis.fetch;
const oldKey=process.env.OPENAI_API_KEY;
let requests=0;
try {
 process.env.OPENAI_API_KEY='synthetic-task3c-only';
 globalThis.fetch=async input=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  assert.equal(url.origin,'https://api.openai.com','No real or alternate provider host is permitted');
  assert.equal(url.pathname,'/v1/models');
  requests++;
  return Response.json({object:'list',data:[{id:'gpt-5.3-codex',object:'model',created:1,owned_by:'synthetic'}]});
 };
 const load=modules();
 const providers=load('@/lib/providers').getAvailableProviders();
 const openai=providers.find(p=>p.name==='openai');
 assert.ok(openai,'Synthetic OpenAI provider not connected');
 assert.deepEqual(await openai.listModels(),['gpt-5.3-codex']);
 assert.equal(requests,1);
 console.log('TASK3C_SYNTHETIC_PROVIDER_DISCOVERY_PASS');
} finally {
 globalThis.fetch=originalFetch;
 if(oldKey===undefined)delete process.env.OPENAI_API_KEY;
 else process.env.OPENAI_API_KEY=oldKey;
}
