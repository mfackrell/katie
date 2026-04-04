import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyFastifyWebhookHmac } from "@/lib/webhooks-fastify-hmac";

test("verifies HMAC using raw bytes instead of re-serialized JSON", () => {
  const secret = "top-secret";
  const rawJson = '{"b":2,"a":1}';
  const signature = createHmac("sha256", secret).update(Buffer.from(rawJson)).digest("hex");

  const result = verifyFastifyWebhookHmac(
    {
      headers: { "x-signature": `sha256=${signature}` },
      rawBody: Buffer.from(rawJson),
      body: { a: 1, b: 2 }
    },
    { secret }
  );

  assert.deepEqual(result, { ok: true });
});

test("fails when rawBody is unavailable", () => {
  const result = verifyFastifyWebhookHmac(
    {
      headers: { "x-signature": "sha256=abc" },
      body: { hello: "world" }
    },
    { secret: "top-secret" }
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "Missing rawBody bytes. Configure Fastify with raw body support for this route."
  });
});
