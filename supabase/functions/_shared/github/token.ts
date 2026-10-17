import { Config, ConfigProvider, Effect, Schema } from "effect";
import { TokenEncryptionError } from "./errors.ts";
import { EncryptedTokenEnvelope } from "./schema.ts";

const formatVersion = "v1";
const nonceLength = 12;
const keyLength = 32;
const authenticationTagLength = 16;
const keyErrorMessage =
  "GITHUB_TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material";
const storedTokenFormatError =
  "Stored GitHub token has an unsupported or malformed format";

export const loadGithubTokenEncryptionKey = Effect.fn(
  "GithubToken.loadEncryptionKey",
)(function* () {
  const environment = yield* Effect.try({
    try: () => Deno.env.toObject(),
    catch: () =>
      new TokenEncryptionError({
        message: "Could not read GitHub token encryption configuration",
      }),
  });
  const configProvider = ConfigProvider.fromEnv({ env: environment });
  return yield* Config.option(Config.Redacted("GITHUB_TOKEN_ENCRYPTION_KEY"))
    .pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.mapError(() =>
        new TokenEncryptionError({
          message: "Could not read GitHub token encryption configuration",
        })
      ),
    );
});

export const encryptGithubToken = Effect.fn("GithubToken.encrypt")(
  function* (
    token: string,
    encodedKey: string,
    userId: string,
    repositoryFullName: string,
  ) {
    const key = yield* importEncryptionKey(encodedKey);
    const nonce = yield* createNonce();
    const ciphertext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: tokenContext(userId, repositoryFullName),
          },
          key,
          new TextEncoder().encode(token),
        ),
      catch: () =>
        new TokenEncryptionError({ message: "Could not encrypt GitHub token" }),
    });

    return [
      formatVersion,
      encodeBase64Url(nonce),
      encodeBase64Url(new Uint8Array(ciphertext)),
    ].join(".");
  },
);

export const decryptGithubToken = Effect.fn("GithubToken.decrypt")(
  function* (
    encryptedToken: string,
    encodedKey: string,
    userId: string,
    repositoryFullName: string,
  ) {
    const envelope = yield* decodeEnvelope(encryptedToken);
    const nonce = yield* decodeBase64Url(envelope.nonce);
    const ciphertext = yield* decodeBase64Url(envelope.ciphertext);

    if (
      nonce.length !== nonceLength ||
      ciphertext.length < authenticationTagLength
    ) {
      return yield* new TokenEncryptionError({
        message: storedTokenFormatError,
      });
    }

    const key = yield* importEncryptionKey(encodedKey);
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: tokenContext(userId, repositoryFullName),
          },
          key,
          ciphertext,
        ),
      catch: () =>
        new TokenEncryptionError({
          message: "Could not decrypt the stored GitHub token",
        }),
    });

    return new TextDecoder().decode(plaintext);
  },
);

export function isGithubTokenEncryptionKeyValid(encodedKey: string) {
  return importEncryptionKey(encodedKey).pipe(
    Effect.as(true),
    Effect.catchTag("TokenEncryptionError", () => Effect.succeed(false)),
  );
}

function decodeEnvelope(value: string) {
  const [version, nonce, ciphertext, extra] = value.split(".");
  if (
    extra !== undefined || version === undefined || nonce === undefined ||
    ciphertext === undefined
  ) {
    return Effect.fail(
      new TokenEncryptionError({ message: storedTokenFormatError }),
    );
  }

  return Schema.decodeUnknownEffect(EncryptedTokenEnvelope)({
    version,
    nonce,
    ciphertext,
  }).pipe(
    Effect.mapError(
      () => new TokenEncryptionError({ message: storedTokenFormatError }),
    ),
  );
}

function importEncryptionKey(encodedKey: string) {
  return Effect.flatMap(
    decodeEncryptionKey(encodedKey),
    (bytes) =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "raw",
            toArrayBuffer(bytes),
            "AES-GCM",
            false,
            ["encrypt", "decrypt"],
          ),
        catch: () =>
          new TokenEncryptionError({
            message: "Could not import GitHub token encryption key",
          }),
      }),
  );
}

function decodeEncryptionKey(encodedKey: string) {
  return Effect.try({
    try: () => atob(encodedKey.trim()),
    catch: () => new TokenEncryptionError({ message: keyErrorMessage }),
  }).pipe(
    Effect.flatMap((binary) => {
      const bytes = Uint8Array.from(
        binary,
        (character) => character.charCodeAt(0),
      );
      return bytes.length === keyLength
        ? Effect.succeed(bytes)
        : Effect.fail(new TokenEncryptionError({ message: keyErrorMessage }));
    }),
  );
}

function createNonce() {
  return Effect.try({
    try: () => crypto.getRandomValues(new Uint8Array(nonceLength)),
    catch: () =>
      new TokenEncryptionError({ message: "Could not generate token nonce" }),
  });
}

function decodeBase64Url(value: string) {
  return Effect.try({
    try: () => {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
      return atob(padded);
    },
    catch: () => new TokenEncryptionError({ message: storedTokenFormatError }),
  }).pipe(
    Effect.flatMap((binary) => {
      const bytes = Uint8Array.from(
        binary,
        (character) => character.charCodeAt(0),
      );
      return encodeBase64Url(bytes) === value
        ? Effect.succeed(bytes)
        : Effect.fail(
          new TokenEncryptionError({ message: storedTokenFormatError }),
        );
    }),
  );
}

function tokenContext(userId: string, repositoryFullName: string) {
  return new TextEncoder().encode(
    `rev-note/github-pat/${formatVersion}/${userId}/${repositoryFullName}`,
  );
}

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
