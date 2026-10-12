import { requiredEnv } from "./supabase.ts";

const apiBase = "https://api.github.com";

export interface GithubRepository {
  id: number | string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

export interface GithubInstallation {
  id: number | string;
  account?: { login?: string } | null;
}

export class GithubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function createInstallationToken(installationId: string) {
  const appId = requiredEnv("GITHUB_APP_ID");
  const now = Math.floor(Date.now() / 1000);
  const jwt = await createAppJwt(appId, requiredEnv("GITHUB_APP_PRIVATE_KEY"), now - 60, now + 540);
  const response = await fetch(`${apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(jwt),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.token !== "string") {
    throw new GithubApiError(`GitHub installation token request failed (${response.status})`, response.status);
  }
  return body.token as string;
}

export async function listInstallationRepositories(token: string) {
  const repositories: GithubRepository[] = [];
  for (let page = 1; ; page++) {
    const result = await githubRequest<{ repositories: GithubRepository[] }>(
      `${apiBase}/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    const currentPage = result.repositories ?? [];
    repositories.push(...currentPage);
    if (currentPage.length < 100) return repositories;
  }
}

export async function listUserInstallations(token: string) {
  const installations: GithubInstallation[] = [];
  for (let page = 1; ; page++) {
    const result = await githubRequest<{ installations: GithubInstallation[] }>(
      `${apiBase}/user/installations?per_page=100&page=${page}`,
      token,
    );
    const currentPage = result.installations ?? [];
    installations.push(...currentPage);
    if (currentPage.length < 100) return installations;
  }
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

async function createAppJwt(appId: string, pem: string, issuedAt: number, expiresAt: number) {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: appId })));
  const signingInput = `${header}.${payload}`;
  const rawKey = pemBytes(pem);
  const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? wrapPkcs1AsPkcs8(rawKey) : rawKey;
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function pemBytes(pem: string) {
  const encoded = pem.replace(/\\n/g, "\n").replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array) {
  const algorithmIdentifier = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const octetString = concat(Uint8Array.from([0x04]), derLength(pkcs1.length), pkcs1);
  const body = concat(version, algorithmIdentifier, octetString);
  return concat(Uint8Array.from([0x30]), derLength(body.length), body);
}

function derLength(length: number) {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
