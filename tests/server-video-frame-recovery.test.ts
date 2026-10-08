import test from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { extractFramesFromPrivateVideo } from "../lib/uploads/server-video-frame-recovery";

const jpeg = "data:image/jpeg;base64," +
  Buffer.from([0xff, 0xd8, 0, 1, 2, 3, 0xff, 0xd9]).toString("base64");

test("server recovery decodes a saved private video through an isolated Chromium page", async () => {
  let closed = 0;
  let videoBytes = "";
  let interceptedRequests = 0;
  const browser = {
    newPage: async () => ({
      route: async (_pattern: string, _callback: unknown) => { interceptedRequests++; },
      setContent: async (html: string) => { assert.match(html, /html/); },
      evaluate: async (_callback: unknown, mediaDataUrl: string) => {
        assert.ok(mediaDataUrl.startsWith("data:video/mp4;base64,"));
        videoBytes = Buffer.from(mediaDataUrl.slice("data:video/mp4;base64,".length), "base64").toString();
        return [{ timestampSeconds: 0.8, dataUrl: jpeg }];
      }
    }),
    close: async () => { closed++; }
  } as unknown as Browser;

  const frames = await extractFramesFromPrivateVideo(new Blob(["original-video"], { type: "video/mp4" }),
    { launch: async () => browser });
  assert.equal(videoBytes, "original-video", "the decoder receives private original bytes, not Google metadata");
  assert.deepEqual(frames, [{ timestampSeconds: 0.8, dataUrl: jpeg }]);
  assert.equal(interceptedRequests, 1, "all external browser requests blocked");
  assert.equal(closed, 1, "headless browser closed after extraction");
});

test("server recovery refuses empty source and invalid pixels instead of fabricating visual evidence", async () => {
  await assert.rejects(extractFramesFromPrivateVideo(new Blob([]), {
    launch: async () => { throw new Error("Browser must not start"); }
  }), /supports retained files/);
  let closed = 0;
  const browser = {
    newPage: async () => ({
      route: async () => {},
      setContent: async () => {},
      evaluate: async () => [{ timestampSeconds: 0.2, dataUrl: "data:image/jpeg;base64," + Buffer.from("fake").toString("base64") }]
    }),
    close: async () => { closed++; },
  } as unknown as Browser;
  await assert.rejects(extractFramesFromPrivateVideo(new Blob(["recording"], { type: "video/mp4" }),
    { launch: async () => browser }), /Invalid JPEG video preview/);
  assert.equal(closed, 1);
});
