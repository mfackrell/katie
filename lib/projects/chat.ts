/**
 * Compatibility exports. Project command execution lives in Developer service,
 * not in ordinary standalone Katie's conversation-state implementation.
 */
export { startProjectIntent, selfCodeChangeIntent, gameProjectIntent, followupProjectIntent,
  isProjectStopIntent, referencedProjectBrief, handleProjectChat
} from '@/lib/developer/project-conversation';
