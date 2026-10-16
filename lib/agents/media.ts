import { currentAgentTask } from "./policy";
import { retrieveSavedEvidence as retrieve } from "@/lib/media-memory/evidence";
import { loadSavedVideoFollowUp as followUp } from "@/lib/chat/saved-video-observations";

// Denied tasks must not load saved-source bodies even when their metadata catalog is empty.
export const retrieveSavedEvidence: typeof retrieve = async (...args) =>
  currentAgentTask()?.snapshot.attachments === false ? null : retrieve(...args);
export const loadSavedVideoFollowUp: typeof followUp = async (...args) =>
  currentAgentTask()?.snapshot.attachments === false ? null : followUp(...args);
