import { getGithubRepository } from "../_shared/github.ts";
import { encryptGithubToken } from "../_shared/github-token.ts";
import type { GithubAccountDependencies, GithubAccountConnection } from "./logic.ts";
import { createAdminClient, requiredEnv } from "../_shared/supabase.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

export function createGithubAccountDependencies(admin: AdminClient): GithubAccountDependencies {
  return {
    isTokenEncryptionConfigured: () => Boolean(Deno.env.get("GITHUB_TOKEN_ENCRYPTION_KEY")),
    now: () => new Date(),
    getConnection: async (userId) => {
      const { data, error } = await admin.from("github_connections")
        .select("repository_full_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data ? { repositoryFullName: data.repository_full_name } : null;
    },
    getGithubRepository,
    encryptToken: (token, userId, repositoryFullName) =>
      encryptGithubToken(token, requiredEnv("GITHUB_TOKEN_ENCRYPTION_KEY"), userId, repositoryFullName),
    saveConnection: async (userId, encryptedToken, repositoryFullName, updatedAt) => {
      const { error } = await admin.from("github_connections").upsert({
        user_id: userId,
        token_ciphertext: encryptedToken,
        repository_full_name: repositoryFullName,
        updated_at: updatedAt,
      }, { onConflict: "user_id" });
      if (error) throw error;
    },
    deleteConnection: async (userId) => {
      const { error } = await admin.from("github_connections").delete().eq("user_id", userId);
      if (error) throw error;
    },
    deleteBackupState: async (userId) => {
      const { error } = await admin.from("github_backup_state").delete().eq("user_id", userId);
      if (error) throw error;
    },
  };
}
