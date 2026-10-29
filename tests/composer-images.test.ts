import test from 'node:test';
import assert from 'node:assert/strict';
import { composerImage, prepareComposerImages, migrateComposerImages, assertImageUploadReferences } from '../lib/ui/composer-images';
const preview='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=';
const receipt=(file:File,id='image-1')=>({fileId:id,storageToken:'fixture-private-'+id,fileName:file.name,mimeType:file.type,attachmentKind:'image' as const,preview:''});
test('visible legacy preview without a File is reconstructed into its upload source',async()=>{
 const images=migrateComposerImages([preview]);
 const prepared=prepareComposerImages(images);
 assert.equal(prepared.files.length,1);assert.equal(prepared.references.length,0);
 assert.equal(prepared.files[0].type,'image/png');assert.ok(prepared.files[0].size>0);
 assert.equal(Buffer.from(await prepared.files[0].arrayBuffer()).toString('base64'),preview.split(',')[1]);
 assertImageUploadReferences(prepared.files,[receipt(prepared.files[0])]);
});
test('legacy array length mismatch cannot pair a later file with the wrong visible image',()=>{
 const images=migrateComposerImages([preview,preview]);
 assert.ok(images.every(image=>!image.file));
 assert.equal(prepareComposerImages(images).files.length,2);
});
test('equal-length legacy arrays do not substitute a stale File for the visible preview',async()=>{
 const {cleanPendingAttachments}=await import('../lib/ui/pending-attachments');
 const stale=new File(['stale other image'],'stale.png',{type:'image/png'});
 const migrated=cleanPendingAttachments({images:[preview],imageFiles:[stale],files:[],videos:[],references:[]});
 const file=prepareComposerImages(migrated.images).files[0];
 assert.notEqual(file,stale);assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'),preview.split(',')[1]);
});
test('oversized recovered previews stop before decoding',()=>{assert.throws(()=>prepareComposerImages([{preview:'data:image/png;base64,'+'A'.repeat(Math.ceil(20*1024*1024/3)*4+4)}]),/20 MiB/);});
test('invalid missing image source blocks preparation rather than dropping the visible selection',()=>{
 for(const invalid of ['blob:expired','data:image/png;base64,','data:image/png;base64,%%%%','data:image/png;base64,QUJD','not an image'])assert.throws(()=>prepareComposerImages([{preview:invalid}]),/recoverable source|empty/);
});
test('visible selections and original supported File are represented atomically',()=>{
 const file=new File(['pixels'],'fresh.png',{type:'image/png'});
 assert.equal(composerImage(preview,file).file,file);
 const image=composerImage(preview,new File(['raw'],'camera.heic',{type:'image/heic'}));
 assert.equal(image.file?.type,'image/png');assert.equal(image.preview,preview);
});
test('image upload omissions, wrong identity and duplicate receipts stop before inline previews can be discarded',()=>{
 const files=prepareComposerImages([{preview},{preview}]).files;
 assert.throws(()=>assertImageUploadReferences(files,[receipt(files[0])]),/every selected image/);
 assert.throws(()=>assertImageUploadReferences(files,[receipt(files[0]),receipt(files[1])]),/mismatched/);
 assert.throws(()=>assertImageUploadReferences(files,[receipt(files[0]),{...receipt(files[1],'image-2'),fileName:'wrong.png'}]),/mismatched/);
 assert.throws(()=>assertImageUploadReferences(files,[receipt(files[0]),{...receipt(files[1],'image-2'),mimeType:'image/jpeg'}]),/mismatched/);
 assertImageUploadReferences(files,[receipt(files[0]),receipt(files[1],'image-2')]);
});

test('metadata-only image references cannot replace a durable source or suppress upload',async()=>{
 const metadata={fileId:'metadata-only',fileName:'stale.png',mimeType:'image/png',attachmentKind:'image' as const,preview:''};
 const prepared=prepareComposerImages([{preview,reference:metadata}]);
 assert.equal(prepared.references.length,0);assert.equal(prepared.files.length,1);
 assert.equal(Buffer.from(await prepared.files[0].arrayBuffer()).toString('base64'),preview.split(',')[1]);
 assert.throws(()=>prepareComposerImages([{preview:'blob:expired',reference:metadata}]),/recoverable source/);
 assert.throws(()=>assertImageUploadReferences(prepared.files,[{...receipt(prepared.files[0]),storageToken:undefined}]),/mismatched/);
 const durable={...receipt(prepared.files[0]),storageToken:'saved-private-token'};
 assert.deepEqual(prepareComposerImages([{preview,reference:durable}]),{files:[],references:[durable]});
});

test('image receipt identity uses the upload service canonical trimmed filename',()=>{
 const file=new File(['pixels'],' photo.png ',{type:'image/png'});
 assertImageUploadReferences([file],[{...receipt(file),fileName:'photo.png'}]);
 assert.throws(()=>assertImageUploadReferences([file],[{...receipt(file),fileName:'other.png'}]),/mismatched/);
});
