import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubWebhookSignature } from '../../apps/api/src/security';

describe('webhook signature', () => {
  it('matches github hmac sha256', () => {
    const secret = 'secret';
    const body = JSON.stringify({ hello: 'world' });
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyGithubWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyGithubWebhookSignature(body, sig, 'wrong')).toBe(false);
  });
});
