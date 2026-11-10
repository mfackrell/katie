/** Offline final-artifact audit. Office commands are explicit; no model calls.
 * Private sources and outputs must remain outside this public checkout.
 * Mechanical evidence does not grant independent professional approval.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {orderedBlockPages} from './document-page-continuity.mjs';
const require=createRequire(import.meta.url);
const {parseDocument,contentText,blockText,normalizedText,pdfTextMatchesSource}=require('../.test-dist/lib/documents/model.js');
const {rasterizePdf}=require('../.test-dist/lib/documents/render.js');
const {launchWebsiteBrowser}=require('../.test-dist/lib/research/website-evidence.js');
const JSZip=require('jszip'),mammoth=require('mammoth');
const options={offices:[]};
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i],value=process.argv[++i];assert.ok(value,'Missing CLI value');
 if(key==='--office')options.offices.push(value);
 else if(key==='--manifest')options.manifest=value;
 else if(key==='--output')options.output=value;
 else throw Error('Unknown option '+key);
}
assert.ok(options.offices.length,'At least one explicit office executable is required');
const repo=realpathSync('.'),outside=p=>{const v=realpathSync(p);return v!==repo&&!v.startsWith(repo+sep)};
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:90000,maxBuffer:10*1024*1024});
const glyphs=s=>normalizedText(s).replace(/\s/gu,'');
const standard=['executive-resume','financial-report','business-agreement'].map(name=>({name,
 source_path:'fixtures/documents/phase1-'+name+'.md',docx_path:'test-artifacts/documents/phase1/'+name+'.docx',
 pdf_path:'test-artifacts/documents/phase1/'+name+'.pdf',requested_pages:name==='executive-resume'?2:null}));
standard.push({name:'large-heading',source_path:'test-artifacts/documents/line-spacing/large-heading.source.md',
 docx_path:'test-artifacts/documents/line-spacing/large-heading.docx',pdf_path:'test-artifacts/documents/line-spacing/large-heading.pdf',requested_pages:null});
const cases=options.manifest?JSON.parse(readFileSync(options.manifest,'utf8')).cases:standard;
assert.ok(Array.isArray(cases)&&cases.length,'No artifact cases');
const output=resolve(options.output??'test-artifacts/documents/final-cross-render');mkdirSync(output,{recursive:true});
const offices=options.offices.map(value=>{const at=value.indexOf('=');assert.ok(at>0);const label=value.slice(0,at),executable=value.slice(at+1);
 assert.match(label,/^[a-zA-Z0-9_-]+$/);return {label,executable,version:run(executable,['--version']).trim()};});
const report={engine_commit:run('git',['rev-parse','HEAD']).trim(),engine_files:{},office_versions:offices.map(({label,version})=>({label,version})),cases:[],independent_visual_review:'PENDING',release_approved:false};
for(const file of ['generate','model','markdown','render','production','design','continuity','service','storage','saved-source'])
 report.engine_files['lib/documents/'+file+'.ts']=sha(readFileSync('lib/documents/'+file+'.ts'));
const browser=await launchWebsiteBrowser();
try{
 for(const item of cases){
  assert.match(item.name,/^[a-zA-Z0-9_-]+$/);assert.ok(item.requested_pages===null||Number.isInteger(item.requested_pages));
  if(item.private){assert.notEqual(process.env.GITHUB_ACTIONS,'true','Private source prohibited in public CI');
   for(const p of [item.source_path,item.docx_path,item.pdf_path,output])assert.ok(outside(p),'Private files must remain outside Git');
   assert.match(item.source_sha256??'',/^[a-f0-9]{64}$/,'Private source needs approved hash');}
  const raw=readFileSync(item.source_path);if(item.source_sha256)assert.equal(sha(raw),item.source_sha256,'Approved source changed');
  const spec=parseDocument(raw.toString('utf8'),item.requested_pages??undefined),source=contentText(spec);
  const docx=readFileSync(item.docx_path),zip=await JSZip.loadAsync(docx),xml=await zip.file('word/document.xml').async('string');
  const extracted=await mammoth.extractRawText({buffer:docx});assert.equal(normalizedText(extracted.value),normalizedText(source),'DOCX semantic content differs');
  const sizes=[...xml.matchAll(/<w:sz\b[^>]*w:val="(\d+)"/g)].map(m=>Number(m[1]));assert.ok(sizes.length&&Math.min(...sizes)>=22,'DOCX font floor');
  const margins=[...xml.matchAll(/<w:pgMar\b[^>]*>/g)].map(([tag])=>Object.fromEntries(['top','bottom','left','right'].map(k=>[k,Number(tag.match(new RegExp('w:'+k+'="(\\d+)"'))?.[1])/20])));
  assert.ok(margins.length&&margins.every(m=>JSON.stringify(m)===JSON.stringify(margins[0])),'Different or missing page margins require explicit support');
  const frame=margins[0];for(const n of Object.values(frame))assert.ok(Number.isFinite(n)&&n>0);
  const target=join(output,item.name);mkdirSync(target,{recursive:true});
  const row={name:item.name,private:Boolean(item.private),source_sha256:sha(raw),semantic_sha256:sha(source),requested_pages:item.requested_pages,
   docx_sha256:sha(docx),minimum_docx_body_pt:Math.min(...sizes)/2,docx_semantic_fidelity:'PASS',margins_pt:frame,renderers:{}};
  const pdfs=[{label:'chromium',path:resolve(item.pdf_path)}];
  for(const office of offices){
   const dir=join(target,office.label);mkdirSync(dir,{recursive:true});const profile=mkdtempSync(join(tmpdir(),'katie-office-'));
   try{run(office.executable,['-env:UserInstallation=file://'+profile,'--headless','--convert-to','pdf','--outdir',dir,resolve(item.docx_path)]);}finally{rmSync(profile,{recursive:true,force:true});}
   const stem=item.docx_path.split('/').at(-1).replace(/\.docx$/i,'');pdfs.push({label:office.label,path:join(dir,stem+'.pdf')});
  }
  for(const pdf of pdfs){
   const bytes=readFileSync(pdf.path),rendered=await rasterizePdf(browser,bytes);
   assert.deepEqual(rendered.findings,[],pdf.label+': actual PDF font/shape validation');
   assert.equal(pdfTextMatchesSource(rendered.text,source,rendered.fragments),true,pdf.label+': ordered semantic glyphs');
   if(item.requested_pages!==null)assert.equal(rendered.images.length,item.requested_pages,'Explicit page requirement');
   const blockPages=orderedBlockPages(spec.blocks.map(b=>glyphs(blockText(b))),rendered.pageTexts.map(glyphs));
   const splitBlocks=blockPages.flatMap((pages,i)=>pages.length!==1?[i]:[]);
   assert.deepEqual(splitBlocks,[],pdf.label+': source block continuity');
   const orphans=spec.blocks.flatMap((b,i)=>b.kind==='heading'&&i+1<spec.blocks.length&&blockPages[i][0]!==blockPages[i+1][0]?[i]:[]);
   assert.deepEqual(orphans,[],pdf.label+': heading/first-support continuity');
   const splitGroups=[];spec.blocks.forEach((b,i)=>{if(b.kind!=='heading'||b.level!==3)return;let end=i+1;while(end<spec.blocks.length&&spec.blocks[end].kind!=='heading')end++;
    if(new Set(blockPages.slice(i,end).flat()).size>1)splitGroups.push(i);});
   if(item.private)assert.deepEqual(splitGroups,[],pdf.label+': private engagement group continuity');
   const bbox=run('pdftotext',['-bbox-layout',pdf.path,'-']),geometry=[];
   for(const page of bbox.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)){
    const attr=(s,n)=>Number(s.match(new RegExp(n+'="([0-9.+-]+)"'))?.[1]);
    const width=attr(page[1],'width'),height=attr(page[1],'height');
    const words=[...page[2].matchAll(/<word\b([^>]*)>[\s\S]*?<\/word>/g)].map(m=>({x0:attr(m[1],'xMin'),x1:attr(m[1],'xMax'),y0:attr(m[1],'yMin'),y1:attr(m[1],'yMax')}));
    assert.ok(words.length&&words.every(w=>Object.values(w).every(Number.isFinite)),'Missing actual glyph geometry');
    // CSS positions are quantized to 1/64px; PDF bbox serialization adds <1e-5pt.
    // This bounds coordinate representation only, never the strict 11pt font floor.
    const coordinateQuantumPt=72/96/64+0.00001;
    const outside=words.filter(w=>w.x0<frame.left-coordinateQuantumPt||w.x1>width-frame.right+coordinateQuantumPt||w.y0<frame.top-coordinateQuantumPt||w.y1>height-frame.bottom+coordinateQuantumPt);
    assert.deepEqual(outside,[],pdf.label+': glyphs outside printable margins, including headings');
    const lines=[...page[2].matchAll(/<line\b([^>]*)>[\s\S]*?<\/line>/g)].map(m=>({x0:attr(m[1],'xMin'),x1:attr(m[1],'xMax'),y0:attr(m[1],'yMin'),y1:attr(m[1],'yMax')}));
    geometry.push({page:geometry.length+1,width_pt:width,height_pt:height,top_pt:Math.min(...words.map(w=>w.y0)),bottom_pt:Math.max(...words.map(w=>w.y1)),line_positions:lines,word_count:words.length,coordinate_quantum_pt:coordinateQuantumPt});
   }
   const images=join(target,pdf.label);mkdirSync(images,{recursive:true});rendered.images.forEach((b,i)=>writeFileSync(join(images,'page-'+(i+1)+'.png'),b));
   row.renderers[pdf.label]={pdf_sha256:sha(bytes),pages:rendered.images.length,font_measurements:rendered.fontMeasurements,
    semantic_fidelity:'PASS',heading_continuity:'PASS',split_groups:splitGroups,block_pages:blockPages,margin_check:'PASS',geometry,
    image_sha256:rendered.images.map(sha)};
  }
  const counts=Object.values(row.renderers).map(r=>r.pages);assert.equal(new Set(counts).size,1,'Cross-render page-count parity is a separate mandatory requirement');
  row.page_count_constraint=item.requested_pages===null?'NOT_REQUESTED':'PASS';row.cross_render_parity='PASS';
  row.office_line_coordinate_max_delta_pt=0;
  if(offices.length>1){const a=row.renderers[offices[0].label],b=row.renderers[offices[1].label];
   for(let p=0;p<a.geometry.length;p++){assert.equal(a.geometry[p].line_positions.length,b.geometry[p].line_positions.length,'Office line-wrap mismatch');
    a.geometry[p].line_positions.forEach((line,i)=>{for(const key of ['x0','x1','y0','y1'])row.office_line_coordinate_max_delta_pt=Math.max(row.office_line_coordinate_max_delta_pt,Math.abs(line[key]-b.geometry[p].line_positions[i][key]));});}}
  report.cases.push(row);writeFileSync(join(output,'measurements.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({name:item.name,explicit_page_constraint:row.page_count_constraint,pages:Object.fromEntries(Object.entries(row.renderers).map(([k,v])=>[k,v.pages])),
   minimum_actual_fonts:Object.fromEntries(Object.entries(row.renderers).map(([k,v])=>[k,Math.min(...v.font_measurements.map(p=>p.minimumPt))])),office_coordinate_delta_pt:row.office_line_coordinate_max_delta_pt,independent_visual_review:'PENDING'}));
 }
}finally{await browser.close();}
