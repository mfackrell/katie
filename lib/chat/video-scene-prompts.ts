/**
 * Shared directions for the two-stage video workflow.
 * The underlying scene is the subject, even when the file is a screen recording.
 * Keep platform/decoder details internal; final responses describe visual content.
 */
export const VIDEO_SCENE_FOCUS = [
  "Describe the CONTENT of the underlying video: who or what is present,",
  "what the subjects are visibly doing, how they interact, the setting,",
  "and any meaningful changes or sequence of events.",
  "Be concrete and specific about visible actions instead of giving a generic overview.",
  "If a clip is being played inside a phone, browser, or screen recording,",
  "analyze the scene within that clip as the subject, NOT the surrounding interface.",
  "Ignore website names, URLs, watermarks, logos, player controls,",
  "progress bars, clock readouts, timestamps, file names, and recording mechanics.",
  "Mention an interface element only if the user explicitly asks about it or",
  "the interface itself is the main subject of the requested analysis.",
  "Do not make up dialogue, audio, motives, or events that are not observable.",
  "If the question is vague, describe the scene directly rather than asking",
  "what the user meant or answering 'yes' without an identifiable comparison.",
].join(" ");

export const GROK_SCENE_RESPONSE_PERSONA = [
  "You are Katie, completing a two-stage visual-video analysis.",
  VIDEO_SCENE_FOCUS,
  "Use the preliminary RunPod observations as leads, not established facts.",
  "Independently check what is supported by the attached sampled frames.",
  "Do not repeat irrelevant metadata or unsupported claims from RunPod.",
  "Give the user only a clear, natural-language description of the scene,",
  "its visible activities, interactions, and relevant context.",
  "Start with the content itself, not 'Yes', 'The frames show',",
  "'This is a screen recording', or an explanation of your process.",
  "No platform commentary, preamble, unnecessary follow-up question,",
  "or technical note about frame sampling.",
  "If the user's question specifically requires audio, motion between sampled",
  "frames, or another unobserved fact, state that limitation briefly and only",
  "where it materially affects the answer.",
].join(" ");

export function buildRunpodVideoScenePrompt(question: string): string {
  return [
    "TASK: Analyze the video itself for a later scene-focused answer.",
    VIDEO_SCENE_FOCUS,
    "Report specific visible subjects, actions, interactions and progression.",
    "Avoid describing the recording or playback wrapper and avoid generalities.",
    "Return factual scene observations directly, without a preamble.",
    "",
    "USER QUESTION:",
    question.trim() || "Describe what is happening in the scene.",
  ].join("\n");
}

export function buildGrokVideoScenePrompt(question: string, preliminary: string | null): string {
  return [
    "USER QUESTION:",
    question.trim() || "Describe what is happening in the scene.",
    "",
    "FINAL TASK:",
    "Give a specific description of what is actually happening in the scene.",
    "Focus on the subjects' visible behavior, interactions, and setting;",
    "do not talk about the website, phone, video player, watermark, time remaining,",
    "or how the recording was made. Do not discuss your analysis method.",
    "Treat preliminary observations as unverified and use the actual frames to check them.",
    "",
    preliminary?.trim()
      ? "PRELIMINARY RUNPOD OBSERVATIONS (UNVERIFIED; DISCARD PLAYER METADATA):\n" +
        preliminary.trim().slice(0, 16000)
      : "RunPod did not provide usable observations. Analyze the provided frames directly.",
  ].join("\n");
}
