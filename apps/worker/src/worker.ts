import { Queue, Worker, QueueEvents } from 'bullmq';
import { loadConfig, createLogger } from '../../../packages/core/src';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const connection = { url: config.REDIS_URL };

export const indexQueue = new Queue('repo-index', { connection });
export const deadLetterQueue = new Queue('repo-index-dlq', { connection });

const queueEvents = new QueueEvents('repo-index', { connection });
queueEvents.on('failed', async ({ jobId, failedReason }) => {
  await deadLetterQueue.add('dead', { jobId, failedReason });
});

const worker = new Worker(
  'repo-index',
  async (job) => {
    logger.info({ jobId: job.id, repo: job.data.repo, mode: job.data.mode }, 'index job accepted');
    return { ok: true };
  },
  { connection }
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
});

const shutdown = async () => {
  await worker.close();
  await deadLetterQueue.close();
  await indexQueue.close();
  await queueEvents.close();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
