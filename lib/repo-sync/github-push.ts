import { z } from "zod";

const commitSchema = z.object({
  id: z.string().min(1),
  added: z.array(z.string()).default([]),
  modified: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([])
});

const pushPayloadSchema = z.object({
  repository: z.object({
    full_name: z.string().min(1)
  }),
  before: z.string().min(1),
  after: z.string().min(1),
  commits: z.array(commitSchema).default([])
});

export type RepoFileChange = {
  path: string;
  changeType: "changed" | "deleted";
};

export type ParsedPushCommit = {
  commitSha: string;
  files: RepoFileChange[];
};

export type ParsedPushPayload = {
  repositoryFullName: string;
  beforeSha: string;
  afterSha: string;
  commits: ParsedPushCommit[];
};

export function parsePushPayload(raw: unknown): ParsedPushPayload {
  const payload = pushPayloadSchema.parse(raw);

  const commits: ParsedPushCommit[] = payload.commits.map((commit) => {
    const byPath = new Map<string, RepoFileChange>();

    for (const path of [...commit.added, ...commit.modified]) {
      byPath.set(path, { path, changeType: "changed" });
    }

    for (const path of commit.removed) {
      byPath.set(path, { path, changeType: "deleted" });
    }

    return {
      commitSha: commit.id,
      files: [...byPath.values()]
    };
  });

  return {
    repositoryFullName: payload.repository.full_name,
    beforeSha: payload.before,
    afterSha: payload.after,
    commits
  };
}
