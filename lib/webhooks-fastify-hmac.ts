import { createHmac, timingSafeEqual } from "node:crypto";

type HeaderValue = string | string[] | undefined;

export type FastifyWebhookRequestLike = {
  headers: Record<string, HeaderValue>;
  rawBody?: Buffer | string;
  body?: unknown;
};

function normalizeSignature(value: string): string {
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

function getHeaderValue(headers: Record<string, HeaderValue>, name: string): string | null {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (!match) {
    return null;
  }

  return Array.isArray(match) ? match[0] ?? null : match;
}

function getRawBodyBytes(request: FastifyWebhookRequestLike): Buffer | null {
  if (Buffer.isBuffer(request.rawBody)) {
    return request.rawBody;
  }

  if (typeof request.rawBody === "string") {
    return Buffer.from(request.rawBody);
  }

  return null;
}

export function verifyFastifyWebhookHmac(
  request: FastifyWebhookRequestLike,
  options: {
    secret: string;
    signatureHeader?: string;
    algorithm?: "sha1" | "sha256" | "sha512";
  }
): { ok: true } | { ok: false; reason: string } {
  const signatureHeader = options.signatureHeader ?? "x-signature";
  const algorithm = options.algorithm ?? "sha256";

  const providedSignature = getHeaderValue(request.headers, signatureHeader);
  if (!providedSignature) {
    return { ok: false, reason: `Missing ${signatureHeader} header` };
  }

  const rawBody = getRawBodyBytes(request);
  if (!rawBody) {
    return {
      ok: false,
      reason: "Missing rawBody bytes. Configure Fastify with raw body support for this route."
    };
  }

  const expectedDigest = createHmac(algorithm, options.secret).update(rawBody).digest("hex");
  const providedDigest = normalizeSignature(providedSignature);

  const expectedBuffer = Buffer.from(expectedDigest);
  const providedBuffer = Buffer.from(providedDigest);

  if (expectedBuffer.length !== providedBuffer.length) {
    return { ok: false, reason: "Invalid signature" };
  }

  const isValid = timingSafeEqual(expectedBuffer, providedBuffer);
  return isValid ? { ok: true } : { ok: false, reason: "Invalid signature" };
}
