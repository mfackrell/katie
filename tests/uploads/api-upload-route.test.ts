import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/upload/route";
import { __setUploadDepsForTests } from "../../lib/uploads/build-file-references";
import { __setPowerPointParserDepsForTests } from "../../lib/uploads/parsers/powerpoint";

__setUploadDepsForTests({ uploadToOpenAi: async () => undefined, uploadToGoogle: async () => undefined });
__setPowerPointParserDepsForTests({
  extractSlideXmlFiles: async () => ["<a:t>Slide text</a:t>"]
});

test("/api/upload returns fileReferences for common business files", async () => {
  const form = new FormData();
  form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));
  form.append("files", new File(["<html><body>Hello</body></html>"], "page.html", { type: "text/html" }));
  form.append("files", new File(["email"], "mail.eml", { type: "message/rfc822" }));
  form.append("files", new File([new Uint8Array([1])], "deck.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));

  const req = {
    headers: new Headers({ "content-type": "multipart/form-data; boundary=test" }),
    formData: async () => form
  };
  const response = await POST(req as never);
  assert.equal(response.status, 200);

  const json = (await response.json()) as { fileReferences: Array<{ fileName: string }> };
  assert.equal(Array.isArray(json.fileReferences), true);
  assert.equal(json.fileReferences.length, 4);
});
