/** Only decoder results or owner-checked private cache reads enter this registry.
 * Serializable fields on browser FileReferences are never a trust boundary. */
export type VideoTiming = {
  version: 1;
  durationSeconds: number | null;
  sampleSeconds: number[];
};
type Frame = { timestampSeconds?: unknown; dataUrl?: unknown };
type Binding = { timing: VideoTiming; frames?: Frame[]; snapshots?: Array<{ frame: Frame; seconds: unknown; dataUrl: unknown }> };
const trusted = new WeakMap<object, Binding>();
const measuredFrames = new WeakMap<object, { owner: object; binding: Binding; index: number }>();
function framesOf(target: object): Frame[] | undefined {
  if (Array.isArray(target)) return target;
  const frames = (target as { videoFrames?: unknown }).videoFrames;
  return Array.isArray(frames) ? frames : undefined;
}
function clearBinding(target: object): void {
  const old = trusted.get(target);
  if (old?.snapshots) for (const { frame } of old.snapshots) {
    if (measuredFrames.get(frame)?.binding === old) measuredFrames.delete(frame);
  }
  trusted.delete(target);
}
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
  // Failed rehydration must revoke a previous valid binding, not leave stale trust.
  clearBinding(target);
  const timing = validateVideoTiming(value);
  if (!timing) return;
  const reference = target as { mimeType?: string; videoFrames?: Frame[] };
  const frames = framesOf(target);
  if ((Array.isArray(target) || reference.mimeType || reference.videoFrames !== undefined) &&
      (!frames || frames.length !== timing.sampleSeconds.length ||
       frames.some((frame, i) => !frame || typeof frame !== "object" ||
         frame.timestampSeconds !== timing.sampleSeconds[i]))) return;
  // Snapshot the exact restored objects and image values. Trust never transfers
  // through JSON or a spread; an owner-checked cache read must register its result.
  Object.freeze(timing.sampleSeconds);
  Object.freeze(timing);
  const binding: Binding = { timing, frames, snapshots: frames?.map(frame => ({
    frame, seconds: frame.timestampSeconds, dataUrl: frame.dataUrl,
  })) };
  trusted.set(target, binding);
  binding.snapshots?.forEach(({ frame }, index) => measuredFrames.set(frame, { owner: target, binding, index }));
}
export function getVideoTiming(target: object): VideoTiming | undefined {
  const binding = trusted.get(target);
  if (!binding) return;
  const current = framesOf(target);
  if (binding.frames ? current !== binding.frames || current.length !== binding.snapshots!.length ||
      binding.snapshots!.some((snapshot, i) => current[i] !== snapshot.frame ||
        current[i].timestampSeconds !== snapshot.seconds || current[i].dataUrl !== snapshot.dataUrl)
    : current !== undefined) {
    clearBinding(target);
    return;
  }
  return binding.timing;
}
/** Only true for the exact current frame objects registered by trusted server code. */
export function hasMeasuredFrameTime(frame: object): boolean {
  const entry = measuredFrames.get(frame);
  return !!entry && trusted.get(entry.owner) === entry.binding &&
    !!getVideoTiming(entry.owner) && entry.binding.snapshots?.[entry.index].frame === frame;
}
export function formatVideoTiming(timing?: VideoTiming): string {
  const t = validateVideoTiming(timing);
  return [
    "VIDEO TIMING EVIDENCE",
    t ? `Server decoder measured duration: ${t.durationSeconds === null ? "unknown" : `${t.durationSeconds}s`}. Decoded sample positions relative to source start: ${t.sampleSeconds.map(s => `${s}s`).join(", ")}.`
      : "No server-verified timing is available. Frame labels may be approximate requested seeks; do not treat them as measured positions.",
    "Measured duration and decoded frame positions take priority over model-estimated times. A sample timestamp does not establish the exact onset of an event between frames; give supported bounds or omit the event time. Preserve precise timing when independently grounded. Model-estimated event times are unverified, even if repeated by another report.",
  ].join("\n");
}
