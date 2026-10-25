import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("owner authentication verifies six- or eight-digit email OTP without magic link callback",()=>{
 const src=readFileSync("components/self-tools-owner-session.tsx","utf8");
 assert.match(src,/signInWithOtp\(/);
 assert.match(src,/shouldCreateUser: false/);
 assert.match(src,/verifyOtp\(/);
 assert.match(src,/type: "email"/);
 assert.match(src,/pattern="\[0-9\]\{6\}\(\[0-9\]\{2\}\)\?"/);
 assert.match(src,/maxLength=\{8\}/);
 assert.match(src,/\^\[0-9\]\{6,8\}\$/);
 assert.match(src,/Send verification code/);
 assert.match(src,/Verify code/);
 assert.doesNotMatch(src,/emailRedirectTo:/);
});
