import test from 'node:test';
import assert from 'node:assert/strict';

import { computeGithubSignature, verifyGithubWebhookSignature } from '../../apps/api/src/security';

const secret = 'super-secret';

test('valid signature passes', () => {
  const payload = '{"zen":"Keep it logically awesome."}';
  const signature = computeGithubSignature(payload, secret);

  assert.equal(
    verifyGithubWebhookSignature({ rawPayload: payload, signatureHeader: signature, secret }),
    true,
  );
});

test('modified whitespace or key order fails', () => {
  const payload = '{"a":1,"b":2}';
  const signature = computeGithubSignature(payload, secret);
  const modifiedPayload = '{"b":2, "a":1}';

  assert.equal(
    verifyGithubWebhookSignature({
      rawPayload: modifiedPayload,
      signatureHeader: signature,
      secret,
    }),
    false,
  );
});

test('wrong secret fails', () => {
  const payload = Buffer.from('{"action":"opened"}', 'utf8');
  const signature = computeGithubSignature(payload, secret);

  assert.equal(
    verifyGithubWebhookSignature({
      rawPayload: payload,
      signatureHeader: signature,
      secret: 'not-the-secret',
    }),
    false,
  );
});
