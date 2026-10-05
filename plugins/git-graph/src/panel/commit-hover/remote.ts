type Remote = { name: string; fetchUrl: string | null; pushUrl: string | null };

const github = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const remoteGithubUrl = (remote: Remote): string | null => {
  for (const candidate of [remote.fetchUrl, remote.pushUrl]) {
    const match = candidate?.trim().match(github);
    if (match?.[1] && match[2]) return `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, '')}`;
  }
  return null;
};

/** Select the GitHub repository in the same order as the original renderer. */
export const githubRepositoryUrl = (remotes: readonly Remote[]): string | null => {
  const origin = remotes.find((remote) => remote.name === 'origin');
  return (origin && remoteGithubUrl(origin)) ?? remotes.map(remoteGithubUrl).find((url): url is string => url !== null) ?? null;
};

export const githubCommitUrl = (remotes: readonly Remote[], commit: string): string | null => {
  if (!sha.test(commit)) return null;
  const base = githubRepositoryUrl(remotes);
  return base ? `${base}/commit/${commit}` : null;
};
