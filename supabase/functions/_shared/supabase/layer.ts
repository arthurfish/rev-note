import { Effect, Layer, Schema } from "effect";
import {
  executeSupabaseQuery,
  type SupabaseClient,
  toSupabaseError,
} from "./client.ts";
import {
  ConnectionInfoRow,
  EncryptedConnectionRow,
  NoteRow,
  PreferenceRow,
  RevisionRow,
} from "./schema.ts";
import { SupabaseError } from "./errors.ts";
import type { Snapshot } from "../shared-schema.ts";
import { type Interface, Service } from "./service.ts";
import type { EncryptedConnection } from "./schema.ts";

type QueryPage = {
  range: (
    from: number,
    to: number,
  ) => {
    abortSignal: (
      signal: AbortSignal,
    ) => PromiseLike<{ data: unknown; error: unknown | null }>;
  };
};

export function layer(userClient: SupabaseClient, adminClient: SupabaseClient) {
  return Layer.succeed(
    Service,
    Service.of(
      {
        connections: {
          getInfo: Effect.fn("Supabase.connections.getInfo")(
            function* (userId) {
              const data = yield* executeSupabaseQuery(
                "get GitHub connection",
                (signal) =>
                  adminClient.from("github_connections")
                    .select("repository_full_name")
                    .eq("user_id", userId)
                    .abortSignal(signal)
                    .maybeSingle(),
              );
              if (!data) return null;
              const connection = yield* decodeRow(
                ConnectionInfoRow,
                data,
                "decode GitHub connection",
              );
              return { repositoryFullName: connection.repository_full_name };
            },
          ),
          getEncrypted: Effect.fn(
            "Supabase.connections.getEncrypted",
          )(function* (userId) {
            const data = yield* executeSupabaseQuery(
              "get encrypted GitHub connection",
              (signal) =>
                adminClient.from("github_connections")
                  .select("token_ciphertext, repository_full_name")
                  .eq("user_id", userId)
                  .abortSignal(signal)
                  .maybeSingle(),
            );
            if (!data) return null;
            const connection = yield* decodeRow(
              EncryptedConnectionRow,
              data,
              "decode encrypted GitHub connection",
            );
            return {
              tokenCiphertext: connection.token_ciphertext,
              repositoryFullName: connection.repository_full_name,
            } satisfies EncryptedConnection;
          }),
          save: Effect.fn("Supabase.connections.save")(
            function* (userId, encryptedToken, repositoryFullName, updatedAt) {
              yield* executeSupabaseQuery(
                "save GitHub connection",
                (signal) =>
                  adminClient.from("github_connections").upsert({
                    user_id: userId,
                    token_ciphertext: encryptedToken,
                    repository_full_name: repositoryFullName,
                    updated_at: updatedAt,
                  }, { onConflict: "user_id" }).abortSignal(signal),
              );
            },
          ),
          delete: Effect.fn("Supabase.connections.delete")(function* (userId) {
            yield* executeSupabaseQuery(
              "delete GitHub connection",
              (signal) =>
                adminClient.from("github_connections")
                  .delete().eq("user_id", userId).abortSignal(signal),
            );
          }),
        },
        backup: {
          readData: Effect.fn("Supabase.backup.readData")(function* (userId) {
            const [notes, preferences] = yield* Effect.all([
              fetchAll(
                userClient.from("notes").select(
                  "id, current_revision_id, created_at, status",
                ).eq("owner_id", userId).order("id"),
                NoteRow,
                "read notes for GitHub backup",
              ),
              fetchAll(
                userClient.from("note_user_preferences").select(
                  "note_id, color, pinned",
                ).eq("user_id", userId).order("note_id"),
                PreferenceRow,
                "read note preferences for GitHub backup",
              ),
            ], { concurrency: 2 });

            const revisionIds = notes.map((note) => note.current_revision_id)
              .filter((id): id is string => Boolean(id));
            const revisionPages = yield* Effect.all(
              chunks(revisionIds, 200).map((ids) =>
                Effect.gen(function* () {
                  const data = yield* executeSupabaseQuery(
                    "read note revisions for GitHub backup",
                    (signal) =>
                      userClient.from("note_revisions")
                        .select(
                          "id, note_id, parent_revision_id, content, captured_at, timezone, city, device_type, os, author_type, author_name",
                        )
                        .eq("owner_id", userId)
                        .in("id", ids)
                        .abortSignal(signal),
                  );
                  return yield* decodeRows(
                    RevisionRow,
                    data ?? [],
                    "decode note revisions for GitHub backup",
                  );
                })
              ),
              { concurrency: 4 },
            );

            return {
              notes: notes.map((note) => ({
                id: note.id,
                currentRevisionId: note.current_revision_id,
                createdAt: note.created_at,
                status: note.status,
              })),
              preferences: preferences.map((preference) => ({
                noteId: preference.note_id,
                color: preference.color,
                pinned: preference.pinned,
              })),
              revisions: revisionPages.flat().map((revision) => ({
                id: revision.id,
                noteId: revision.note_id,
                parentRevisionId: revision.parent_revision_id,
                content: revision.content,
                capturedAt: revision.captured_at,
                timezone: revision.timezone,
                city: revision.city,
                deviceType: revision.device_type,
                os: revision.os,
                authorType: revision.author_type,
                authorName: revision.author_name,
              })),
            } satisfies Snapshot;
          }),
          saveState: Effect.fn("Supabase.backup.saveState")(
            function* (
              userId,
              repository,
              branch,
              commitSha,
              lastBackupAt,
              noteCount,
            ) {
              yield* executeSupabaseQuery(
                "save GitHub backup state",
                (signal) =>
                  adminClient.from("github_backup_state").upsert({
                    user_id: userId,
                    repository,
                    branch,
                    commit_sha: commitSha,
                    last_backup_at: lastBackupAt,
                    note_count: noteCount,
                  }).abortSignal(signal),
              );
            },
          ),
          deleteState: Effect.fn("Supabase.backup.deleteState")(
            function* (userId) {
              yield* executeSupabaseQuery(
                "delete GitHub backup state",
                (signal) =>
                  adminClient.from("github_backup_state")
                    .delete().eq("user_id", userId).abortSignal(signal),
              );
            },
          ),
        },
      } satisfies Interface,
    ),
  );
}

function fetchAll<S extends Schema.ConstraintDecoder<unknown>>(
  query: QueryPage,
  schema: S,
  operation: string,
): Effect.Effect<
  ReadonlyArray<S["Type"]>,
  SupabaseError,
  S["DecodingServices"]
> {
  return Effect.gen(function* () {
    const rows: S["Type"][] = [];
    const pageSize = 500;
    for (let offset = 0;; offset += pageSize) {
      const page = yield* executeSupabaseQuery(
        operation,
        (signal) =>
          query.range(offset, offset + pageSize - 1).abortSignal(signal),
      );
      const decodedPage = yield* decodeRows(
        schema,
        page ?? [],
        `decode ${operation}`,
      );
      rows.push(...decodedPage);
      if (decodedPage.length < pageSize) return rows;
    }
  });
}

function decodeRow<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  operation: string,
): Effect.Effect<S["Type"], SupabaseError, S["DecodingServices"]> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => toSupabaseError(operation, cause)),
  );
}

function decodeRows<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  operation: string,
): Effect.Effect<
  ReadonlyArray<S["Type"]>,
  SupabaseError,
  S["DecodingServices"]
> {
  return Schema.decodeUnknownEffect(Schema.Array(schema))(value).pipe(
    Effect.mapError((cause) => toSupabaseError(operation, cause)),
  );
}

function chunks<T>(items: ReadonlyArray<T>, size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
