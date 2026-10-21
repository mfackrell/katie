import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shouldFallbackIncompleteReview} from '../lib/missions/review-fallback.mjs';

test('an incomplete independent review can use the next routed model',()=>{
  const error={name:'MissionModelFailure',partial:{responseStatus:'incomplete',incompleteReason:null}};
  assert.equal(shouldFallbackIncompleteReview('review',error),true);
  assert.equal(shouldFallbackIncompleteReview('compose',error),false);
  assert.equal(shouldFallbackIncompleteReview('plan',error),false);
});

test('output limits, invalid errors, and completed responses never trigger fallback',()=>{
  const failure={name:'MissionModelFailure',partial:{responseStatus:'incomplete',incompleteReason:'max_output_tokens'}};
  assert.equal(shouldFallbackIncompleteReview('review',failure),false);
  assert.equal(shouldFallbackIncompleteReview('review',new Error('network')),false);
  assert.equal(shouldFallbackIncompleteReview('review',{name:'MissionModelFailure',partial:{responseStatus:'completed'}}),false);
});
