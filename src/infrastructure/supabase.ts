import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  acknowledgeOperations, applyRemoteEvents, loadSnapshot,
  type RemoteSyncEvent,
} from "./indexed-db";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseApiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;

export const cloudConfigured = Boolean(supabaseUrl && supabaseApiKey);
let client: SupabaseClient | null = null;

function getClient() {
  if (!cloudConfigured) throw new Error("尚未配置 Supabase。请填写 .env.local 后重启应用。");
  client ??= createClient(supabaseUrl!, supabaseApiKey!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function getCloudEmail(): Promise<string | null> {
  if (!cloudConfigured) return null;
  const { data, error } = await getClient().auth.getSession();
  if (error) throw error;
  return data.session?.user.email ?? null;
}

export function subscribeToAuth(listener: (email: string | null) => void) {
  if (!cloudConfigured) return () => undefined;
  const { data } = getClient().auth.onAuthStateChange((_event, session) => listener(session?.user.email ?? null));
  return () => data.subscription.unsubscribe();
}

export async function sendSignInLink(email: string): Promise<void> {
  const { error } = await getClient().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOutCloud(): Promise<void> {
  const { error } = await getClient().auth.signOut();
  if (error) throw error;
}

export async function backupToGithub(): Promise<{ repository: string; branch: string; commitSha: string; noteCount: number }> {
  const { data, error } = await getClient().functions.invoke("github-backup", { body: {} });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error ?? "GitHub 备份失败");
  return data;
}

export interface GithubConnection {
  installationAccountLogin: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
}

export interface GithubStatus {
  configured: boolean;
  connection: GithubConnection | null;
}

export interface GithubRepository {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

export async function getGithubStatus(): Promise<GithubStatus> {
  return githubAccount<GithubStatus>({ action: "status" });
}

export async function startGithubConnection(): Promise<{ installUrl: string }> {
  return githubAccount<{ installUrl: string }>({ action: "start" });
}

export async function listGithubRepositories(): Promise<{ repositories: GithubRepository[]; selectedRepositoryId: string | null }> {
  return githubAccount<{ repositories: GithubRepository[]; selectedRepositoryId: string | null }>({ action: "repositories" });
}

export async function selectGithubRepository(repositoryId: string): Promise<{ connection: GithubConnection }> {
  return githubAccount<{ connection: GithubConnection }>({ action: "select-repository", repositoryId });
}

export async function disconnectGithub(): Promise<void> {
  await githubAccount({ action: "disconnect" });
}

async function githubAccount<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().functions.invoke<T & { error?: string }>("github-account", { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as T;
}

export async function subscribeToRemoteEvents(listener: () => void): Promise<() => void> {
  const supabase = getClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) return () => undefined;
  const channel = supabase.channel(`note-sync-${data.user.id}`)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "sync_events", filter: `owner_id=eq.${data.user.id}`,
    }, listener)
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

export async function syncNow(localOwnerId: string): Promise<{ pushed: number; pulled: number; conflicts: number }> {
  const supabase = getClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error("请先登录，再同步笔记。");
  if (!navigator.onLine) throw new Error("当前没有网络连接，笔记仍保存在此设备。");

  let pushed = 0;
  let conflicts = 0;
  const local = await loadSnapshot();
  for (const operation of [...local.outbox].sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0))) {
    const { error } = await supabase.rpc("push_note_operation", {
      p_client_op_id: operation.clientOpId,
      p_event_type: operation.type,
      p_note_id: operation.noteId,
      p_payload: operation.payload,
    });
    if (error) throw error;
    await acknowledgeOperations([operation.clientOpId]);
    pushed++;
  }

  let snapshot = await loadSnapshot();
  let after = snapshot.lastPulledSeq;
  let pulled = 0;
  while (true) {
    const { data, error } = await supabase.rpc("pull_sync_events", { p_after: after, p_limit: 200 });
    if (error) throw error;
    const events = (data ?? []) as RemoteSyncEvent[];
    if (events.length === 0) break;
    const result = await applyRemoteEvents(events, localOwnerId);
    pulled += result.applied;
    conflicts += result.conflicts;
    after = Math.max(...events.map((event) => Number(event.server_seq)));
    snapshot = await loadSnapshot();
    if (events.length < 200) break;
  }
  return { pushed, pulled, conflicts };
}
