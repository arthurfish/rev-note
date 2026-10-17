import { Context, Effect } from "effect";
import type { Snapshot } from "../shared-schema.ts";
import { SupabaseError } from "./errors.ts";
import type { ConnectionInfo, EncryptedConnection } from "./schema.ts";

export interface Interface {
  readonly connections: {
    readonly getInfo: (
      userId: string,
    ) => Effect.Effect<ConnectionInfo | null, SupabaseError>;
    readonly getEncrypted: (
      userId: string,
    ) => Effect.Effect<EncryptedConnection | null, SupabaseError>;
    readonly save: (
      userId: string,
      encryptedToken: string,
      repositoryFullName: string,
      updatedAt: string,
    ) => Effect.Effect<void, SupabaseError>;
    readonly delete: (userId: string) => Effect.Effect<void, SupabaseError>;
  };
  readonly backup: {
    readonly readData: (
      userId: string,
    ) => Effect.Effect<Snapshot, SupabaseError>;
    readonly saveState: (
      userId: string,
      repository: string,
      branch: string,
      commitSha: string,
      lastBackupAt: string,
      noteCount: number,
    ) => Effect.Effect<void, SupabaseError>;
    readonly deleteState: (
      userId: string,
    ) => Effect.Effect<void, SupabaseError>;
  };
}

export class Service extends Context.Service<Service, Interface>()(
  "rev-note/Supabase",
) {}
