import { z } from "zod";
import { createHash } from "node:crypto";
import { getVideoTiming } from "../uploads/video-timing";
import type { VideoFallbackFrame } from "../uploads/video-fallback-frames";

export const TIMELINE_VERSION = "visual-sampled-v1";
export const WINDOW_SECONDS = 30;
export const MAX_EVENTS = 20;
export type FrameEvidence = { id: string; seconds: number; sha256: string };
export type TimelineEvent = { description: string; frame_ids: string[]; observed_start: number; observed_end: number };
const reportSchema = z.object({
  observations: z.array(z.object({ description: z.string().trim().min(8).max(800), frame_ids: z.array(z.string().max(90)).min(1).max(10) }).strict()).min(1).max(MAX_EVENTS),
  partial: z.boolean(),
}).strict();

export function bindTimelineFrames(frames: VideoFallbackFrame[], start: number, end: number, fingerprint: string): FrameEvidence[] {
  const timing = getVideoTiming(frames);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !timing || timing.durationSeconds === null || !frames.length || frames.length > 10 ||
      !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > timing.durationSeconds ||
      timing.sampleSeconds.some((s, i, all) => s < start || s > end || (i > 0 && s <= all[i - 1])))
    throw new Error("Measured in-window frame evidence required.");
  return frames.map((frame, index) => {
    const sha256 = createHash("sha256").update(frame.dataUrl).digest("hex");
    const id = "f-" + createHash("sha256").update(`${fingerprint}:${timing.sampleSeconds[index]}:${sha256}`).digest("hex");
    return { id, seconds: timing.sampleSeconds[index], sha256 };
  });
}
export function validateObservations(text: string, frames: FrameEvidence[]) {
  if (typeof text !== "string" || text.length > 24000 || !frames.length || frames.length > 10 ||
      new Set(frames.map(f => f.id)).size !== frames.length || frames.some(f => !Number.isFinite(f.seconds) || f.seconds < 0))
    throw new Error("Invalid structured timeline report.");
  const report = reportSchema.parse(JSON.parse(text));
  const known = new Map(frames.map(f => [f.id, f.seconds]));
  const events: TimelineEvent[] = report.observations.map(observation => {
    if (/^(?:sorry|i (?:cannot|can['’]t|am unable|could not|couldn['’]t|do not have access)|unable to|as an ai|no (?:observations?|frames?|images?) (?:available|provided))\b/i.test(observation.description) ||
        new Set(observation.frame_ids).size !== observation.frame_ids.length || observation.frame_ids.some(id => !known.has(id)))
      throw new Error("Unknown/duplicate evidence frame or refusal.");
    const positions = observation.frame_ids.map(id => known.get(id)!);
    return { ...observation, observed_start: Math.min(...positions), observed_end: Math.max(...positions) };
  });
  if (new Set(events.map(e => JSON.stringify([e.description, [...e.frame_ids].sort()]))).size !== events.length) throw new Error("Duplicate event identity.");
  events.sort((a, b) => a.observed_start - b.observed_start);
  return { events, partial: report.partial };
}
export const TIMELINE_CAVEAT = "Visual sampled observations only. Times are first/last observed samples, never proven onset, continuous duration or exhaustive coverage. Every interval between samples and outside completed windows is unknown; brief events and sound may be missed. No match does not establish absence.";
