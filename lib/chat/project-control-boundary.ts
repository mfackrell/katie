import { startProjectIntent, followupProjectIntent, isProjectStopIntent } from "@/lib/projects/chat";

/** Saved project identities are context, not permission to bypass model routing.
 * Only explicit management commands may produce a local project response. */
export function shouldUseLocalProjectControl(message: string): boolean {
  return startProjectIntent(message) || followupProjectIntent(message) || isProjectStopIntent(message);
}
