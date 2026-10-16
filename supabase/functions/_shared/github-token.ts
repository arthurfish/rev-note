const version = "v1";
const ivLength = 12;
const keyLength = 32;

export async function encryptGithubToken(token: string, encodedKey: string, userId: string, repositoryFullName: string) {
  const key = await importEncryptionKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenContext(userId, repositoryFullName) },
    key,
    new TextEncoder().encode(token),
  ));
  return `${version}.${base64Url(iv)}.${base64Url(ciphertext)}`;
}

export async function decryptGithubToken(encryptedToken: string, encodedKey: string, userId: string, repositoryFullName: string) {
  const [storedVersion, encodedIv, encodedCiphertext, extra] = encryptedToken.split(".");
  if (storedVersion !== version || !encodedIv || !encodedCiphertext || extra) {
    throw new Error("Stored GitHub token has an unsupported format");
  }

  const key = await importEncryptionKey(encodedKey);
  const iv = fromBase64Url(encodedIv);
  const ciphertext = fromBase64Url(encodedCiphertext);
  if (iv.length !== ivLength || ciphertext.length < 16) {
    throw new Error("Stored GitHub token is malformed");
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: tokenContext(userId, repositoryFullName) },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Could not decrypt the stored GitHub token");
  }
}

function tokenContext(userId: string, repositoryFullName: string) {
  return new TextEncoder().encode(`rev-note/github-pat/${version}/${userId}/${repositoryFullName}`);
}

async function importEncryptionKey(encodedKey: string) {
  let keyBytes: Uint8Array;
  try {
    const binary = atob(encodedKey.trim());
    keyBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material");
  }
  if (keyBytes.length !== keyLength) {
    throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material");
  }
  const keyMaterial = new ArrayBuffer(keyLength);
  new Uint8Array(keyMaterial).set(keyBytes);
  return crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
