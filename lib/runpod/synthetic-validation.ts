import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertRunpodAdmin, submitSavedVideo } from './durable-results';

const REQUEST = 'synthetic-wp4';
const QUESTION = 'This is a synthetic test clip, with no people. Describe the colors, central shape, and scene order.';
type Claim = {actor_id: string; chat_id: string; assistant_id: string; attachment_id: string;
  started_at: string; deadline_at: string; cleaned_at: string | null;
  callback_receipt_id?: string; callback_provider_id?: string; callback_received_at?: string};
export function syntheticAccess(request: Request): number | null {
  if (!assertRunpodAdmin(request)) return 401;
  return process.env.RUNPOD_SYNTHETIC_VALIDATION_ENABLED === 'true' ? null : 404;
}
function store() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('unavailable');
  return createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
}
function path(r: Claim) {return `chats/${r.chat_id}/${r.attachment_id}.source`;}
async function claimRecord(db: ReturnType<typeof store>): Promise<Claim | null> {
  const {data, error} = await db.from('runpod_synthetic_validation').select('*').eq('slot','wp4').maybeSingle();
  if (error) throw new Error('unavailable');
  return data as Claim | null;
}
export async function startSyntheticValidation() {
  const db = store();
  // Read and verify bundled bytes before reserving the irreversible one-shot claim.
  const bytes = await readFile(join(process.cwd(),'fixtures/runpod/synthetic-red-blue.mp4'));
  if (createHash('sha256').update(bytes).digest('hex') !== FIXTURE_SHA256) throw new Error('fixture_invalid');
  const {data, error} = await db.rpc('claim_runpod_synthetic_validation');
  if (error) throw new Error('unavailable');
  if (!data) return {status: 'already_claimed'};
  const r = data as Claim;
  const uploaded = await db.storage.from('katie-attachments').upload(path(r),bytes,{contentType:'video/mp4',upsert:false});
  if (uploaded.error) throw new Error('fixture_upload_failed');
  // Grok recovery loads the persisted reference before decoding the private original.
  const metadata = await db.storage.from('katie-attachments').upload(path(r).replace(/\.source$/,'.json'),
    JSON.stringify({reference:{fileName:'SYNTHETIC-TEST-red-blue.mp4',mimeType:'video/mp4'},
      hasSource:true,actorId:r.actor_id,refreshedAt:Date.now()}),{contentType:'application/json',upsert:false});
  if (metadata.error) throw new Error('fixture_upload_failed');
  if (Date.now() >= Date.parse(r.deadline_at)) throw new Error('deadline_exceeded');
  const receipt = await submitSavedVideo({chatId:r.chat_id, targetChatId:r.chat_id, actorId:r.actor_id,
    requestId:REQUEST, assistantMessageId:r.assistant_id, videoIndex:0,videoTotal:1,
    attachmentPath:path(r), question:QUESTION,sourceFilename:'SYNTHETIC-TEST-red-blue.mp4', syntheticValidation:true});
  return {status:'submitted', receiptId:receipt.id, providerStatus:receipt.status};
}

/** Summarize only ledger-owned data. Never return raw rows, provider errors or content. */
export function summarizeSynthetic(r: Claim, jobs: Record<string, unknown>[], messages: Record<string, unknown>[],
  sourceAvailable: boolean, now = Date.now()) {
  const isolated = jobs.length <= 1 && jobs.every(j => j.actor_id === r.actor_id && j.chat_id === r.chat_id &&
    j.target_chat_id === r.chat_id && j.assistant_message_id === r.assistant_id && j.attachment_path === path(r)) &&
    messages.length === 1 && messages[0].id === r.assistant_id && messages[0].actor_id === r.actor_id && messages[0].chat_id === r.chat_id;
  const j = jobs[0];
  const deliveredCount = jobs.filter(j => !!j.response_delivered_at).length;
  const text = typeof messages[0]?.content === 'string' ? messages[0].content : '';
  const expectedDescription = /red[\s\S]*blue/i.test(text) && /white/i.test(text) && /square/i.test(text);
  const passed = isolated && sourceAvailable && jobs.length === 1 && deliveredCount === 1 &&
    j?.status === 'completed' && !!j.analysis_text && j.fallback_state === 'completed' &&
    !!j.fallback_text && expectedDescription && !text.startsWith('[Katie video analysis pending:');
  const callbackMatched = !!r.callback_received_at && r.callback_receipt_id === j?.id &&
    !!r.callback_provider_id && r.callback_provider_id === j?.runpod_job_id;
  return {status:r.cleaned_at ? 'cleaned' : passed ? 'pipeline_pass' : now >= Date.parse(r.deadline_at) ? 'deadline_exceeded' : 'pending',
    receiptId: typeof j?.id === 'string' ? j.id : null,
    providerStatus: typeof j?.status === 'string' ? j.status : null,
    fallbackStage: typeof j?.fallback_state === 'string' ? j.fallback_state : null,
    deliveredCount, elapsedSeconds:Math.max(0,Math.floor((now-Date.parse(r.started_at))/1000)),
    errorCategory: !isolated ? 'isolation_unverified' : j?.error_code ? 'provider_submission_or_processing' : j?.fallback_error_code ? 'fallback_failed' : null,
    isolated, sourceAvailable, expectedDescription,
    callbackProvenance:callbackMatched ? 'authenticated_matching_callback' : 'not_observed',
    livePass:passed && callbackMatched && !r.cleaned_at && now < Date.parse(r.deadline_at)};
}
export async function syntheticStatus() {
  const db = store(), r = await claimRecord(db);
  if (!r) return {status:'not_started', livePass:false};
  const [jobs, messages, original] = await Promise.all([
    db.from('video_analysis_jobs').select('id,runpod_job_id,status,actor_id,chat_id,target_chat_id,assistant_message_id,attachment_path,analysis_text,fallback_text,fallback_state,error_code,fallback_error_code,response_delivered_at').eq('chat_request_id',REQUEST),
    db.from('messages').select('id,actor_id,chat_id,content').eq('chat_id',r.chat_id),
    r.cleaned_at ? Promise.resolve({data:null,error:null}) : db.storage.from('katie-attachments').download(path(r)),
  ]);
  if (jobs.error || messages.error) throw new Error('unavailable');
  const sourceAvailable = !!original.data && createHash('sha256').update(Buffer.from(await original.data.arrayBuffer())).digest('hex') === FIXTURE_SHA256;
  return summarizeSynthetic(r,jobs.data ?? [],messages.data ?? [],sourceAvailable);
}
export async function cleanupSyntheticValidation() {
  const db = store(), r = await claimRecord(db);
  if (!r) return {status:'not_started'};
  // Deadline is also the earliest cleanup time, preventing setup/cron races with early cleanup.
  if (Date.now() < Date.parse(r.deadline_at)) throw new Error('still_active');
  const removed = await db.storage.from('katie-attachments').remove([path(r),path(r).replace(/\.source$/,'.json')]);
  if (removed.error) throw new Error('cleanup_failed');
  const result = await db.rpc('cleanup_runpod_synthetic_validation');
  if (result.error) throw new Error('cleanup_failed');
  return {status:'cleaned'};
}
const FIXTURE_SHA256 = '42cc3d66eaa3307822a034c05febeb34b4364278cf8f56a9ca1621d46a1f3803';
