import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingAttachments, LegacyPendingAttachments } from '../lib/ui/pending-attachments';
import type { FileReference } from '../lib/providers/types';
const ref=(kind:string,mimeType:string):FileReference=>({fileId:kind,fileName:kind,mimeType,attachmentKind:kind as FileReference['attachmentKind'],preview:''});
test('legacy failed image retry state is durably cleaned on load and stays clean after refresh; explicit images, files and video survive',async t=>{
 const records=new Map<string,PendingAttachments | LegacyPendingAttachments>();
 const image=ref('image','image/jpeg'),legacy={...image,attachmentKind:undefined},pdf=ref('file','application/pdf'),video=ref('video','video/mp4');
 const selected=new File(['pixels'],'fresh.jpg',{type:'image/jpeg'});
 records.set('incident',{images:['data:image/jpeg;base64,QUJD'],imageFiles:[selected],files:[],videos:[],references:[image,legacy,pdf,video]});
 const original=globalThis.indexedDB;
 globalThis.indexedDB={open(){
   const open:any={};queueMicrotask(()=>{open.result={close(){},transaction(){const tx:any={objectStore(){return {get(id:string){const req:any={};queueMicrotask(()=>{req.result=records.get(id);req.onsuccess();});return req;},put(value:PendingAttachments,id:string){records.set(id,structuredClone(value));setTimeout(()=>tx.oncomplete(),0);},delete(id:string){records.delete(id);setTimeout(()=>tx.oncomplete(),0);}};}};return tx;}};open.onsuccess();});return open;
 }} as unknown as IDBFactory;
 t.after(()=>{globalThis.indexedDB=original;});
 let path=require.resolve('../lib/ui/pending-attachments');
 delete require.cache[path];let api=require(path) as typeof import('../lib/ui/pending-attachments');
 let restored=(await api.readPendingAttachments('incident'))!;
 assert.deepEqual(restored.references,[pdf,video]);assert.deepEqual(records.get('incident')!.references,[pdf,video]);
 assert.equal(restored.images[0].preview,'data:image/jpeg;base64,QUJD');assert.equal(restored.images[0].file,undefined);assert.equal('imageFiles' in records.get('incident')!,false);
 delete require.cache[path];api=require(path); // Refresh: no module memory, same IndexedDB.
 restored=(await api.readPendingAttachments('incident'))!;assert.deepEqual(restored.references,[pdf,video]);
 records.set('text-only',{images:[],imageFiles:[],files:[],videos:[],references:[image]});
 const text=(await api.readPendingAttachments('text-only'))!;
 assert.deepEqual(text.references,[]);assert.deepEqual(text.images,[]);assert.equal(records.has('text-only'),false);
});

test('storage failure preserves cleaned session attachments and reports failed persistence',async t=>{
 const original=globalThis.indexedDB;t.after(()=>{globalThis.indexedDB=original;});
 globalThis.indexedDB={open(){const request:any={};queueMicrotask(()=>{request.error=Error('Storage unavailable');request.onerror();});return request;}} as unknown as IDBFactory;
 const {savePendingAttachments,readPendingAttachments}=await import('../lib/ui/pending-attachments');
 const image=new File(['pixels'],'selected.jpg',{type:'image/jpeg'});
 await assert.rejects(savePendingAttachments('session-fallback',{images:[{preview:'current pixels',file:image}],files:[],videos:[],references:[ref('image','image/jpeg'),ref('video','video/mp4')]}));
 let failures=0;const restored=(await readPendingAttachments('session-fallback',()=>failures++))!;
 assert.equal(failures,1);assert.equal(restored.images[0].file,image);assert.equal(restored.images[0].preview,'current pixels');assert.deepEqual(restored.references,[ref('video','video/mp4')]);
});
