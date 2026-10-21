import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {parseMessageContent} from '@/lib/data/persistence-store';
import type {AgentTask} from './policy';
import type {Message} from '@/lib/types/chat';

/** Read only immutable evidence explicitly transferred into this managed task. */
export async function loadTaskHandoffEvidence(task: AgentTask, projectId: string): Promise<Message[] | null> {
 const {data,error}=await getSupabaseAdminClient().from('agent_task_context_handoffs')
  .select('project_id,source_messages').eq('task_id',task.id).eq('target_actor_id',task.actor_id).eq('target_chat_id',task.chat_id)
  .maybeSingle<{project_id:string;source_messages:Message[]}>();
 if(error) throw new Error('Authorized handoff evidence unavailable');
 if(!data) return null;
 if(data.project_id!==projectId || !Array.isArray(data.source_messages)) throw new Error('Handoff project binding mismatch');
 return data.source_messages.map(message=>{
  if(!message || typeof message.id!=='string' || typeof message.content!=='string' || !['user','assistant'].includes(message.role)) throw new Error('Invalid handoff source message');
  // Transfer text evidence, never old attachment access or execution capability.
  return {...message,content:parseMessageContent(message.content).text};
 });
}
