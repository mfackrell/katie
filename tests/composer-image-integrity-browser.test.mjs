import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import ts from 'typescript';
import bundledChromium from '@sparticuz/chromium';

test('composer images preserve selection identity through picker, paste, restore and failed upload', {timeout:170000}, async()=>{
 const root=resolve('.'), project=await mkdtemp(join(tmpdir(),'composer-next-'));
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(done=>socket.close(done));
 const origin=`http://127.0.0.1:${port}`,actorId='22222222-2222-4222-8222-222222222222',chatId='33333333-3333-4333-8333-333333333333';
 let server,browser,page,output='',mode='ok';const errors=[],external=[],chats=[],events=[],uploads=new Map();let sequence=0;
 const manifestModule={exports:{}};new Function('require','module','exports',ts.transpileModule(await readFile(join(root,'lib/uploads/attachment-manifest.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(createRequire(import.meta.url),manifestModule,manifestModule.exports);
 const {validateAttachmentManifest}=manifestModule.exports;const receivedCounts=new WeakMap();
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV3cAAAAASUVORK5CYII=';
 try{
    await mkdir(join(project, 'app/conversations/[id]'), { recursive: true });
    await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true }));
    await writeFile(join(project, 'next.config.mjs'), `export default {experimental:{externalDir:true},webpack(config){config.resolve.alias={...config.resolve.alias,'@/lib/tools/browser-owner-session$':${JSON.stringify(join(project, 'owner-session.ts'))},'@':${JSON.stringify(root)}};return config;}};`);
    await writeFile(join(project, 'postcss.config.mjs'), 'export default {plugins:{tailwindcss:{}}};');
    await writeFile(join(project, 'tailwind.config.mjs'), `export default {darkMode:['class'],content:[${JSON.stringify(root + '/components/**/*.{ts,tsx}')},${JSON.stringify(root + '/lib/**/*.{ts,tsx}')}],theme:{extend:{}},plugins:[]};`);
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'], strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', resolveJsonModule: true, baseUrl: '.', paths: { '@/lib/tools/browser-owner-session': ['./owner-session.ts'], '@/*': [root + '/*'] } }, include: ['**/*.ts', '**/*.tsx'] }));
    await writeFile(join(project, 'owner-session.ts'), "'use client'; export function browserOwnerAuth(){return null;} export async function ownerSessionBearer(){return 'synthetic-browser-owner';}");
    await writeFile(join(project, 'app/layout.tsx'), `import ${JSON.stringify(root + '/app/globals.css')}; import {ApplicationShell} from '@/components/application-shell'; export default function Layout({children}:{children:React.ReactNode}){return <html lang="en" className="dark"><body><ApplicationShell>{children}</ApplicationShell></body></html>;}`);
    await writeFile(join(project, 'app/conversations/[id]/page.tsx'), `import ChatWorkspace from '@/components/chat-workspace'; export default function Page(){return <ChatWorkspace conversationId=${JSON.stringify(chatId)}/>;}`);
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const deadline = Date.now() + 65000;
    while (!output.includes('Ready in')) {
      if (server.exitCode !== null || Date.now() > deadline) throw Error('Disposable Next server did not start: ' + output);
      await new Promise(done => setTimeout(done, 100));
    }
    browser = await chromium.launch({ executablePath: process.env.KATIE_TEST_CHROMIUM || await bundledChromium.executablePath(), args: bundledChromium.args, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(()=>{
      if(sessionStorage.getItem('composer-idb-released'))return;
      const open=indexedDB.open.bind(indexedDB),pending=[];let released=false;
      indexedDB.open=(...args)=>{
        const req=open(...args);if(args[0]!=='katie-pending-input-v1')return req;
        return new Proxy(req,{get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},set(target,key,value){
          if(key==='onsuccess'){target.onsuccess=event=>{if(released)value?.call(target,event);else pending.push(()=>value?.call(target,event));};return true;}
          return Reflect.set(target,key,value,target);
        }});
      };
      window.__releaseComposerDatabase=()=>{released=true;sessionStorage.setItem('composer-idb-released','1');for(const callback of pending.splice(0))callback();};
    });
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin){external.push(req.url());return route.abort();}
  if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/fixture-storage/'))return route.continue();
  const body=req.postData()&&req.headers()['content-type']?.includes('application/json')?req.postDataJSON():null;
  const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  if(url.pathname==='/api/upload/prepare'){events.push('prepare');if(mode==='failed')return reply({error:'Fixture upload refused'},503);const token=`image-${++sequence}`;uploads.set(token,body);return reply({uploadToken:token,uploadUrl:`${origin}/fixture-storage/${token}`});}
  if(url.pathname.startsWith('/fixture-storage/')){events.push('storage');assert.deepEqual(req.postDataBuffer(),Buffer.from(png,'base64'),'private upload bytes match the visible PNG, including legacy recovery');return reply({});}
  if(url.pathname==='/api/upload/complete'){events.push('complete');const file=uploads.get(body.uploadToken);return reply({fileReference:{fileId:body.uploadToken,fileName:mode==='mismatch'?'wrong.png':file.name,mimeType:file.type,attachmentKind:'image',preview:'Image fixture',storageToken:`fixture-private-ref-${body.uploadToken}`}});}
  if(url.pathname==='/api/chat'){events.push('chat');const counts=validateAttachmentManifest(body.attachmentManifest,body.fileReferences,body.images);receivedCounts.set(body,counts.imageCount+counts.videoCount+counts.fileCount);chats.push(body);return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'content',text:'Fixture image response.'})+'\n'});}
  if(url.pathname==='/api/actors')return reply({actors:[{id:actorId,name:'Fixture Katie',purpose:'Composer verification',actorKind:'standard'}]});
  if(url.pathname==='/api/chats')return reply({chats:[{id:chatId,actorId,title:'Composer fixture',createdAt:'2026-10-29T00:00:00Z',updatedAt:'2026-10-29T00:00:00Z'}]});
  if(url.pathname==='/api/messages')return reply({messages:[]});
  if(url.pathname==='/api/projects')return reply({active:false,status:null,approval:null,resourceRecovery:null,messages:[]});
  if(url.pathname==='/api/standalone-accounting/usage')return reply({configuration:null,pending:[],active:[],daily:null});
  if(url.pathname==='/api/ui-state')return reply({state:{key:body?.key??url.searchParams.get('key'),version:1,value:body?.value??{}}});
  if(url.pathname==='/api/models')return reply({openai:['gpt-4o']});
  if(url.pathname==='/api/message-reactions')return reply({reactions:{}});
  if(url.pathname==='/api/long-term-memory')return reply({content:{entries:[]},documents:[]});
  if(url.pathname==='/api/work')return reply({items:[],warnings:[]});
  if(url.pathname==='/api/admin/repos')return reply({repos:[]});
  if(url.pathname==='/api/version')return reply({version:'fixture'});
  return reply({error:'Unexpected fixture API'},404);
 });
 const open=async()=>{await page.goto(`${origin}/conversations/${chatId}`,{waitUntil:'domcontentloaded',timeout:65000});await page.locator('main textarea').last().waitFor();};
 const preview=()=>page.getByAltText(/^Selected image /);
 const file=name=>({name,mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 const send=async()=>{await page.locator('main textarea').last().fill('Describe the selected image');await page.locator('main textarea').last().press('Enter');};
 const verify=(body,count)=>{assert.deepEqual(body.images,[]);assert.equal(receivedCounts.get(body),count,'real server manifest helper receives every selected source');assert.equal(JSON.stringify(body).includes(png),false,'chat contains no original base64 image bytes');assert.equal(JSON.stringify(body).includes('data:image/'),false,'chat contains only compact private image references');assert.equal(body.fileReferences.length,count);assert.equal(body.attachmentManifest.imageCount,count);assert.equal(new Set(body.fileReferences.map(r=>r.fileId)).size,count);assert.ok(body.fileReferences.every(r=>r.attachmentKind==='image'));};
 const waitChats=async count=>{await page.waitForFunction(()=>!document.querySelector('main textarea')?.disabled);await new Promise((resolve,reject)=>{const end=Date.now()+10000;const timer=setInterval(()=>{if(chats.length>=count){clearInterval(timer);resolve();}else if(Date.now()>end){clearInterval(timer);reject(Error('Expected chat transmission'));}},30);});};
 await open();
 // A slow IndexedDB read must not disable an ordinary text-only conversation.
 await send();await waitChats(1);verify(chats[0],0);assert.equal(events.join(','),'chat');
 await page.waitForFunction(()=>[...document.querySelectorAll('main textarea')].at(-1)?.value==='');
 // A fresh visible image while that read is pending must never become text-only.
 await page.locator('input[type=file]').setInputFiles(file('pending-read.png'));await preview().waitFor();await page.locator('main textarea').last().fill('Keep this visible image attached');await page.locator('main textarea').last().press('Enter');
 assert.equal(chats.length,1);assert.equal(events.join(','),'chat');assert.equal(await preview().count(),1);
 await page.evaluate(()=>window.__releaseComposerDatabase());await send();await waitChats(2);verify(chats[1],1);assert.equal(chats[1].fileReferences[0].fileName,'pending-read.png');await preview().waitFor({state:'detached'});
 chats.length=0;events.length=0;
 // File picker creates a visible selection; private storage receipt precedes chat.
 await page.locator('input[type=file]').setInputFiles(file('picker.png'));await preview().waitFor();await send();await waitChats(1);verify(chats[0],1);assert.deepEqual(events.slice(0,4),['prepare','storage','complete','chat']);await preview().waitFor({state:'detached'});
 // Real paste event follows the same upload path, including after a browser reload.
 await page.locator('main textarea').last().evaluate((el,png)=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png);
 await preview().waitFor();await page.reload({waitUntil:'domcontentloaded'});await preview().waitFor();await send();await waitChats(2);verify(chats[1],1);assert.equal(chats[1].fileReferences[0].fileName,'pasted.png');await preview().waitFor({state:'detached'});
 // Migration of preview-only IndexedDB drafts reconstructs the missing File.
 const seed=async(images,legacyWrongFile=false)=>{await page.evaluate(async({chatId,images,legacyWrongFile,png})=>{await new Promise((resolve,reject)=>{const req=indexedDB.open('katie-pending-input-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('conversations');req.onsuccess=()=>{const db=req.result,tx=db.transaction('conversations','readwrite');tx.objectStore('conversations').put({images,imageFiles:legacyWrongFile?[new File(['unrelated bytes'],'wrong-source.png',{type:'image/png'})]:[],videos:[],files:[],references:[]},chatId);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});},{chatId,images,legacyWrongFile,png});await page.reload({waitUntil:'domcontentloaded'});};
 await seed([`data:image/png;base64,${png}`]);await preview().waitFor();await send();await waitChats(3);verify(chats[2],1);assert.equal(chats[2].fileReferences[0].fileName,'restored-image-1.png');await preview().waitFor({state:'detached'});
 // Invalid preview sources are visible but must block before prepare or chat.
 await seed(['data:image/png;base64,INVALID']);await preview().waitFor();const prior=events.length;await send();await page.getByRole('alert').filter({hasText:'no recoverable source'}).waitFor();assert.equal(events.length,prior);assert.equal(chats.length,3);
 await preview().locator('..').getByRole('button').click();await preview().waitFor({state:'detached'});
 // A failed or mismatched receipt cannot consume the selection or transmit chat.
 for(const failure of ['failed','mismatch']){mode=failure;await page.locator('input[type=file]').setInputFiles(file(`${failure}.png`));await preview().waitFor();await send();await page.getByRole('alert').filter({hasText:failure==='failed'?'Fixture upload refused':'mismatched image source'}).waitFor();assert.equal(chats.length,3);assert.equal(await preview().count(),1);await preview().locator('..').getByRole('button').click();await preview().waitFor({state:'detached'});}
 mode='ok';
 // Removing one of several images removes its source, not an adjacent File.
 await page.locator('input[type=file]').setInputFiles([file('removed.png'),file('retained.png')]);await page.getByAltText('Selected image 2').waitFor();await page.getByAltText('Selected image 1').locator('..').getByRole('button').click();await send();await waitChats(4);verify(chats[3],1);assert.equal(chats[3].fileReferences[0].fileName,'retained.png');await preview().waitFor({state:'detached'});
 await page.locator('input[type=file]').setInputFiles([file('first.png'),file('second.png')]);await page.getByAltText('Selected image 2').waitFor();await send();await waitChats(5);verify(chats[4],2);assert.deepEqual(chats[4].fileReferences.map(r=>r.fileName),['first.png','second.png']);
 await preview().waitFor({state:'detached'});
 // A canonical visible image already holding its private receipt survives reload
 // without preparing or uploading a second copy.
 const existingReference={fileId:'existing-image',fileName:'already-uploaded.png',mimeType:'image/png',attachmentKind:'image',preview:'Image fixture',storageToken:'fixture-private-ref-existing'};
 await seed([{preview:`data:image/png;base64,${png}`,reference:existingReference}]);await preview().waitFor();const noUploadBefore=events.length;await page.reload({waitUntil:'domcontentloaded'});await preview().waitFor();await send();await waitChats(6);verify(chats[5],1);assert.deepEqual(chats[5].fileReferences,[existingReference]);assert.deepEqual(events.slice(noUploadBefore),['chat']);await preview().waitFor({state:'detached'});
 // Equal-length legacy arrays are not evidence that a File matches its preview.
 await seed([`data:image/png;base64,${png}`],true);await preview().waitFor();await send();await waitChats(7);verify(chats[6],1);assert.equal(chats[6].fileReferences[0].fileName,'restored-image-1.png');assert.notEqual(chats[6].fileReferences[0].fileName,'wrong-source.png');
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 }catch(error){throw new Error(`${error.message}\nUI: ${await page?.locator('body').innerText().catch(()=> 'unavailable')}\nNext: ${output}`,{cause:error});}
 finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([once(server,'exit'),new Promise(done=>setTimeout(done,4000))]);if(server.exitCode===null)server.kill('SIGKILL');}await rm(project,{recursive:true,force:true});}
});
