import { createInstallationToken, GithubApiError, githubRequest, listInstallationRepositories } from "../_shared/github.ts";
import { createAdminClient, FunctionError, jsonResponse, requireAuthenticatedUser } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST" }, 405, corsHeaders);

  try {
    const { supabase, user } = await requireAuthenticatedUser(request);
    const admin = createAdminClient();
    const { data: connection, error: connectionError } = await admin.from("github_connections")
      .select("installation_id, installation_account_login, repository_id, repository_full_name")
      .eq("user_id", user.id)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection?.repository_id) throw new FunctionError("請先连接 GitHub 并选择备份仓库", 409);

    const token = await createInstallationToken(connection.installation_id as string);
    const repositories = await listInstallationRepositories(token);
    const repository = repositories.find((item) => String(item.id) === String(connection.repository_id));
    if (!repository) throw new FunctionError("目标仓库已不在 GitHub App 的授权范围内，请重新选择", 409);
    const [owner, repositoryName] = repository.full_name.split("/");
    if (!owner || !repositoryName) throw new Error("GitHub returned an invalid repository name");
    if (owner.toLowerCase() !== String(connection.installation_account_login).toLowerCase()) {
      throw new FunctionError("目标仓库不属于当前连接的 GitHub 个人账号", 403);
    }
    const branch = repository.default_branch || "main";

    const [notes, preferences] = await Promise.all([
      fetchAll(supabase.from("notes").select("id, current_revision_id, created_at, status").eq("owner_id", user.id)),
      fetchAll(supabase.from("note_user_preferences").select("note_id, color, pinned").eq("user_id", user.id)),
    ]);
    const revisionIds = notes.map((note) => note.current_revision_id).filter((id): id is string => Boolean(id));
    const revisionResults = await Promise.all(chunks(revisionIds, 200).map((ids) =>
      supabase.from("note_revisions")
        .select("id, note_id, parent_revision_id, content, captured_at, timezone, city, device_type, os, author_type, author_name")
        .eq("owner_id", user.id)
        .in("id", ids)
    ));
    for (const result of revisionResults) if (result.error) throw result.error;

    const revisionById = new Map(revisionResults.flatMap((result) => result.data ?? []).map((revision) => [revision.id, revision]));
    const preferenceByNote = new Map(preferences.map((preference) => [preference.note_id, preference]));
    const backupPrefix = `users/${user.id}`;
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
      content: `# RevNote backup\n\nThis folder contains the current revision of each note for account \`${user.id}\`, including notes in the trash.\n\n- Notes are readable Markdown files under \`notes/\`.\n- Capture context, lifecycle status, and note preferences are in \`metadata/\`.\n`,
    });
    files.push({
      path: `${backupPrefix}/manifest.json`,
      content: `${JSON.stringify({ format: "rev-note-github-backup", version: 1, noteCount: backedUp.length, noteIds: backedUp }, null, 2)}\n`,
    });

    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;
    let parentRef: string | null = null;
    let parentTree: string | null = null;
    try {
      const ref = await githubRequest<{ object: { sha: string } }>(`${base}/git/ref/heads/${encodeURIComponent(branch)}`, token);
      const parent = await githubRequest<{ tree: { sha: string } }>(`${base}/git/commits/${ref.object.sha}`, token);
      parentRef = ref.object.sha;
      parentTree = parent.tree.sha;
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.status !== 404) throw error;
    }

    const tree = await githubRequest<{ sha: string }>(`${base}/git/trees`, token, {
      method: "POST",
      body: JSON.stringify({
        ...(parentTree ? { base_tree: parentTree } : {}),
        tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
      }),
    });
    let commitSha = parentRef ?? "";
    if (!parentRef || tree.sha !== parentTree) {
      const commit = await githubRequest<{ sha: string }>(`${base}/git/commits`, token, {
        method: "POST",
        body: JSON.stringify({
          message: `RevNote backup · ${new Date().toISOString()}`,
          tree: tree.sha,
          parents: parentRef ? [parentRef] : [],
          author: { name: "RevNote Backup", email: `${user.id}@users.noreply.github.com` },
        }),
      });
      if (parentRef) {
        await githubRequest(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: false }),
        });
      } else {
        await githubRequest(`${base}/git/refs`, token, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
        });
      }
      commitSha = commit.sha;
    }

    const { error: stateError } = await admin.from("github_backup_state").upsert({
      user_id: user.id,
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
      }).eq("user_id", user.id);
      if (error) throw error;
    }
    return jsonResponse({
      ok: true,
      repository: repository.full_name,
      branch,
      commitSha,
      noteCount: backedUp.length,
    }, 200, corsHeaders);
  } catch (error) {
    console.error("github-backup failed", error);
    const status = error instanceof FunctionError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Backup failed";
    return jsonResponse({ error: message }, status, corsHeaders);
  }
});

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
