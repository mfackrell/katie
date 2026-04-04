import { Octokit } from '@octokit/rest';
import { withRetry } from '../../core/src/retry';

export class GithubConnector {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit(token ? { auth: token } : {});
  }

  async getRepo(owner: string, repo: string) {
    const data = await withRetry(() => this.octokit.repos.get({ owner, repo }));
    return data.data;
  }

  async getTree(owner: string, repo: string, branch: string) {
    const ref = await withRetry(() => this.octokit.git.getRef({ owner, repo, ref: `heads/${branch}` }));
    const sha = ref.data.object.sha;
    const tree = await withRetry(() => this.octokit.git.getTree({ owner, repo, tree_sha: sha, recursive: '1' }));
    return { sha, tree: tree.data.tree };
  }

  async getFile(owner: string, repo: string, path: string, ref: string) {
    const blob = await withRetry(() => this.octokit.repos.getContent({ owner, repo, path, ref }));
    if (!('content' in blob.data)) throw new Error('Not a file');
    return {
      sha: blob.data.sha,
      size: blob.data.size,
      content: Buffer.from(blob.data.content, 'base64').toString('utf8')
    };
  }
}
