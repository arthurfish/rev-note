import { Context, Effect } from "effect";
import type { File } from "../shared-schema.ts";
import { GithubApiError, TokenEncryptionError } from "./errors.ts";
import type { Repository } from "./schema.ts";

export type BackupFile = File;

export interface PublishedBackup {
  readonly branch: string;
  readonly commitSha: string;
}

export interface PublishBackupInput {
  readonly token: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly files: ReadonlyArray<BackupFile>;
  readonly initialFile: BackupFile;
  readonly userId: string;
  readonly committedAt: string;
}

export interface Interface {
  readonly isTokenEncryptionConfigured: () => Effect.Effect<boolean>;
  readonly encryptToken: (
    token: string,
    userId: string,
    repositoryFullName: string,
  ) => Effect.Effect<string, TokenEncryptionError>;
  readonly decryptToken: (
    encryptedToken: string,
    userId: string,
    repositoryFullName: string,
  ) => Effect.Effect<string, TokenEncryptionError>;
  readonly getRepository: (
    token: string,
    repositoryFullName: string,
  ) => Effect.Effect<Repository, GithubApiError>;
  readonly publishBackup: (
    input: PublishBackupInput,
  ) => Effect.Effect<PublishedBackup, GithubApiError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "rev-note/GitHub",
) {}
