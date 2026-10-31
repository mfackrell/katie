// Test-only transport redirect. Loaded ONLY by the disposable host subprocess;
// never copied into the SDK/application sandbox or imported by production.
import assert from 'node:assert/strict';
const endpoint=process.env.KATIE_RECOVERY_FIXTURE_ENDPOINT;
assert.match(endpoint??'',/^http:\/\/127\.0\.0\.1:\d+$/);
const transport=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 assert.ok(['api.openai.com','barclcqataqyvifoeyop.supabase.co'].includes(url.hostname),'Unexpected outbound destination');
 return transport(endpoint+'/'+(url.hostname==='api.openai.com'?'provider':'database')+url.pathname+url.search,init);
};

// Observe the real verifier output immediately before normal host cleanup.
// No verifier result is replaced and cleanup still executes synchronously.
import fs from 'node:fs';
import {join,basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const remove=fs.rmSync;
fs.rmSync=function(path,options){
 if(typeof path==='string'&&basename(path).startsWith('katie-trusted-gateway-')){
  const source=join(path,'project-acceptance.json');
  if(fs.existsSync(source)){
   const bytes=fs.readFileSync(source);assert.ok(bytes.length<64000);
   fs.writeFileSync(join(process.env.RUNNER_TEMP,'qualification-browser-acceptance.json'),bytes);
  }
 }
 return remove.call(this,path,options);
};
syncBuiltinESMExports();
