// Disposable Preview transport: real local candidate/Chromium, real production
// receipt validator. GitHub/Vercel publication is synthetic and is NOT evidence
// of a deployed production task. No deployment or production mutation occurs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export const syntheticPreviewOrigin='https://katie-123456789-synthetic.vercel.app';
export function previewTransport(real,{fixture,trace}){
 return {...real,verifyDeployedPreview:async(preview,contract,projectId)=>{
  assert.equal(new URL(preview.url).origin,syntheticPreviewOrigin);
  assert.equal(preview.headSha,fixture.completion.reviewedHeadSha);
  assert.equal(projectId,fixture.context.projectId);
  assert.deepEqual(JSON.parse(JSON.stringify(contract)),fixture.context.contract);
  const run=async(actualContract,origin,options)=>{
   assert.deepEqual(JSON.parse(JSON.stringify(actualContract)),fixture.context.contract);assert.equal(origin,syntheticPreviewOrigin);assert.equal(options.deployed,true);assert.ok(Array.isArray(options.cookies));assert.equal(options.cookies.length,1);assert.equal(options.cookies[0].domain,new URL(syntheticPreviewOrigin).hostname);
   const candidate=fixture.continued,output=join(candidate.runtime,'final-project-browser.json');
   const module=join(candidate.runtime,'project-tools/project-browser-check.mjs');
   const code=`import {checkProject} from ${JSON.stringify(module)}; const r=await checkProject(JSON.parse(process.argv[1])); if(!r?.passed)process.exitCode=1;`;
   const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify({request:join(candidate.runtime,'request.md'),port:3110,output,dependencies:join(candidate.runtime,'project-dependencies/node_modules')})],{cwd:candidate.workspace,env:{PATH:process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
   let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log=(log+b).slice(-5000);});
   const timer=setTimeout(()=>child.kill('SIGKILL'),180000);
   const codeResult=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
   assert.equal(codeResult,0,log);const receipt=JSON.parse(readFileSync(output));
   assert.equal(receipt.passed,true);assert.equal(receipt.headSha,preview.headSha);assert.equal(receipt.contractHash,fixture.context.contractHash);
   fixture.finalBrowser=receipt;trace.push({boundary:'actual_local_final_browser',head:receipt.headSha,contractHash:receipt.contractHash});return receipt.checks;
  };
  const priorSecret=process.env.PROJECT_PREVIEW_BYPASS_SECRET,priorPattern=process.env.PROJECT_PREVIEW_HOST_PATTERN;
  // Synthetic edge authentication only. No real deployment or provider credential.
  process.env.PROJECT_PREVIEW_BYPASS_SECRET='fixture-only-edge-secret';
  process.env.PROJECT_PREVIEW_HOST_PATTERN='^katie-([a-z0-9]{9})-synthetic\\.vercel\\.app$';
  try{return await real.verifyDeployedPreview(preview,contract,projectId,async (url,options)=>{
   assert.equal(new URL(url).origin,syntheticPreviewOrigin);
   if(options.headers?.['x-vercel-protection-bypass']){
    assert.equal(options.headers['x-vercel-protection-bypass'],'fixture-only-edge-secret');
    return new Response(null,{status:302,headers:{'set-cookie':'_vercel_jwt=fixture-host-cookie; Path=/; Secure; HttpOnly','location':'/'}});
   }
   assert.equal(options.headers?.cookie,'_vercel_jwt=fixture-host-cookie');
   return new Response('Synthetic deployment transport; actual candidate checked separately',{status:200});
  },run);}finally{
   if(priorSecret===undefined)delete process.env.PROJECT_PREVIEW_BYPASS_SECRET;else process.env.PROJECT_PREVIEW_BYPASS_SECRET=priorSecret;
   if(priorPattern===undefined)delete process.env.PROJECT_PREVIEW_HOST_PATTERN;else process.env.PROJECT_PREVIEW_HOST_PATTERN=priorPattern;
  }
 }};
}
