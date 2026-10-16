import { decryptGithubToken, encryptGithubToken } from "./github-token.ts";

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const anotherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const userId = "user-123";
const repositoryFullName = "Arthur/rev-note";

Deno.test("encrypts GitHub tokens and decrypts them with the configured key", async () => {
  const token = "github_pat_private-example-token";
  const encrypted = await encryptGithubToken(token, encryptionKey, userId, repositoryFullName);

  assert(!encrypted.includes(token));
  assertEquals(await decryptGithubToken(encrypted, encryptionKey, userId, repositoryFullName), token);
});

Deno.test("uses a fresh nonce when encrypting the same token", async () => {
  const token = "github_pat_private-example-token";
  const first = await encryptGithubToken(token, encryptionKey, userId, repositoryFullName);
  const second = await encryptGithubToken(token, encryptionKey, userId, repositoryFullName);

  assert(first !== second);
});

Deno.test("rejects tokens encrypted with another key or modified ciphertext", async () => {
  const encrypted = await encryptGithubToken("github_pat_private-example-token", encryptionKey, userId, repositoryFullName);
  const [version, iv, ciphertext] = encrypted.split(".");
  const tampered = `${version}.${iv}.${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;

  await expectFailure(() => decryptGithubToken(encrypted, anotherKey, userId, repositoryFullName));
  await expectFailure(() => decryptGithubToken(encrypted, encryptionKey, "another-user", repositoryFullName));
  await expectFailure(() => decryptGithubToken(encrypted, encryptionKey, userId, "Arthur/another-repo"));
  await expectFailure(() => decryptGithubToken(tampered, encryptionKey, userId, repositoryFullName));
});

Deno.test("rejects malformed encryption keys and stored token formats", async () => {
  await expectFailure(() => encryptGithubToken("token", "too-short", userId, repositoryFullName));
  await expectFailure(() => decryptGithubToken("v2.a.b", encryptionKey, userId, repositoryFullName));
});

async function expectFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected the operation to fail");
}

function assert(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}
