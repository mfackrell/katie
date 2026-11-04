import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve('test-artifacts/documents/phase1');
const output = join(root, 'office');
mkdirSync(output, {recursive:true});
const profile = mkdtempSync(join(tmpdir(),'katie-phase1-office-'));
function exec(cmd,args) {
  return execFileSync(cmd,args,{encoding:'utf8',timeout:90000,maxBuffer:10*1024*1024});
}
function bbox(pdf) {
  const xml = exec('pdftotext',['-bbox',pdf,'-']);
  const pages = [];
  for (const m of xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)) {
    const attrs = m[1], body=m[2], get=n=>Number((new RegExp(n+'="([0-9.]+)"').exec(attrs)||[])[1]);
    const words = [...body.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)].map(w=>{
      const attr=w[1], v=n=>Number((new RegExp(n+'="([0-9.]+)"').exec(attr)||[])[1]);
      return {x0:v('xMin'),y0:v('yMin'),x1:v('xMax'),y1:v('yMax')};
    });
    const top=words.length?Math.min(...words.map(w=>w.y0)):null;
    const bottom=words.length?Math.max(...words.map(w=>w.y1)):null;
    const height=get('height'),width=get('width');
    pages.push({page:pages.length+1,width_pt:width,height_pt:height,word_count:words.length,
      first_top_pt:top,last_bottom_pt:bottom,
      vertical_ink_span_pt:top===null?0:Number((bottom-top).toFixed(2)),
      physical_page_text_span_fraction:top===null?0:Number(((bottom-top)/height).toFixed(3)),
      bottom_blank_space_pt:bottom===null?height:Number((height-bottom).toFixed(2))});
  }
  if(!pages.length)throw Error('No text geometry from '+pdf);
  return pages;
}
const report={phase:'1', measuredBy:'LibreOffice and poppler word bounding boxes',items:[],pendingVisualQuality:true};
let differences=0;
try {
  for (const name of ['executive-resume','financial-report','business-agreement','forced-sections']) {
    const input=join(root,name+'.docx');
    if(!existsSync(input))throw Error('Missing real generator artifact '+input);
    const original=JSON.parse(readFileSync(join(root,name+'.json'),'utf8'));
    exec('soffice',['-env:UserInstallation=file://'+profile,'--headless','--convert-to','pdf','--outdir',output,input]);
    const officePdf=join(output,name+'.pdf');
    const office=bbox(officePdf);
    const chromium=bbox(join(root,name+'.pdf'));
    const firstPdf=join(root,name+'-initial.pdf');
    const initialChromium=existsSync(firstPdf)?bbox(firstPdf):null;
    const initialWordFile=join(root,name+'-initial.docx');
    let initialOffice=null;
    if(existsSync(initialWordFile)){
      exec('soffice',['-env:UserInstallation=file://'+profile,'--headless','--convert-to','pdf','--outdir',output,initialWordFile]);
      initialOffice=bbox(join(output,name+'-initial.pdf'));
    }
    const initialMeasuredPx=original.measured_total_block_heights_px ?? null;
    const initialInkSpanPx=initialChromium
      ? Number((initialChromium.reduce((n,p)=>n+p.vertical_ink_span_pt,0)*96/72).toFixed(3))
      : null;
    const parity=office.length===chromium.length;
    const headings=(name==='forced-sections'?[]:
      readFileSync('fixtures/documents/phase1-'+name+'.md','utf8')
        .split(/\r?\n/).filter(line=>/^#{1,3}\s/.test(line)).map(line=>line.replace(/^#{1,3}\s/,'').trim()));
    const shortPageEvidence=office.slice(0,-1).filter(page=>page.physical_page_text_span_fraction < 0.55)
      .map(page=>({page:page.page, span_fraction:page.physical_page_text_span_fraction,
        reason:'Requires alternative layout and semantic evidence before calling avoidable break'}));
    // Compare headings to the text on each rendered page, not internal calculated block positions.
    const orphans=[];
    const pageText=office.map(page=>exec('pdftotext',['-f',String(page.page),'-l',String(page.page),'-layout',officePdf,'-']));
    const normalize=v=>v.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
    for(const heading of headings){
      const h=normalize(heading);
      for(let i=0;i<pageText.length-1;i++){
        const lines=pageText[i].split(/\r?\n/).map(normalize).filter(Boolean);
        if(lines.length && lines.at(-1).includes(h))
          orphans.push({heading,page:i+1,nextPage:i+2,method:'heading is last visible line on page'});
      }
    }
    const item={name,office_pages:office.length,browser_pages:chromium.length,word_pdf_page_parity:parity,
      office_geometry:office,browser_geometry:chromium,
      initial_chromium_geometry:initialChromium,initial_office_geometry:initialOffice,
      initial_measured_DOM_block_sum_px:initialMeasuredPx,
      initial_pdf_ink_extent_sum_px:initialInkSpanPx,
      // This difference is descriptive, not a block-height calibration:
      // glyph ink bounds exclude margins and leading included in DOM blocks.
      initial_DOM_minus_PDF_ink_px:initialMeasuredPx===null||initialInkSpanPx===null?
        null:Number((initialMeasuredPx-initialInkSpanPx).toFixed(3)),
      initial_estimated_min_pages:original.estimated_min_pages ?? null,
      initial_actual_browser_page_count:original.initial_pdf_pages ?? null,
      short_page_signals_not_automatic_defects:shortPageEvidence,
      orphan_heading_signals:orphans,mechanical_source:original,
      pending_independent_visual_design_approval:true,
      microsoft_word_parity:'NOT TESTED'};
    for(let i=1;i<=office.length;i++)
      exec('pdftoppm',['-f',String(i),'-l',String(i),'-singlefile','-scale-to','1400','-png',officePdf,join(output,name+'-page-'+i)]);
    report.items.push(item);
    if(!parity)differences++;
  }
  writeFileSync(join(root,'phase1-cross-render-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({documents:report.items.map(x=>({name:x.name,word:x.office_pages,browser:x.browser_pages,
    orphans:x.orphan_heading_signals.length,short_pages:x.short_page_signals_not_automatic_defects.length})),differences,pendingVisualQuality:true},null,2));
  if(differences) throw Error('Phase1 renderer parity discrepancies: '+differences+
    ' (documented in phase1-cross-render-report.json)');
} finally {rmSync(profile,{recursive:true,force:true});}
