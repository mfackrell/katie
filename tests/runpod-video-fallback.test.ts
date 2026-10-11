import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeSavedVideosWithQwen } from "../lib/chat/runpod-video-fallback";
import { runWithRefusalFallback } from "../lib/router/refusal-detection";
import { buildRunpodVideoScenePrompt, buildGrokVideoScenePrompt, GROK_SCENE_RESPONSE_PERSONA } from "../lib/chat/video-scene-prompts";

const saved = [{ chatId: "b7527887-cab2-4cc7-aa97-5dd947c3546c",
  attachmentId: "62b54efa-eecd-4d31-bf46-ac364655ee73", fileName: "clip.mp4" }];
const receipt = { id: "result-row", jobId: "qwen-test-job", status: "queued" };
const completed = { id: receipt.jobId, status: "COMPLETED", delayTime: 900, executionTime: 2400,
  output: { model: "Qwen/Qwen3-VL-8B-Instruct",
    choices: [{ message: { role: "assistant", content: "The video shows the scene changing." } }],
    usage: { prompt_tokens: 130, completion_tokens: 10, total_tokens: 140 } } };

test("Qwen analyzes original saved video, persists the result and returns actual model output", async () => {
  const calls: string[] = [];
  const result = await analyzeSavedVideosWithQwen(saved, "Describe the video", {
    submit: async values => {
      assert.equal(values.chatId, saved[0].chatId);
      assert.equal(values.attachmentPath, `chats/${saved[0].chatId}/${saved[0].attachmentId}.source`);
      assert.equal(values.question, "Describe the video");
      calls.push("submit");
      return receipt;
    },
    status: async id => { assert.equal(id, receipt.jobId); calls.push("status"); return completed; },
    persist: async row => { assert.equal(row.id, receipt.id); calls.push("persist"); },
  });
  assert.equal(result.text, "The video shows the scene changing.");
  assert.equal(result.model, "Qwen/Qwen3-VL-8B-Instruct");
  assert.equal(result.queueMs, 900);
  assert.equal(result.inferenceMs, 2400);
  assert.deepEqual(calls, ["submit", "status", "persist"]);
});

test("Gemini succeeds without invoking Qwen or Grok", async () => {
  const attempts: string[] = [];
  const run = await runWithRefusalFallback({
    attempts: ["gemini", "qwen", "grok"],
    runAttempt: async a => { attempts.push(a); return { provider: "google" as const, model: "gemini", text: "Gemini analyzed the video." }; },
    detectRefusal: () => false, shouldRetryRefusal: true,
  });
  assert.equal(run.attempt, "gemini");
  assert.deepEqual(attempts, ["gemini"]);
});

test("Gemini fails, Qwen succeeds, Grok is not invoked", async () => {
  const attempts: string[] = [];
  const run = await runWithRefusalFallback({
    attempts: ["gemini", "qwen", "grok"],
    runAttempt: async a => {
      attempts.push(a);
      if (a === "gemini") throw new Error("Gemini failed");
      if (a === "qwen") {
        const analysis = await analyzeSavedVideosWithQwen(saved, "Describe", {
          submit: async () => receipt, status: async () => completed,
          persist: async () => undefined,
        });
        return { provider: "google" as const, model: analysis.model, text: analysis.text };
      }
      return { provider: "grok" as const, model: "grok-4.7", text: "Frames described." };
    },
    detectRefusal: () => false, shouldRetryRefusal: true,
    retryTerminalError: ({ remainingAttempts }) => remainingAttempts.length > 0,
  });
  assert.equal(run.attempt, "qwen");
  assert.deepEqual(attempts, ["gemini", "qwen"]);
});

test("Gemini and Qwen fail, then Grok receives the video", async () => {
  const attempts: string[] = [];
  const run = await runWithRefusalFallback({
    attempts: ["gemini", "qwen", "grok"],
    runAttempt: async a => {
      attempts.push(a);
      if (a === "gemini") throw new Error("Gemini stopped");
      if (a === "qwen") {
        await analyzeSavedVideosWithQwen(saved, "Describe", {
          submit: async () => receipt,
          status: async () => ({ id: receipt.jobId, status: "FAILED", error: "worker unavailable" }),
          persist: async () => undefined,
        });
      }
      return { provider: "grok" as const, model: "grok-4.7", text: "I inspected frames." };
    },
    detectRefusal: () => false, shouldRetryRefusal: true,
    retryTerminalError: ({ remainingAttempts }) => remainingAttempts.length > 0,
  });
  assert.equal(run.attempt, "grok");
  assert.deepEqual(attempts, ["gemini", "qwen", "grok"]);
});

