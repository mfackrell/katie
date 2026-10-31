import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reportedFocalSubject,visualReportsAgree,reconcileImageReports,
  isPolicyLimitedVisionResponse,neutralFactsFromPolicyLimitedReply,
  type ImageModelReport
} from '../lib/uploads/image-evidence-reconciliation';

const hash='a'.repeat(64);
const qwen=(text:string):ImageModelReport=>({model:'runpod:Qwen/Qwen3-VL-8B-Instruct',sourceHash:hash,text,coverage:'full',disposition:'observation'});
const venice=(text:string):ImageModelReport=>({model:'venice:venice-uncensored-1-2',sourceHash:hash,text,coverage:'full',disposition:'observation'});

test('principal subject extraction prefers explicitly identified focal point and understands short unlabelled observations',()=>{
  assert.equal(reportedFocalSubject('Primary focal point: A blue ceramic cup occupies the center.'),'cup');
  assert.equal(reportedFocalSubject('A cup on a table.'),'cup');
  assert.equal(reportedFocalSubject('The image shows a person’s erect penis, which is the primary focal point.'),'penis');
  assert.equal(reportedFocalSubject('The image does not contain any text, logos, or discernible writing. The image shows a close-up view of a hand holding a dog.'),'hand');
  assert.equal(reportedFocalSubject('The image contains no recognizable text. The image clearly shows a brown dog sitting on grass.'),'dog');
  assert.equal(reportedFocalSubject('The image shows a hand holding a black camera in a car.'),'hand');
  assert.equal(reportedFocalSubject('The image has an uncertain object.'),null);
  assert.equal(reportedFocalSubject('Small text is illegible.'),null);
});
test('subject agreement checks the reported subject, not shared colors or background',()=>{
  assert.equal(visualReportsAgree('The image shows a brown dog near a red fence.','Primary focal point: A red car near the fence.'),false);
  assert.equal(visualReportsAgree('A mug on a wooden table.','Primary focal point: A glossy blue cup with a curved handle.'),true);
  assert.equal(visualReportsAgree('The photograph is too blurry to identify its subject.','The image shows a cat.'),null);
});
test('real Qwen-identifies-anatomy vs Dolphin-invents-a-hand case excludes the hallucination',()=>{
  const primary=qwen('The image shows a person’s erect penis, which is the primary focal point.');
  const secondary=venice('The primary focal point of the image is a hand holding a camera inside a car, with a plaid sleeve.');
  const merged=reconcileImageReports(primary,secondary);
  assert.equal(merged.agreement,'conflict');
  assert.equal(merged.model,primary.model);
  assert.match(merged.text,/penis/);
  assert.doesNotMatch(merged.text,/camera|plaid|car/);
  assert.match(merged.limitations.join(' '),/EXCLUDED/);
});
test('same-subject observations combine conservatively with qualifications, without claiming pixel verification',()=>{
  const merged=reconcileImageReports(qwen('A cup on a table.'),venice('Primary focal point: A small blue ceramic mug occupies the center, with a curved handle.'));
  assert.equal(merged.agreement,'corroborated');
  assert.match(merged.text,/A cup on a table/);
  assert.match(merged.text,/curved handle/);
  assert.match(merged.model,/Qwen.*venice/i);
  assert.match(merged.limitations.join(' '),/unverified/);
});
test('unknown primary subject is not falsely called agreement',()=>{
  const merged=reconcileImageReports(qwen('The fine text is illegible.'),venice('The image shows a brown cat sleeping near a plant.'));
  assert.equal(merged.agreement,'unverified');
  assert.match(merged.text,/brown cat/);
  assert.match(merged.limitations.join(' '),/only source/);
});
test('different source hashes can never be reconciled even when the model descriptions match',()=>{
  assert.throws(()=>reconcileImageReports(qwen('The image shows a dog.'),{...venice('The image shows a dog.'),sourceHash:'b'.repeat(64)}),/Different source image identities/);
});
test('a policy-limited Qwen response yields neutral observed facts, not the refusal or adult scene invention',()=>{
  const response='I cannot fulfill this request. The image you provided shows a person’s erect penis, which is the primary focal point. The description you requested is not appropriate for this platform. I cannot generate or describe sexually explicit content.';
  assert.equal(isPolicyLimitedVisionResponse(response),true);
  assert.equal(neutralFactsFromPolicyLimitedReply(response),'The image you provided shows a person’s erect penis, which is the primary focal point.');
  assert.equal(neutralFactsFromPolicyLimitedReply('I cannot fulfill this request. My guidelines forbid this.'),null);
  assert.equal(isPolicyLimitedVisionResponse('The image shows a brown dog on a rug.'),false);
});
