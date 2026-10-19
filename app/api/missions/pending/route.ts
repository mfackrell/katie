import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';

type PendingMission = { id: string; objective: string; status: string; created_at: string };
type PendingAssignment = {
  id: string; mission_id: string; role: string; status: string;
  instruction: string; payload: { development_input?: unknown } | null;
};

export const dynamic = 'force-dynamic';

/** Provide the main workspace with every saved, actionable coding approval. */
export async function GET() {
  try {
    const db = getSupabaseAdminClient();
    const { data: missions, error: missionError } = await db.from('agent_missions')
      .select('id,objective,status,created_at')
      .eq('status','awaiting_approval')
      .order('created_at',{ascending:false}).limit(100).returns<PendingMission>();
    if (missionError) throw new Error('Mission approvals unavailable');
    if (!missions?.length) return NextResponse.json({ approvals: [] }, { headers: { 'Cache-Control': 'no-store' } });

    const { data: assignments, error: assignmentError } = await db.from('mission_assignments')
      .select('id,mission_id,role,status,instruction,payload')
      .in('mission_id',missions.map(m => m.id))
      .eq('status','awaiting_approval')
      .eq('role','development')
      .limit(100).returns<PendingAssignment>();
    if (assignmentError) throw new Error('Coding approvals unavailable');

    const missionById = new Map(missions.map(m => [m.id,m]));
    const approvals = (assignments ?? []).flatMap(job => {
      const mission = missionById.get(job.mission_id);
      if (!mission || typeof job.payload?.development_input !== 'string') return [];
      return [{
        missionId: mission.id,
        jobId: job.id,
        objective: mission.objective,
        instruction: job.instruction,
        codingInput: job.payload.development_input,
        createdAt: mission.created_at,
      }];
    });
    return NextResponse.json({ approvals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Pending mission approvals unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
