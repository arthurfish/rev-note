import { Effect } from "effect";
import { TokenEncryptionError } from "../errors.ts";
import { decryptGithubToken, encryptGithubToken } from "../token.ts";

const encryptionKey = encodeBase64(new Uint8Array(32).fill(7));
const anotherKey = encodeBase64(new Uint8Array(32).fill(8));
const userId = "user-123";
const repositoryFullName = "Arthur/rev-note";

Deno.test("encrypts and decrypts a token using the v1 envelope", async () => {
  const token = "github_pat_private-example-token";
  const encrypted = await Effect.runPromise(
    encryptGithubToken(token, encryptionKey, userId, repositoryFullName),
  );

  assertEquals(encrypted.split(".").length, 3);
  assertEquals(encrypted.split(".")[0], "v1");
  assert(!encrypted.includes(token));
  assertEquals(
    await Effect.runPromise(
      decryptGithubToken(encrypted, encryptionKey, userId, repositoryFullName),
    ),
    token,
  );
});

Deno.test("uses a fresh nonce when encrypting the same token", async () => {
  const token = "github_pat_private-example-token";
  const first = await Effect.runPromise(
    encryptGithubToken(token, encryptionKey, userId, repositoryFullName),
  );
  const second = await Effect.runPromise(
    encryptGithubToken(token, encryptionKey, userId, repositoryFullName),
  );

  assert(first !== second);
  assert(first.split(".")[1] !== second.split(".")[1]);
});

Deno.test("binds ciphertext to its key, user, and repository", async () => {
  const encrypted = await Effect.runPromise(
    encryptGithubToken(
      "github_pat_private-example-token",
      encryptionKey,
      userId,
      repositoryFullName,
    ),
  );

  await expectTokenEncryptionError(
    decryptGithubToken(encrypted, anotherKey, userId, repositoryFullName),
  );
  await expectTokenEncryptionError(
    decryptGithubToken(
      encrypted,
      encryptionKey,
      "another-user",
      repositoryFullName,
    ),
  );
  await expectTokenEncryptionError(
    decryptGithubToken(encrypted, encryptionKey, userId, "Arthur/another-repo"),
  );

  const [version, nonce, ciphertext] = encrypted.split(".");
  const modifiedCiphertext = `${ciphertext[0] === "A" ? "B" : "A"}${
    ciphertext.slice(1)
  }`;
  await expectTokenEncryptionError(
    decryptGithubToken(
      `${version}.${nonce}.${modifiedCiphertext}`,
      encryptionKey,
      userId,
      repositoryFullName,
    ),
  );
});

Deno.test("rejects malformed keys and stored token envelopes", async () => {
  const invalidKeys = [
    "too-short",
    "!".repeat(44),
    encodeBase64(new Uint8Array(31).fill(7)),
  ];
  for (const key of invalidKeys) {
    const error = await expectTokenEncryptionError(
      encryptGithubToken("token", key, userId, repositoryFullName),
    );
    assertEquals(
      error.message,
      "GITHUB_TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material",
    );
  }

  for (
    const malformed of [
      "v2.a.b",
      "v1.a",
      "v1.!!.AAAA",
      "v1.YQ==.YQ==",
      "v1.YQ.YQ",
      "v1.AAAAAAAAAAAAAAAA.AA",
    ]
  ) {
    const error = await expectTokenEncryptionError(
      decryptGithubToken(malformed, encryptionKey, userId, repositoryFullName),
    );
    assertEquals(
      error.message,
      "Stored GitHub token has an unsupported or malformed format",
    );
  }
});

async function expectTokenEncryptionError(
  effect: Effect.Effect<unknown, TokenEncryptionError>,
) {
  const error = await Effect.runPromise(Effect.flip(effect));
  assert(error instanceof TokenEncryptionError);
  return error;
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function assert(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
