/** owner/repo from the final two path components of a git remote URL. */
const ownerRepoFromPath = (url: string): string | undefined => {
  const path = url.trim().replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^[^/]*:(?!\/)/, "/");
  const match = /([\w.-]+)\/([\w.-]+)$/.exec(path);
  return match ? `${match[1]}/${match[2]}` : undefined;
};

export const repoFromRemote = (url: string): string | undefined =>
  /^(?:[A-Za-z][\w+.-]*:\/\/|[^/\s]+@[^:/\s]+:)/.test(url.trim()) || url.trim().startsWith("/")
    ? ownerRepoFromPath(url) : undefined;

/** owner/repo from a host URL only, preserving case and rejecting local paths. */
export const repoFromRemoteUrl = (url: string): string | undefined =>
  /^(?:[A-Za-z][\w+.-]*:\/\/|[^/\s]+@[^:/\s]+:)/.test(url.trim()) ? ownerRepoFromPath(url) : undefined;

/** owner/repo from a GitHub remote URL, lowercased. */
export const githubRepoFromRemote = (url: string): string | undefined => {
  const match = /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1]?.toLowerCase();
};
