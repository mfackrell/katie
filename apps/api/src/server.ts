import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type GithubWebhookRequest = FastifyRequest & {
  rawBody?: Buffer;
};

export async function installGithubWebhookRawBody(fastify: FastifyInstance): Promise<void> {
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    if (request.url.startsWith('/webhooks/github')) {
      (request as GithubWebhookRequest).rawBody = body;

      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (error) {
        done(error as Error, undefined);
      }

      return;
    }

    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  fastify.post('/webhooks/github', async (request: GithubWebhookRequest, reply: FastifyReply) => {
    if (!request.rawBody) {
      return reply.code(400).send({ ok: false, error: 'Missing raw payload' });
    }

    return reply.send({ ok: true });
  });
}
