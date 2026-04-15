export function parseGitHubRepoFullName(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  if (!match) return null;
  return match[1];
}

export function taskSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
