import crypto from 'crypto';

export const verifyGithubWebhookSignature = (payload: string, signature: string, secret: string): boolean => {
  const digest = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
};
