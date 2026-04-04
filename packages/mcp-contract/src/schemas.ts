import { z } from 'zod';

export const repoRef = z.string().regex(/^[^/]+\/[^/]+$/);

export const searchInputSchema = z.object({
  repo: repoRef,
  branch: z.string().optional(),
  query: z.string().min(1),
  pathPrefix: z.string().optional(),
  topK: z.number().int().min(1).max(50).default(10)
});

export const getFileInputSchema = z.object({
  repo: repoRef,
  branch: z.string().optional(),
  path: z.string(),
  startLine: z.number().int().positive().default(1),
  endLine: z.number().int().positive().optional()
});

export const getSymbolInputSchema = z.object({
  repo: repoRef,
  branch: z.string().optional(),
  symbol: z.string(),
  pathHint: z.string().optional()
});

export const getNeighborsInputSchema = z.object({
  repo: repoRef,
  branch: z.string().optional(),
  path: z.string(),
  chunkId: z.string().uuid(),
  radius: z.number().int().min(1).max(10).default(2)
});
