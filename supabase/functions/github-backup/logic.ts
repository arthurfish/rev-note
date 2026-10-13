import { createInstallationToken, GithubApiError, githubRequest, listInstallationRepositories } from "../_shared/github.ts";
import type { createAdminClient } from "../_shared/supabase.ts";
import { isMissingGithubRefError, resolveBackupBranch } from "./branch.ts";

type SupabaseClient = ReturnType<typeof createAdminClient>;

export class GithubBackupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface GithubBackupResult {
  ok: true;
  repository: string;
  branch: string;
  commitSha: string;
  noteCount: number;
}

export async function runGithubBackup(
  userId: string,
  supabase: SupabaseClient,
  admin: SupabaseClient,
): Promise<GithubBackupResult> {
  const { data: connection, error: connectionError } = await admin.from("github_connections")
    .select("installation_id, installation_account_login, repository_id, repository_full_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection?.repository_id) throw new GithubBackupError("请先连接 GitHub 并选择备份仓库", 409);

  const token = await createInstallationToken(connection.installation_id as string);
  const repositories = await listInstallationRepositories(token);
  const repository = repositories.find((item) => String(item.id) === String(connection.repository_id));
  if (!repository) throw new GithubBackupError("目标仓库已不在 GitHub App 的授权范围内，请重新选择", 409);
  const [owner, repositoryName] = repository.full_name.split("/");
  if (!owner || !repositoryName) throw new Error("GitHub returned an invalid repository name");
  if (owner.toLowerCase() !== String(connection.installation_account_login).toLowerCase()) {
    throw new GithubBackupError("目标仓库不属于当前连接的 GitHub 个人账号", 403);
  }
  let branch = repository.default_branch || "main";

  const [notes, preferences] = await Promise.all([
    fetchAll(supabase.from("notes").select("id, current_revision_id, created_at, status").eq("owner_id", userId)),
    fetchAll(supabase.from("note_user_preferences").select("note_id, color, pinned").eq("user_id", userId)),
  ]);
  const revisionIds = notes.map((note) => note.current_revision_id).filter((id): id is string => Boolean(id));
  const revisionResults = await Promise.all(chunks(revisionIds, 200).map((ids) =>
    supabase.from("note_revisions")
      .select("id, note_id, parent_revision_id, content, captured_at, timezone, city, device_type, os, author_type, author_name")
      .eq("owner_id", userId)
      .in("id", ids)
  ));
  for (const result of revisionResults) if (result.error) throw result.error;

  const revisionById = new Map(revisionResults.flatMap((result) => result.data ?? []).map((revision) => [revision.id, revision]));
  const preferenceByNote = new Map(preferences.map((preference) => [preference.note_id, preference]));
  const backupPrefix = `users/${userId}`;
  const files: { path: string; content: string }[] = [];
  const backedUp: string[] = [];
  for (const note of notes) {
    const revision = revisionById.get(note.current_revision_id);
    if (!revision) continue;
    const preference = preferenceByNote.get(note.id);
    const metadata = {
      noteId: note.id,
      createdAt: note.created_at,
      status: note.status,
      revision: {
        id: revision.id,
        parentRevisionId: revision.parent_revision_id,
        capturedAt: revision.captured_at,
        timezone: revision.timezone,
        city: revision.city,
        device: { type: revision.device_type, os: revision.os },
        author: { type: revision.author_type, name: revision.author_name },
      },
      preference: preference ? { color: preference.color, pinned: preference.pinned } : null,
    };
    files.push({ path: `${backupPrefix}/notes/${note.id}.md`, content: `${revision.content}\n` });
    files.push({ path: `${backupPrefix}/metadata/${note.id}.json`, content: `${JSON.stringify(metadata, null, 2)}\n` });
    backedUp.push(note.id);
  }
  files.push({
    path: `${backupPrefix}/README.md`,
    content: `# RevNote backup\n\nThis folder contains the current revision of each note for account \`${userId}\`, including notes in the trash.\n\n- Notes are readable Markdown files under \`notes/\`.\n- Capture context, lifecycle status, and note preferences are in \`metadata/\`.\n`,
  });
  files.push({
    path: `${backupPrefix}/manifest.json`,
    content: `${JSON.stringify({ format: "rev-note-github-backup", version: 1, noteCount: backedUp.length, noteIds: backedUp }, null, 2)}\n`,
  });

  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;
  const initialFile = files.find((file) => file.path === `${backupPrefix}/README.md`)!;
  const resolvedBranch = await resolveBackupBranch(branch, initialFile, {
    getBranch: async (branchName) => {
      let ref: { object: { sha: string } };
      try {
        ref = await githubRequest<{ object: { sha: string } }>(
          `${base}/git/ref/heads/${encodeURIComponent(branchName)}`,
          token,
        );
      } catch (error) {
        if (error instanceof GithubApiError && isMissingGithubRefError(error)) return null;
        throw error;
      }

      const parent = await githubRequest<{ tree: { sha: string } }>(
        `${base}/git/commits/${ref.object.sha}`,
        token,
      );
      return { commitSha: ref.object.sha, treeSha: parent.tree.sha };
    },
    initializeEmptyRepository: async (file) => {
      const path = file.path.split("/").map(encodeURIComponent).join("/");
      await githubRequest(`${base}/contents/${path}`, token, {
        method: "PUT",
        body: JSON.stringify({
          message: "Initialize RevNote backup",
          content: encodeBase64(file.content),
        }),
      });
    },
    getDefaultBranch: async () => {
      const metadata = await githubRequest<{ default_branch?: string | null }>(base, token);
      return metadata.default_branch ?? null;
    },
  });
  branch = resolvedBranch.branch;
  const parentRef = resolvedBranch.parent.commitSha;
  const parentTree = resolvedBranch.parent.treeSha;

  const tree = await githubRequest<{ sha: string }>(`${base}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parentTree,
      tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
    }),
  });
  let commitSha = parentRef;
  if (tree.sha !== parentTree) {
    const commit = await githubRequest<{ sha: string }>(`${base}/git/commits`, token, {
      method: "POST",
      body: JSON.stringify({
        message: `RevNote backup · ${new Date().toISOString()}`,
        tree: tree.sha,
        parents: [parentRef],
        author: { name: "RevNote Backup", email: `${userId}@users.noreply.github.com` },
      }),
    });
    await githubRequest(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    commitSha = commit.sha;
  }

  const { error: stateError } = await admin.from("github_backup_state").upsert({
    user_id: userId,
    repository: repository.full_name,
    branch,
    commit_sha: commitSha,
    last_backup_at: new Date().toISOString(),
    note_count: backedUp.length,
  });
  if (stateError) throw stateError;

  if (connection.repository_full_name !== repository.full_name) {
    const { error } = await admin.from("github_connections").update({
      repository_full_name: repository.full_name,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    if (error) throw error;
  }

  return {
    ok: true,
    repository: repository.full_name,
    branch,
    commitSha,
    noteCount: backedUp.length,
  };
}

async function fetchAll<T>(query: { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: Error | null }> }) {
  const rows: T[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function encodeBase64(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
