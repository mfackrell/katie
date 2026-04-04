import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_KEYS: z.string().default('dev-key'),
  GITHUB_AUTH_MODE: z.enum(['app', 'pat']).default('pat'),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(['openai', 'noop']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIM: z.coerce.number().default(1536),
  LOG_LEVEL: z.string().default('info')
});

export type AppConfig = z.infer<typeof envSchema> & { apiKeys: Set<string> };

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    apiKeys: new Set(parsed.API_KEYS.split(',').map((k) => k.trim()).filter(Boolean))
  };
};
