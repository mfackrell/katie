/** Only decoder results or owner-checked private cache reads enter this registry.
 * Serializable fields on browser FileReferences are never a trust boundary. */
export type VideoTiming = {
  version: 1;
  durationSeconds: number | null;
  sampleSeconds: number[];
};
const trusted = new WeakMap<object, VideoTiming>();
export function validateVideoTiming(value: unknown): VideoTiming | undefined {
  if (!value || typeof value !== "object") return;
  const t = value as VideoTiming;
  if (t.version !== 1 || !(t.durationSeconds === null ||
      (Number.isFinite(t.durationSeconds) && t.durationSeconds > 0 && t.durationSeconds <= 86400)) ||
      !Array.isArray(t.sampleSeconds) || !t.sampleSeconds.length || t.sampleSeconds.length > 10 ||
      t.sampleSeconds.some((s, i) => !Number.isFinite(s) || s < 0 || s > 86400 ||
        (t.durationSeconds !== null && s > t.durationSeconds) || (i > 0 && s < t.sampleSeconds[i - 1]))) return;
  return { version: 1, durationSeconds: t.durationSeconds, sampleSeconds: [...t.sampleSeconds] };
}
export function registerVideoTiming(target: object, value: unknown): void {
  const timing = validateVideoTiming(value);
  if (!timing) return;
  const reference = target as { mimeType?: string; videoFrames?: Array<{ timestampSeconds: number }> };
  const frames = Array.isArray(target) ? target : reference.videoFrames;
  if ((Array.isArray(target) || reference.mimeType) &&
      (!Array.isArray(frames) || frames.length !== timing.sampleSeconds.length ||
       frames.some((frame, i) => frame?.timestampSeconds !== timing.sampleSeconds[i]))) return;
  trusted.set(target, timing);
}
export function getVideoTiming(target: object): VideoTiming | undefined { return trusted.get(target); }
export function formatVideoTiming(timing?: VideoTiming): string {
  const t = validateVideoTiming(timing);
  return [
    "VIDEO TIMING EVIDENCE",
    t ? `Server decoder measured duration: ${t.durationSeconds === null ? "unknown" : `${t.durationSeconds}s`}. Decoded sample positions relative to source start: ${t.sampleSeconds.map(s => `${s}s`).join(", ")}.`
      : "No server-verified timing is available. Frame labels may be approximate requested seeks; do not treat them as measured positions.",
    "Measured duration and decoded frame positions take priority over model-estimated times. A sample timestamp does not establish the exact onset of an event between frames; give supported bounds or omit the event time. Preserve precise timing when independently grounded. Model-estimated event times are unverified, even if repeated by another report.",
  ].join("\n");
}
