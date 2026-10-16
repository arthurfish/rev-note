const apiBase = "https://api.github.com";

export interface GithubRepository {
  id: number | string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

export class GithubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function parseGithubRepositoryName(fullName: string) {
  const parts = fullName.trim().split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
    return null;
  }
  return { owner: parts[0], repository: parts[1] };
}

export async function getGithubRepository(token: string, fullName: string) {
  const parsed = parseGithubRepositoryName(fullName);
  if (!parsed) throw new Error("Repository must use the owner/repository format");
  return githubRequest<GithubRepository>(
    `${apiBase}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`,
    token,
  );
}

export async function githubRequest<T = unknown>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...init.headers },
  });
  const text = await response.text();
  const body = text ? tryParseJson(text) : null;
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : `GitHub API failed (${response.status})`;
    throw new GithubApiError(message, response.status);
  }
  return body as T;
}

export function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function tryParseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