test("Qwen timeout fails open to Grok without repeated infinite polling", async () => {
  let time = 0;
  let polls = 0;
  await assert.rejects(analyzeSavedVideosWithQwen(saved, "Describe", {
    submit: async () => receipt,
    status: async () => { polls++; return { id: receipt.jobId, status: "IN_QUEUE" }; },
    persist: async () => undefined,
    now: () => time,
    sleep: async ms => { time += ms; },
    timeoutMs: 10_000,
  }), /timed out/);
  assert.equal(polls, 3);
});

test("Qwen rejects a mismatched result identity", async () => {
  await assert.rejects(analyzeSavedVideosWithQwen(saved, "Describe", {
    submit: async () => receipt,
    status: async () => ({ ...completed, id: "another-job" }),
    persist: async () => undefined,
  }), /did not match/);
});

test("RunPod instructions focus on what occurs inside a screen-recorded video", () => {
  const prompt = buildRunpodVideoScenePrompt("Like this?");
  assert.match(prompt, /Like this\?/);
  assert.match(prompt, /underlying video/i);
  assert.match(prompt, /visibly doing/i);
  assert.match(prompt, /interact/i);
  assert.match(prompt, /website names/i);
  assert.match(prompt, /watermarks/i);
  assert.match(prompt, /progress bars/i);
  assert.match(prompt, /vague/i);
  assert.match(prompt, /beginning/i);
  assert.match(prompt, /FINAL portion/i);
  assert.match(prompt, /last seconds/i);
  assert.match(prompt, /transition/i);
  assert.match(prompt, /ending is not visible/i);
  assert.doesNotMatch(prompt, /anysex\.com/i);
});

test("Grok receives preliminary RunPod observations but must answer about actual scene", () => {
  const prompt = buildGrokVideoScenePrompt("Like this?", "Screen recording of a site with two people shown.");
  assert.match(prompt, /Like this\?/);
  assert.match(prompt, /COMPLETE VERBATIM RUNPOD DESCRIPTION \(UNVERIFIED OBSERVATIONS/);
  assert.match(prompt, /Screen recording of a site/);
  assert.match(prompt, /actually happening in the scene/i);
  assert.match(prompt, /time remaining/i);
  assert.match(GROK_SCENE_RESPONSE_PERSONA, /Start with the content itself/i);
  assert.match(GROK_SCENE_RESPONSE_PERSONA, /independently check/i);
  assert.match(GROK_SCENE_RESPONSE_PERSONA, /latest-timestamp/i);
  assert.match(prompt, /last timestamped frames/i);
  assert.match(GROK_SCENE_RESPONSE_PERSONA, /not 'Yes'/i);
  assert.match(buildGrokVideoScenePrompt("", null), /analyze the provided frames directly/i);
});

test("RunPod and Grok production code use the scene-focused prompt builders", () => {
  const runpodSource = readFileSync("lib/runpod/durable-results.ts", "utf8");
  const grokSource = readFileSync("lib/runpod/video-orchestration.ts", "utf8");
  assert.match(runpodSource, /text: buildRunpodVideoScenePrompt\(params\.question\)/);
  assert.match(grokSource, /persona: GROK_SCENE_RESPONSE_PERSONA/);
  assert.match(grokSource, /const grokPrompt = buildGrokVideoScenePrompt\(row\.request_prompt \|\| "", preliminary\)/);
  assert.match(grokSource, /user: grokPrompt/);
  assert.match(grokSource, /const preliminary = usableVideoAnalysis\(row\.analysis_text\)/);
  assert.doesNotMatch(grokSource, /text \+= .*Analysis used recovered video frames/);
});

test("Grok receives every character of long RunPod output, including late details", () => {
  const sentinel = "UNIQUE_FINAL_SCENE_AT_23800_CHARS";
  const complete = "The scene begins in a workshop. " + "Specific visual observation. ".repeat(850) + sentinel;
  assert.ok(complete.length > 16000);
  const prompt = buildGrokVideoScenePrompt("What changes near the end?", complete);
  assert.ok(prompt.includes(complete), "full RunPod text must be present verbatim, not summarized or cropped");
  assert.ok(prompt.includes(sentinel), "late details must survive the handoff to Grok");
  assert.match(prompt, /Read the COMPLETE verbatim RunPod description/i);
  assert.match(GROK_SCENE_RESPONSE_PERSONA, /not replace/i);
  assert.doesNotMatch(readFileSync("lib/chat/video-scene-prompts.ts", "utf8"), /preliminary\\.trim\\(\\)\\.slice/);
});
