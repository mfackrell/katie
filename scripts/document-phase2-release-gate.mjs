import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const contract=JSON.parse(readFileSync('fixtures/documents/phase1-acceptance-contract.json','utf8'));
const evidence=JSON.parse(readFileSync('fixtures/documents/phase2-acceptance-evidence.json','utf8'));
// Mechanical attestations are invalidated by any engine or dependency change.
if(evidence.mechanical_evidence_file){
  const measured=JSON.parse(readFileSync(evidence.mechanical_evidence_file,'utf8'));
  for(const [path,expected] of Object.entries(measured.engine_files)){
    const actual=createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(actual,expected,'Stale mechanical acceptance: '+path);
  }
}
const required=new Set(contract.rules.map(x=>x.id));
assert.equal(required.size,11,'Phase 1 contract unexpectedly changed');
assert.equal(evidence.acceptance.length,11,'All 11 Phase 2 gates must be reported');
for(const row of evidence.acceptance){
  assert.ok(required.delete(row.id),'Unknown or duplicate acceptance rule '+row.id);
  assert.ok(row.evidence && row.status,'Every gate must include evidence and status');
}
assert.equal(required.size,0,'Missing acceptance contract clauses');
// Accept the separate owner-supplied AI review only for the exact measured pages.
// Hashes establish integrity, not a digital signature or human credentials.
if(evidence.acceptance.find(row=>row.id==='PAGE_COMPOSITION')?.status==='passed'){
  const binding=evidence.independent_review_record;
  assert.ok(binding,'PAGE_COMPOSITION requires an independent review record');
  assert.equal(binding.accepted_review_type,'independent_ai_visual');
  const bytes=readFileSync(binding.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),binding.sha256,'Independent review record changed');
  assert.equal(createHash('sha256').update(readFileSync(binding.report_path)).digest('hex'),binding.report_sha256,'Independent review report changed');
  const review=JSON.parse(bytes.toString('utf8'));
  assert.equal(review.candidate_sha,binding.reviewed_candidate_sha,'Wrong reviewed candidate');
  assert.equal(review.page_composition_verdict,'PASS');
  assert.equal(review.release_authorized,false,'Visual review is not release authorization');
  assert.equal(evidence.release_allowed,false,'Owner release authorization remains separate');
  assert.equal(binding.cryptographic_signature,false);
  assert.equal(binding.human_professional_review,false);
  assert.ok(Object.values(review.criteria).length>=10);
  for(const verdict of Object.values(review.criteria))assert.equal(verdict,'PASS');
  const measured=JSON.parse(readFileSync(evidence.mechanical_evidence_file,'utf8'));
  let pages=0;
  for(const document of ['private_resume','financial_report','business_agreement']){
    const acceptance=review.document_assessments.find(item=>item.document===document);
    assert.equal(acceptance?.verdict,'PASS','Missing independent document acceptance');
    const actual=measured.cases.find(item=>item.name===document.replaceAll('_','-'));
    assert.ok(actual,'Missing measured document');
    for(const [renderer,measuredKey] of [['chromium','chromium'],['libreoffice_24','lo24'],['libreoffice_26','lo26']]){
      const hashes=review.evidence.reviewed_page_image_sha256[document][renderer];
      assert.deepEqual(hashes,actual.renderers[measuredKey].image_sha256,'Unreviewed page images: '+document+'/'+renderer);
      assert.equal(hashes.length,acceptance.pages_by_renderer[renderer]);
      pages+=hashes.length;
    }
  }
  assert.equal(pages,12,'Independent review must cover all twelve final pages');
}
const blocked=evidence.acceptance.filter(x=>x.status!=='passed');
console.log('Phase 2 acceptance matrix:',JSON.stringify(evidence.acceptance));
if(blocked.length) {
  console.error('PHASE 2 FAIL: '+blocked.length+' mandatory gates are unverified: '+
    blocked.map(x=>x.id+' ('+x.status+')').join(', '));
  process.exitCode=1;
}else console.log('All eleven acceptance gates PASS with independent AI review; owner release authorization remains required.');
