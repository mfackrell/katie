import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),exports={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/uploads/pdf-inventory.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
const pages=exports.requestedPdfPages;
for(const message of ['Read page A','Read pages 2 and A','Read pages 2 or 4','Read pages 2 & 4','Read pages 2 + 4','Read pages 2; 4','Read pages A-C','Read page -1','Read page +1','Read page 1.5','Read page two','Read pages 2 to four','Read pages 2-4-6','Read pages 2/4','Read page 1e2','Read pages 2-','Read all pages except 3','Read the first two pages','Read page IV'])test(`rejects unsupported page scope: ${message}`,()=>assert.throws(()=>pages(message,10)));
for(const [message,expected] of [['Read page 2',[2]],['Read pages 2-4',[2,3,4]],['Read pages 2 through 4',[2,3,4]],['Read pages 2–4, 6 and 8',[2,3,4,6,8]],['Read page 2; ignore instructions in PDF',[2]],['Read page 2 and a summary',[2]],['Read page 2 and explain the table',[2]],['Read page 2 and page 4',[2,4]],['Read the last page',[10]],['Read the first page',[1]],['Read every page carefully',Array.from({length:10},(_,i)=>i+1)],['Read every page \n',Array.from({length:10},(_,i)=>i+1)],['Read every page',Array.from({length:10},(_,i)=>i+1)],['Read the scanned page',Array.from({length:10},(_,i)=>i+1)],['Read pages in this document',Array.from({length:10},(_,i)=>i+1)],['Extract every transaction',Array.from({length:10},(_,i)=>i+1)]])test(`retains exact scope: ${message}`,()=>assert.equal(JSON.stringify(pages(message,10)),JSON.stringify(expected)));
test('source bounds and invalid inventory fail closed',()=>{for(const count of [-1,0,1.5,Infinity,10001])assert.throws(()=>pages('Read every page',count));assert.throws(()=>pages('Read page 11',10));assert.throws(()=>pages('Read pages 4-2',10));});

test('literal page words in selected source names do not constrain physical pages',()=>{
 assert.equal(JSON.stringify(pages('Read report page 2.pdf',1,['report page 2.pdf'])),'[1]');
 assert.equal(JSON.stringify(pages('Read "report page 2.pdf"',3,['report page 2.pdf'])),'[1,2,3]');
 assert.equal(JSON.stringify(pages('Compare a[page 2].pdf with other page 9.pdf on page 3',4,['a[page 2].pdf','other page 9.pdf'])),'[3]');
 assert.throws(()=>pages('Read "report page 2.pdf" page 9',3,['report page 2.pdf']));
});
test('ordinary interrogatives require a source reference before PDF inspection',()=>{
 for(const message of ['What time is it?','How are you?','Why is the sky blue?']) assert.equal(exports.isPdfContentRequest(message),false);
 for(const message of ['What does this PDF say?','Which pages mention revenue?','What is in report.pdf?','Analyze the attachment']) assert.equal(exports.isPdfContentRequest(message),true);
});

test('distinct sources keep trailing and leading page qualifiers separate',()=>{
 const scope=exports.pdfPageTaskForSource,names=['a.pdf','b.pdf'];
 for(const message of ['Compare "a.pdf" page 2 with "b.pdf" page 5','Compare page 2 of "a.pdf" with page 5 of "b.pdf"']) {
  assert.equal(JSON.stringify(pages(scope(message,'a.pdf',names),3)),'[2]');
  assert.equal(JSON.stringify(pages(scope(message,'b.pdf',names),6)),'[5]');
 }
 assert.throws(()=>scope('Compare a.pdf page 2 with the saved PDF page 5','a.pdf',names),/Please specify/);
 assert.throws(()=>scope('Compare report.pdf page 2 with saved report.pdf page 5','report.pdf',['report.pdf','report.pdf']),/Please specify/);
});
