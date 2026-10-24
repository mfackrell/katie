import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
test("owner OTP uses canonical Katie domain and reports SMTP throttling",()=>{
 const src=readFileSync("components/self-tools-owner-session.tsx","utf8");
 assert.match(src,/https:\/\/katie-mu\.vercel\.app/);
 assert.match(src,/emailRedirectTo: canonicalOrigin/);
 assert.match(src,/error\.status === 429/);
 assert.match(src,/over_email_send_rate_limit/);
 assert.doesNotMatch(src,/emailRedirectTo: window\.location\.origin/);
});
