/**
 * Local live run:
 * deno run --allow-env --allow-net --env-file=.env.edge supabase/functions/_shared/backup-coordinator/test/backup_live.ts <user-access-token> <user-id>
 *
 * The env file must provide SUPABASE_URL, a Supabase server secret key, and GITHUB_TOKEN_ENCRYPTION_KEY.
 * Pass a current user's access token so note reads continue to use that user's RLS context.
 * This invokes the real backup workflow and writes to the selected GitHub repository.
 */
import { Effect } from "effect";
import * as Coordinator from "../index.ts";
import * as Supabase from "../../supabase/index.ts";

const userToken = Deno.args[0] ||
  Deno.env.get("GITHUB_BACKUP_TEST_ACCESS_TOKEN");
const userId = Deno.args[1] || Deno.env.get("GITHUB_BACKUP_TEST_USER_ID");
if (!userToken) {
  throw new Error(
    "Pass a current Supabase user access token or set GITHUB_BACKUP_TEST_ACCESS_TOKEN",
  );
}
if (!userId) {
  throw new Error("Pass a Supabase user ID or set GITHUB_BACKUP_TEST_USER_ID");
}

const request = new Request("http://localhost", {
  headers: { Authorization: `Bearer ${userToken}` },
});
const { supabase, user } = await Effect.runPromise(
  Supabase.requireAuthenticatedUser(request),
);
if (user.id !== userId) {
  throw new Error(
    "The provided access token does not match the requested user ID",
  );
}
const admin = await Effect.runPromise(Supabase.createAdminClient());
try {
  const result = await Effect.runPromise(
    Coordinator.Backup.runBackup(userId).pipe(
      Effect.provide(Coordinator.layer(supabase, admin)),
    ),
  );
  await Effect.runPromise(
    Effect.logInfo("github-backup local run succeeded", result),
  );
} catch (error) {
  await Effect.runPromise(
    Effect.logError("github-backup local run failed", error),
  );
  throw error;
}
