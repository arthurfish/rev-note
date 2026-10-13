/**
 * Local live run:
 * deno run --allow-env --allow-net --env-file=.env.edge supabase/functions/github-backup/logic_real_test.ts <user-id>
 *
 * The env file must provide SUPABASE_URL, a Supabase server secret key, and the GitHub App ID/private key.
 * This invokes the real backup workflow and writes to the selected GitHub repository.
 */
import { createAdminClient } from "../_shared/supabase.ts";
import { runGithubBackup } from "./logic.ts";

const userId = Deno.args[0] || Deno.env.get("GITHUB_BACKUP_TEST_USER_ID");
if (!userId) {
  throw new Error("Pass a Supabase user ID or set GITHUB_BACKUP_TEST_USER_ID");
}

const admin = createAdminClient();
try {
  const result = await runGithubBackup(userId, admin, admin);
  console.log("github-backup local run succeeded:", JSON.stringify(result, null, 2));
} catch (error) {
  console.error("github-backup local run failed:", error);
  throw error;
}
