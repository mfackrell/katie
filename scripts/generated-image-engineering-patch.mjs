import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
// Temporary exact-byte engineering transfer; no network, production credentials or inference.
const plan = [
  {
    path:'app/api/chat/route.ts',
    before:'a0b837b00b668382a1d33c46525a6adb32ba47ea1fb786815cc0d27e6546a589',
    after:'0dfcad3d02f1d59f38611cfb205ec728d8f1a29068ca9fa75ff6e913afc73f1c',
    line:1120,
    text:'      // Cached source selection does not prove that original bytes still exist.\n      // Revalidate generated sources even for edit/recovery paths that skip Qwen.\n      if (saved.generatedSource) return (await readGeneratedImage(actorId,owner.id,saved.id)).reference;\n',
  },
  {
    path:'tests/generated-image-perception.test.ts',
    before:'35fcff75e9328ea6fbd4cd0d2fc3bc6c386251312227a64d5cc43f5f2bf63ac3',
    after:'4095bc4630400c6257d4c0f35520dd31da6c27626b455ba855f322846043796b',
    line:281,
    text:"\n\ntest('actual route restoration revalidates generated original bytes even when source selection was checkpointed',async()=>{\n  const fake=storage(),saved=await generate(fake,{url:await image()}),d=saved.attachments[0];\n  const route=readFileSync('app/api/chat/route.ts','utf8');\n  const start=route.indexOf('    const restored = await loadSelectedAttachmentSources(');\n  const end=route.indexOf('    // Index the exact selected source',start);\n  assert.ok(start>0&&end>start);\n  const code=ts.transpileModule(`(async()=>{${route.slice(start,end)}return restored;})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;\n  let genericReads=0;\n  const run=()=>vm.runInNewContext(code,{\n    actorId,chatId,attachmentDecision:{method:'continuity',selections:[{attachment:d,mode:'source'}]},\n    getChatById:async()=>({actorId,id:chatId}),\n    loadSelectedAttachmentSources:async(_decision:unknown,restore:(source:ConversationAttachment)=>Promise<unknown>)=>restore(d),\n    readGeneratedImage:(...args:Parameters<ReturnType<typeof fake.factory>['readGenerated']>)=>fake.factory().readGenerated(...args),\n    restoreConversationAttachment:async()=>{genericReads++;throw Error('Cannot trust generic cached renderer without the original');},\n  });\n  assert.equal((await run()).fileId,d.id);\n  fake.files.delete(`chats/${chatId}/${d.id}.source`);\n  await assert.rejects(run(),/unavailable/);\n  assert.equal(genericReads,0);\n});\n",
  },
];
const hash=s=>createHash('sha256').update(s).digest('hex');
const outputs=plan.map(p=>{
  const before=readFileSync(p.path,'utf8');
  if(hash(before)===p.after)return [p.path,before];
  assert.equal(hash(before),p.before,'Source changed: '+p.path);
  const lines=before.match(/[^\n]*\n|[^\n]+$/g)??[];
  lines.splice(p.line,0,...(p.text.match(/[^\n]*\n|[^\n]+$/g)??[]));
  const after=lines.join('');assert.equal(hash(after),p.after,'Transfer mismatch: '+p.path);
  return [p.path,after];
});
for(const [path,source] of outputs)writeFileSync(path,source);
writeFileSync('/tmp/generated-image-paths.txt',plan.map(p=>p.path).join('\n')+'\n');
console.log('Replay correction matches the locally qualified application and 17-test lifecycle suite.');
