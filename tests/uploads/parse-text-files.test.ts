import test from "node:test";
import assert from "node:assert/strict";
import { convertToPlainText, parseTextFiles } from "../../lib/uploads/parse-text-files";

test("parseTextFiles parses text-like files", async () => {
  const parsed = await parseTextFiles([
    new File(["hello"], "a.txt", { type: "text/plain" }),
    new File([JSON.stringify({ a: 1 })], "a.json", { type: "application/json" })
  ]);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].sourceFormat, "text");
  assert.match(parsed[1].text, /"a": 1/);
});

test("convertToPlainText returns clear error for images", async () => {
  await assert.rejects(convertToPlainText(new File([new Uint8Array([1])], "a.png", { type: "image/png" })), /not convertible to plain text/);
});

test("parseTextFiles enforces max files", async () => {
  const files = Array.from({ length: 6 }, (_v, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }));
  await assert.rejects(parseTextFiles(files), /Maximum allowed is 5/);
});
