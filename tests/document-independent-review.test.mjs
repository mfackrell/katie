import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';

const recordPath='fixtures/documents/phase2-acceptance-evidence.json';
function fixture(change){
  const root=mkdtempSync(join(tmpdir(),'katie-independent-review-'));
  try{
    const evidence=JSON.parse(readFileSync(recordPath,'utf8'));
    const measured=JSON.parse(readFileSync(evidence.mechanical_evidence_file,'utf8'));
    const files=['scripts/document-phase2-release-gate.mjs','fixtures/documents/phase1-acceptance-contract.json',recordPath,evidence.mechanical_evidence_file,
      evidence.independent_review_record.path,evidence.independent_review_record.report_path,...Object.keys(measured.engine_files)];
    for(const file of files){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),readFileSync(file));}
    change?.(root,evidence,measured);
    return spawnSync(process.execPath,['scripts/document-phase2-release-gate.mjs'],{cwd:root,encoding:'utf8',timeout:10000});
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('artifact-bound separate AI visual review closes all eleven gates without authorizing release',()=>{
  const result=fixture();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/All eleven acceptance gates PASS/);
  assert.equal(JSON.parse(readFileSync(recordPath,'utf8')).release_allowed,false);
});
test('missing independent review cannot be replaced by a passing status',()=>{
  const result=fixture((root,e)=>{delete e.independent_review_record;writeFileSync(join(root,recordPath),JSON.stringify(e));});
  assert.notEqual(result.status,0);assert.match(result.stderr,/requires an independent review record/);
});
test('altered reviewer bytes invalidate approval even when verdict remains PASS',()=>{
  const result=fixture((root,e)=>{const path=join(root,e.independent_review_record.path);writeFileSync(path,readFileSync(path,'utf8')+' ');});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Independent review record changed/);
});
test('mechanical raster evidence cannot drift away from independently reviewed images',()=>{
  const result=fixture((root,e,m)=>{m.cases.find(x=>x.name==='private-resume').renderers.chromium.image_sha256[0]='0'.repeat(64);writeFileSync(join(root,e.mechanical_evidence_file),JSON.stringify(m));});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Unreviewed page images/);
});
test('changed engine source invalidates carried-forward review and mechanical evidence',()=>{
  const result=fixture(root=>{const path=join(root,'lib/documents/generate.ts');writeFileSync(path,readFileSync(path,'utf8')+'\n');});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Stale mechanical acceptance/);
});
