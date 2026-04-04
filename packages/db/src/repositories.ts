import { randomUUID } from 'crypto';
import type { Db } from './client';

export const upsertRepository = async (db: Db, owner: string, repo: string, defaultBranch: string) => {
  const id = randomUUID();
  const { rows } = await db.query(
    `insert into repositories (id, github_owner, github_repo, default_branch)
     values ($1,$2,$3,$4)
     on conflict (github_owner, github_repo)
     do update set default_branch = excluded.default_branch, updated_at = now()
     returning *`,
    [id, owner, repo, defaultBranch]
  );
  return rows[0];
};

export const upsertFile = async (
  db: Db,
  payload: {
    repositoryId: string; path: string; language: string | null; sha: string; sizeBytes: number; isBinary: boolean;
  }
) => {
  const id = randomUUID();
  const { rows } = await db.query(
    `insert into files (id, repository_id, path, language, sha, size_bytes, is_binary, last_indexed_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     on conflict (repository_id, path)
     do update set language = excluded.language, sha = excluded.sha, size_bytes = excluded.size_bytes,
                   is_binary = excluded.is_binary, last_indexed_at = now()
     returning *`,
    [id, payload.repositoryId, payload.path, payload.language, payload.sha, payload.sizeBytes, payload.isBinary]
  );
  return rows[0];
};
