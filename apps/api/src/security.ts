import { createHmac, timingSafeEqual } from 'node:crypto';

export type RawPayload = string | Buffer | Uint8Array;

function toBuffer(payload: RawPayload): Buffer {
  if (typeof payload === 'string') {
    return Buffer.from(payload, 'utf8');
  }

  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  return Buffer.from(payload);
}

export function computeGithubSignature(rawPayload: RawPayload, secret: string): string {
  const digest = createHmac('sha256', secret).update(toBuffer(rawPayload)).digest('hex');
  return `sha256=${digest}`;
}

export function verifyGithubWebhookSignature(params: {
  rawPayload: RawPayload;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  const { rawPayload, signatureHeader, secret } = params;

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = Buffer.from(computeGithubSignature(rawPayload, secret), 'utf8');
  const actual = Buffer.from(signatureHeader, 'utf8');

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
