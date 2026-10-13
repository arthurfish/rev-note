import { createInstallationToken, listInstallationRepositories } from "../_shared/github.ts";
import type { GithubAccountDependencies, GithubAccountConnection } from "./logic.ts";
import { createOpaqueState, hashState } from "../_shared/github-state.ts";
import { createAdminClient, requiredEnv } from "../_shared/supabase.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

export function createGithubAccountDependencies(admin: AdminClient): GithubAccountDependencies {
  return {
    isGithubAppConfigured: githubAppIsConfigured,
    getGithubAppSlug: () => requiredEnv("GITHUB_APP_SLUG"),
    createOpaqueState,
    hashState,
    now: () => new Date(),
    deleteExpiredInstallStates: async (expiresBefore) => {
      const { error } = await admin.from("github_install_states").delete().lt("expires_at", expiresBefore);
      if (error) throw error;
    },
    insertInstallState: async (stateHash, userId, expiresAt) => {
      const { error } = await admin.from("github_install_states").insert({
        state_hash: stateHash,
        user_id: userId,
        expires_at: expiresAt,
      });
      if (error) throw error;
    },
    getConnection: async (userId) => {
      const { data, error } = await admin.from("github_connections")
        .select("installation_id, installation_account_login, repository_id, repository_full_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data ? toGithubAccountConnection(data) : null;
    },
    createInstallationToken,
    listInstallationRepositories,
    updateSelectedRepository: async (userId, repositoryId, repositoryFullName, updatedAt) => {
      const { error } = await admin.from("github_connections").update({
        repository_id: repositoryId,
        repository_full_name: repositoryFullName,
        updated_at: updatedAt,
      }).eq("user_id", userId);
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

function githubAppIsConfigured() {
  return Boolean(
    Deno.env.get("GITHUB_APP_ID") &&
    Deno.env.get("GITHUB_APP_SLUG") &&
    Deno.env.get("GITHUB_APP_PRIVATE_KEY") &&
    Deno.env.get("GITHUB_APP_CLIENT_ID") &&
    Deno.env.get("GITHUB_APP_CLIENT_SECRET") &&
    Deno.env.get("APP_BASE_URL"),
  );
}

function toGithubAccountConnection(data: {
  installation_id: string;
  installation_account_login: string;
  repository_id: string | null;
  repository_full_name: string | null;
}): GithubAccountConnection {
  return {
    installationId: data.installation_id,
    installationAccountLogin: data.installation_account_login,
    repositoryId: data.repository_id,
    repositoryFullName: data.repository_full_name,
  };
}
