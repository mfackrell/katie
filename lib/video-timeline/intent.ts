import type { ConversationAttachment } from "../chat/attachment-continuity";
import type { Message } from "../types/chat";
export type TimelineIntent = { kind: "build" | "range" | "tail" | "first"; start?: number; end?: number; tail?: number; query?: string; resume?: boolean; page?: number; error?: string };
const time = (value: string): number => {
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(value)) return NaN;
  const parts = value.split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0) ||
      parts.slice(1).some(n => n >= 60) ||
      parts.slice(0, -1).some(n => !Number.isInteger(n))) return NaN;
  return parts.reduce((a, b) => a * 60 + b, 0);
};
export function timelineIntent(message: string): TimelineIntent | null {
  if (/\b(?:project|business|roadmap|schedule|deadline)\b|\bupload(?:ed)?\s+(?:in|within|last|from|on|at|before|after|between|today|yesterday|\d)/i.test(message)) return null;
  if (/^\s*(?:find|locate|search|recall)\b/i.test(message)) return null;
  // A historical anchor is not evidence that an arbitrary numeric question is about media.
  const media = /\b(?:video|clip|recording|footage)\b/i.test(message);
  const rangeQuestion = /^\s*between\s*[-+\d]|\bwhat happened\b/i.test(message) || media;
  if (/\bbetween\b/i.test(message) && (!rangeQuestion || /\b(?:dollars?|euros?|pounds?|percent|years?)\b|[$€£%]/i.test(message))) return null;
  const page = Math.min(10000, Math.max(1, Number(/\bpage\s+(\d+)\b/i.exec(message)?.[1] ?? 1)));
  const range = /\bbetween\s*([\d:.+-]+)\s*(?:seconds?\s*)?and\s*([\d:.+-]+)/i.exec(message);
  if (range) {
    const start = time(range[1]), end = time(range[2]);
    const suffix = message.slice(range.index + range[0].length);
    const suffixWord = /^\s*([a-z]+)/i.exec(suffix)?.[1];
    if ((suffixWord && !/^(?:seconds?|in|of|on|from|for|please|page)$/i.test(suffixWord)) || /\b(?:minutes?|hours?|milliseconds?)\b/i.test(message)) return {kind:"range",error:"Please specify the video interval using seconds or MM:SS / HH:MM:SS."};
    return { kind: "range", start, end, ...(page > 1 ? {page} : {}), ...(!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86400 ? { error: "Please give an increasing video interval using seconds or MM:SS / HH:MM:SS." } : {}) };
  }
  const tail = /\blast\s*(\d+(?:\.\d+)?)\s*seconds?\b/i.exec(message);
  if (tail && /\b(?:minutes?|hours?|milliseconds?)\b/i.test(message)) return {kind:"tail",error:"Please specify the video interval using seconds or MM:SS / HH:MM:SS."};
  if (tail && (/\bwhat happened\b/i.test(message) || media || /^\s*(?:in the )?last/i.test(message))) return { kind: "tail", tail: Number(tail[1]), ...(page > 1 ? {page} : {}), ...(Number(tail[1]) <= 0 || Number(tail[1]) > 86400 ? {error:"Please specify a positive video interval of at most 24 hours."} : {}) };
  if (/\bwhen\b.*\bfirst (?:appear|show|occur)|\bfirst observed\b/i.test(message)) {
    const query = message.replace(/\b(?:when|did|does|the|a|an|first|appear(?:ed)?|show|up|occur|was|observed|in|this|that|video|clip|recording)\b|[?.,]/gi," ").trim().slice(0,200);
    return {kind:"first",query};
  }
  const unrelatedSubject = /\btimeline\s+(?:of|for|about)\s+/i.test(message)
    && !media && !/\.[a-z0-9]{2,5}\b/i.test(message);
  if (!unrelatedSubject && (media || /\b(?:timestamped|detailed|continue|resume)\b/i.test(message)) && /\b(?:build|create|generate|detailed|timestamped|continue|resume)\b.*\btimeline\b|\btimeline\b.*\b(?:timestamped|detailed)\b/i.test(message))
    return {kind:"build",resume:/\b(?:continue|resume)\b/i.test(message)};
  if ((rangeQuestion || /^\s*last/i.test(message)) && /\bbetween(?=\s|\d).*?(?:\d|NaN|Infinity)|\b(?:between|last)\b.*\b(?:seconds?|minutes?|hours?|\d+:\d+)\b/i.test(message)) return {kind:"range",error:"Please specify the video interval using seconds or MM:SS / HH:MM:SS."};
  return null;
}
export function resolveTimelineSource(message: string, fresh: ConversationAttachment[], catalog: ConversationAttachment[], history: Message[]): {source?: ConversationAttachment; clarification?: string} {
  const videos = (files: ConversationAttachment[]) => files.filter(f => f.mimeType.startsWith("video/"));
  const unique = (files: ConversationAttachment[]) => [...new Map(files.map(f => [`${f.chatId}/${f.id}`, f])).values()];
  const names = (text: string) => text.match(/[^\s"'<>/]+\.(?:mp4|mov|webm|mkv|avi|m4v|mpeg|mpg)[a-z0-9]*\b/gi) ?? [];
  const namedResult = (text: string) => {
    const available = unique(videos(fresh.length ? fresh : catalog));
    const knownNames = [...new Set(available.map(f => f.fileName))].sort((a,b) => b.length-a.length);
    let remaining = text.toLowerCase();
    const recognized: string[] = [];
    for (const name of knownNames) {
      const lower = name.toLowerCase();
      const index = remaining.indexOf(lower);
      // Do not treat known.mp4 as a match inside unknown.mp4.
      if (index >= 0 && (index === 0 || /[\s"']/.test(remaining[index-1])) && (index + lower.length === remaining.length || /[\s"'?,.!;:)]/.test(remaining[index + lower.length]))) {
        recognized.push(name);
        remaining = remaining.replaceAll(lower, " ");
      }
    }
    const explicit = [...recognized, ...names(remaining)];
    if (!explicit.length) return null;
    const matches = explicit.flatMap(name => available.filter(f => f.fileName.toLowerCase() === name.toLowerCase()));
    if (explicit.some(name => !available.some(f => f.fileName.toLowerCase() === name.toLowerCase())))
      return { clarification: `Which recording do you mean? I could not resolve ${explicit.map(name => JSON.stringify(name)).join(", ")}. Please select or upload that source.` };
    return sourceResult(unique(matches));
  };
  const explicit = namedResult(message);
  if (explicit) return explicit;
  let candidates = videos(fresh);
  if (!fresh.length) {
    candidates = unique(videos(catalog).filter(f => message.toLowerCase().includes(f.fileName.toLowerCase())));
    if (!candidates.length) {
      // Ordinary attachment-free turns do not discard the active recording.
      // Stop at the newest explicit source change, including a non-video upload,
      // and retain multiple matches so ambiguous anchors require clarification.
      for (const turn of [...history].reverse()) {
        if (turn.role !== "user") continue;
        const literal = namedResult(turn.content ?? "");
        if (literal) return literal;
        const attached = (turn.attachments ?? []).filter(f => f.conversationUsage !== "contextual");
        if (attached.length) {
          candidates = unique(videos(attached));
          return sourceResult(candidates);
        }
        const named = unique(catalog.filter(f => turn.content?.toLowerCase().includes(f.fileName.toLowerCase())));
        if (named.length) {
          candidates = videos(named);
          return sourceResult(candidates);
        }
      }
      if (!candidates.length && /\b(?:saved|uploaded|video|clip|recording)\b/i.test(message)) candidates = unique(videos(catalog));
    }
  }
  return sourceResult(candidates);
}
function sourceResult(candidates: ConversationAttachment[]) {
  return candidates.length === 1 ? { source: candidates[0] } : candidates.length > 1
    ? { clarification: `Which recording do you mean: ${candidates.slice(0,5).map(f => `${JSON.stringify(f.fileName)} (${f.createdAt ?? "date unknown"}, source chat ${f.chatId})`).join("; ")}?` }
    : {};
}
