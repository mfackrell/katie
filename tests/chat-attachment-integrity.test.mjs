import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const manifest={};
vm.runInNewContext(compile(readFileSync('lib/uploads/attachment-manifest.ts','utf8')),{exports:manifest,require});
const accounting={};
vm.runInNewContext(compile(readFileSync('lib/standalone-accounting/context.ts','utf8')),{exports:accounting,require});
const source=readFileSync('app/api/chat/route.ts','utf8');
const ast=ts.createSourceFile('route.ts',source,ts.ScriptTarget.Latest,true);
function declaration(name){const found=ast.statements.filter(node=>ts.isFunctionDeclaration(node)?node.name?.text===name:ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast)===name));assert.equal(found.length,1,name);return found[0].getText(ast);}
const base={actorId:'actor',chatId:'chat',message:'Describe this image'};
const counts={imageCount:1,videoCount:0,fileCount:0};
const image={fileId:'private-image',fileName:'current.png',mimeType:'image/png',attachmentKind:'image',storageToken:'opaque-private-token',preview:'Image attachment'};
const request=body=>new Request('https://katie.test/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function harness(){
 const calls=[];const exports={};
 vm.runInNewContext(compile([declaration('fileReferenceSchema'),declaration('requestSchema'),declaration('parseIncomingPayload'),declaration('POST')].join('\n')),{exports,...manifest,...accounting,z:require('zod').z,console:{error(){}},
 NextResponse:{json:(body,options)=>Response.json(body,options)},
 getSupabaseAdminClient(){calls.push('database');throw new Error('database sentinel');},
 });return {POST:exports.POST,calls};
}
for(const [name,body] of [
 ['missing all current media',{...base,attachmentManifest:counts}],
 ['duplicate current source count',{...base,fileReferences:[image,image],attachmentManifest:counts}],
 ['legacy and private duplicate current image',{...base,fileReferences:[image],images:['data:image/png;base64,YQ=='],attachmentManifest:counts}],
 ...[null,{...counts,imageCount:'1'},{...counts,imageCount:-1},{...counts,imageCount:1.5},{...counts,extra:true},{...counts,fileCount:5}].map(attachmentManifest=>['invalid manifest '+JSON.stringify(attachmentManifest),{...base,attachmentManifest}]),
])test(`actual POST rejects ${name} before database, history, or providers`,async()=>{
 const h=harness();const response=await h.POST(request(body));assert.equal(response.status,400);assert.equal((await response.json()).code,'attachment_integrity');assert.deepEqual(h.calls,[]);
});
for(const [name,body] of [
 ['valid private image',{...base,fileReferences:[image],attachmentManifest:counts}],
 ['legacy absent manifest',{...base,fileReferences:[image]}],
])test(`actual POST retains ${name} compatibility and reaches actor authorization`,async()=>{
 const h=harness();await h.POST(request(body));assert.deepEqual(h.calls,['database']);
});
// Run the production hydration-to-history boundary verbatim, using trusted
// hydration fixtures. No history/provider access is mocked into the guard itself.
const start=source.indexOf('    const newAttachments = await hydrateStoredAttachments');
const end=source.indexOf('    const catalog =',start);
assert.ok(start>0&&end>start);
async function hydrate(hydrated){
 const calls=[];const context={...manifest,payload:{attachmentManifest:counts},fileReferences:[image],requestImages:[],
 hydrateStoredAttachments:async refs=>{assert.equal(refs[0].storageToken,image.storageToken);calls.push('trusted-hydration');return hydrated;},
 cachedWorkflowValue:async(key,fn)=>{calls.push(key);return fn();},getRecentMessages:async()=>{calls.push('history');return [];},chatId:'chat',Map,
 NextResponse:{json:(body,options)=>Response.json(body,options)},console:{info:(_label,value)=>calls.push(JSON.parse(JSON.stringify(value)))},
 };
 const run=()=>vm.runInNewContext(compile(`(async()=>{${source.slice(start,end)}return {newCount:newAttachments.length,currentAttachmentCounts};})()`),context);
 return {calls,run};
}
for(const [name,hydrated] of [['missing',[]],['different trusted media',[{...image,mimeType:'application/pdf',attachmentKind:'file'}]],['metadata-only image',[image]]])test(`trusted hydration ${name} fails before historical restoration or model execution`,async()=>{
 const h=await hydrate(hydrated);await assert.rejects(h.run,error=>error.code==='attachment_integrity');assert.deepEqual(h.calls,['trusted-hydration']);
});
test('valid private image hydration produces canonical current newCount 1 before history',async()=>{
 const h=await hydrate([{...image,imageDataUrl:'data:image/png;base64,YQ=='}]);const result=await h.run();assert.equal(result.newCount,1);assert.deepEqual(JSON.parse(JSON.stringify(result.currentAttachmentCounts)),counts);
 assert.equal(h.calls[1].newCount,1);assert.equal(h.calls[1].imageCount,1);assert.deepEqual(h.calls.slice(2),['attachment-history','history']);
});
test('legacy workflow absent manifest uses actual typed source counts without claims of ownership',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(manifest.validateAttachmentManifest(undefined,[image]))),counts);
});
