import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
    ArrowDownToLine, ArrowUpRight, Check, CheckCheck, ChevronDown,
    CircleHelp, Clock3, Cloud, FilePlus2, FileText, GitBranch,
    Github, History, Inbox, Laptop, MoreHorizontal, Pin, PinOff, Search, Settings2, Sparkles,
    LoaderCircle, LogOut, Mail, RefreshCw, Trash2, Undo2, X,
} from "lucide-react";
import {createNote, deleteNote, reviseNote, restoreNote, selectRevision, setNotePreference} from "./domain/commands";
import type {NoteColor, Revision as RevisionValue} from "./domain/schema";
import type {GithubRepository, GithubStatus} from "./infrastructure/supabase";
import {
    exportLocalBackup, getLocalOwnerId, importLocalBackup,
    loadSnapshot, persistNewNote, persistNoteAndOperation, persistPreference, persistRevision,
} from "./infrastructure/indexed-db";
import {excerpt, formatFullDate, formatRelativeDate} from "./lib/utils";

type Filter = "all" | "pinned" | "trash";
const cloudConfigured = Boolean(import.meta.env.VITE_SUPABASE_URL && (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY));

const colors: { value: NoteColor; label: string }[] = [
    {value: "neutral", label: "默认"}, {value: "red", label: "珊瑚"}, {value: "orange", label: "杏橙"},
    {value: "yellow", label: "麦芽"}, {value: "green", label: "鼠尾草"}, {
        value: "blue",
        label: "雾蓝"
    }, {value: "purple", label: "丁香"},
];

function detectContext() {
    const ua = navigator.userAgent.toLowerCase();
    const os = ua.includes("android") ? "android" : ua.includes("iphone") || ua.includes("ipad") ? "ios" : ua.includes("windows") ? "windows" : ua.includes("mac os") ? "macos" : ua.includes("linux") ? "linux" : "unknown";
    const type = /iphone|android.*mobile/.test(ua) ? "phone" : /ipad|tablet/.test(ua) ? "tablet" : "desktop";
    return {
        time: {datetime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"},
        device: {type, os},
    } as const;
}

function childrenPerRevision(revisions: RevisionValue[]) {
    const result = new Map<string, number>();
    for (const revision of revisions) {
        if (revision.parentRevisionId) result.set(revision.parentRevisionId, (result.get(revision.parentRevisionId) ?? 0) + 1);
    }
    return result;
}

export default function App() {
    const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof loadSnapshot>> | null>(null);
    const [ownerId, setOwnerId] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const [query, setQuery] = useState("");
    const [draft, setDraft] = useState("");
    const [notice, setNotice] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(true);
    const [busy, setBusy] = useState(false);
    const [cloudEmail, setCloudEmail] = useState<string | null>(null);
    const [emailInput, setEmailInput] = useState("");
    const [magicLinkSent, setMagicLinkSent] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [backingUp, setBackingUp] = useState(false);
    const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
    const [githubRepositories, setGithubRepositories] = useState<GithubRepository[]>([]);
    const [githubBusy, setGithubBusy] = useState(false);
    const [githubStatusLoading, setGithubStatusLoading] = useState(false);
    const [githubPickerOpen, setGithubPickerOpen] = useState(false);
    const [isDraftSaving, setIsDraftSaving] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const syncingRef = useRef(false);
    const saveVersion = useRef(0);

    const reload = useCallback(async () => setSnapshot(await loadSnapshot()), []);

    const refreshGithubRepositories = useCallback(async (openPicker = true) => {
        setGithubBusy(true);
        try {
            const {listGithubRepositories} = await import("./infrastructure/supabase");
            const result = await listGithubRepositories();
            setGithubRepositories(result.repositories);
            if (openPicker) setGithubPickerOpen(true);
            return result.repositories;
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法读取 GitHub 仓库");
            return null;
        } finally {
            setGithubBusy(false);
        }
    }, []);

    useEffect(() => {
        let alive = true;
        Promise.all([getLocalOwnerId(), loadSnapshot()]).then(([id, data]) => {
            if (!alive) return;
            setOwnerId(id);
            setSnapshot(data);
            const latest = data.notes.filter((note) => note.status === "active").sort((a, b) => {
                const aRev = data.revisions.find((revision) => revision.id === a.currentRevisionId);
                const bRev = data.revisions.find((revision) => revision.id === b.currentRevisionId);
                return (bRev?.captureContext.time.datetime ?? b.createdAt).localeCompare(aRev?.captureContext.time.datetime ?? a.createdAt);
            })[0];
            if (latest) setSelectedId(latest.id);
        }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "无法读取本地笔记"));
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        if (!cloudConfigured) return;
        let alive = true;
        let unsubscribe: () => void = () => {
        };
        void import("./infrastructure/supabase").then(async ({getCloudEmail, subscribeToAuth}) => {
            if (!alive) return;
            const email = await getCloudEmail().catch(() => null);
            if (alive) setCloudEmail(email);
            unsubscribe = subscribeToAuth((nextEmail) => {
                if (alive) setCloudEmail(nextEmail);
            });
        }).catch(() => undefined);
        return () => {
            alive = false;
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        const url = new URL(window.location.href);
        const githubResult = url.searchParams.get("github");
        if (!githubResult) return;
        setNotice(githubResult === "connected" ? "GitHub 已连接，请选择备份仓库" : "GitHub 授权未完成，请重试并确认安装和授权的是同一个 GitHub 账号");
        url.searchParams.delete("github");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }, []);

    useEffect(() => {
        if (!cloudEmail) {
            setGithubStatus(null);
            setGithubRepositories([]);
            setGithubPickerOpen(false);
            setGithubStatusLoading(false);
            return;
        }
        let alive = true;
        setGithubStatus(null);
        setGithubRepositories([]);
        setGithubPickerOpen(false);
        setGithubStatusLoading(true);
        void import("./infrastructure/supabase").then(({getGithubStatus}) => getGithubStatus()).then((status) => {
            if (!alive) return;
            setGithubStatus(status);
            if (status.connection && !status.connection.repositoryId) {
                setGithubPickerOpen(true);
                void refreshGithubRepositories(false);
            }
        }).catch((error: unknown) => {
            if (alive) setNotice(error instanceof Error ? error.message : "无法读取 GitHub 连接状态");
        }).finally(() => {
            if (alive) setGithubStatusLoading(false);
        });
        return () => {
            alive = false;
        };
    }, [cloudEmail, refreshGithubRepositories]);

    const selectedNote = snapshot?.notes.find((note) => note.id === selectedId) ?? null;
    const selectedRevision = snapshot?.revisions.find((revision) => revision.id === selectedNote?.currentRevisionId) ?? null;
    const selectedPreference = snapshot?.preferences.find((preference) => preference.noteId === selectedId);
    const selectedRevisions = useMemo(() => snapshot?.revisions.filter((revision) => revision.noteId === selectedId)
        .sort((a, b) => b.captureContext.time.datetime.localeCompare(a.captureContext.time.datetime)) ?? [], [snapshot, selectedId]);
    const branchCounts = useMemo(() => childrenPerRevision(selectedRevisions), [selectedRevisions]);
    const hasBranches = [...branchCounts.values()].some((count) => count > 1);

    useEffect(() => {
        setDraft(selectedRevision?.content ?? "");
    }, [selectedId, selectedRevision?.id]);

    useEffect(() => {
        if (!snapshot || !selectedNote || !selectedRevision || selectedNote.status !== "active" || draft === selectedRevision.content) {
            setIsDraftSaving(false);
            return;
        }
        const version = ++saveVersion.current;
        setIsDraftSaving(true);
        const noteId = selectedNote.id;
        const content = draft;
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    const fresh = await loadSnapshot();
                    const note = fresh.notes.find((item) => item.id === noteId);
                    if (!note || note.status !== "active") return;
                    const revisions = fresh.revisions.filter((item) => item.noteId === note.id);
                    const change = reviseNote({note, revisions, content, captureContext: detectContext()});
                    await persistRevision(change.note, change.revision, change.operation);
                    await reload();
                } catch (error) {
                    setNotice(error instanceof Error ? error.message : "保存失败，请稍后重试");
                } finally {
                    if (saveVersion.current === version) setIsDraftSaving(false);
                }
            })();
        }, 420);
        return () => window.clearTimeout(timer);
    }, [draft, selectedNote, selectedRevision, snapshot, reload]);

    useEffect(() => {
        function onShortcut(event: KeyboardEvent) {
            if (!(event.metaKey || event.ctrlKey)) return;
            const key = event.key.toLowerCase();
            if (key === "k") {
                event.preventDefault();
                searchInput.current?.focus();
            } else if (key === "n") {
                event.preventDefault();
                void createBlankNote();
            }
        }

        window.addEventListener("keydown", onShortcut);
        return () => window.removeEventListener("keydown", onShortcut);
    });

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(""), 3200);
        return () => window.clearTimeout(timer);
    }, [notice]);

    const runSync = useCallback(async (showNotice = true) => {
        if (!ownerId || !cloudEmail || syncingRef.current) return;
        syncingRef.current = true;
        setSyncing(true);
        try {
            const {syncNow: sync} = await import("./infrastructure/supabase");
            const result = await sync(ownerId);
            await reload();
            if (showNotice && (result.pushed || result.pulled)) setNotice(`同步完成 · 上传 ${result.pushed} 项，拉取 ${result.pulled} 项${result.conflicts ? ` · ${result.conflicts} 个分支已保留` : ""}`);
        } catch (error) {
            if (showNotice) setNotice(error instanceof Error ? error.message : "同步失败，稍后会继续重试");
        } finally {
            syncingRef.current = false;
            setSyncing(false);
        }
    }, [ownerId, cloudEmail, reload]);

    useEffect(() => {
        if (cloudEmail && snapshot?.outbox.length) void runSync(false);
    }, [cloudEmail, snapshot?.outbox.length, runSync]);

    useEffect(() => {
        if (!cloudEmail || !cloudConfigured) return;
        let removeChannel: (() => void) | undefined;
        let alive = true;
        void import("./infrastructure/supabase").then(({subscribeToRemoteEvents}) => subscribeToRemoteEvents(() => {
            if (alive) void runSync(false);
        })).then((unsubscribe) => {
            if (alive) removeChannel = unsubscribe;
            else unsubscribe();
        }).catch(() => undefined);
        const onOnline = () => {
            if (alive) void runSync(false);
        };
        window.addEventListener("online", onOnline);
        return () => {
            alive = false;
            removeChannel?.();
            window.removeEventListener("online", onOnline);
        };
    }, [cloudEmail, runSync]);

    const noteRows = useMemo(() => {
        if (!snapshot) return [];
        return snapshot.notes.filter((note) => {
            if (filter === "trash") return note.status === "deleted";
            if (note.status !== "active") return false;
            if (filter === "pinned" && !snapshot.preferences.find((preference) => preference.noteId === note.id)?.pinned) return false;
            if (!query.trim()) return true;
            const revisions = snapshot.revisions.filter((revision) => revision.noteId === note.id);
            const current = revisions.find((revision) => revision.id === note.currentRevisionId);
            const preference = snapshot.preferences.find((item) => item.noteId === note.id);
            const haystack = [current?.content, current?.captureContext.place?.city, current?.author.name, preference?.color, current?.captureContext.time.datetime].join(" ").toLowerCase();
            return haystack.includes(query.toLowerCase());
        }).sort((a, b) => {
            const pinnedA = snapshot.preferences.find((item) => item.noteId === a.id)?.pinned ? 1 : 0;
            const pinnedB = snapshot.preferences.find((item) => item.noteId === b.id)?.pinned ? 1 : 0;
            if (filter !== "trash" && pinnedA !== pinnedB) return pinnedB - pinnedA;
            const revisionA = snapshot.revisions.find((revision) => revision.id === a.currentRevisionId);
            const revisionB = snapshot.revisions.find((revision) => revision.id === b.currentRevisionId);
            return (revisionB?.captureContext.time.datetime ?? b.createdAt).localeCompare(revisionA?.captureContext.time.datetime ?? a.createdAt);
        });
    }, [snapshot, filter, query]);

    async function createBlankNote() {
        if (!ownerId) return;
        try {
            const created = createNote({ownerId, content: "", captureContext: detectContext()});
            await persistNewNote(created.note, created.revision, created.operation);
            await reload();
            setSelectedId(created.note.id);
            setFilter("all");
            setQuery("");
            setDraft("");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法创建笔记");
        }
    }

    async function togglePinned() {
        if (!selectedNote || !ownerId) return;
        try {
            const update = setNotePreference({
                userId: ownerId,
                noteId: selectedNote.id,
                previous: selectedPreference,
                pinned: !selectedPreference?.pinned
            });
            await persistPreference(update.preference, update.operation);
            await reload();
        } catch {
            setNotice("无法更新笔记偏好");
        }
    }

    async function setColor(color: NoteColor) {
        if (!selectedNote || !ownerId) return;
        try {
            const update = setNotePreference({
                userId: ownerId,
                noteId: selectedNote.id,
                previous: selectedPreference,
                color
            });
            await persistPreference(update.preference, update.operation);
            await reload();
        } catch {
            setNotice("无法更新笔记颜色");
        }
    }

    async function changeLifecycle(action: "delete" | "restore") {
        if (!selectedNote) return;
        try {
            const result = action === "delete" ? deleteNote(selectedNote) : restoreNote(selectedNote);
            await persistNoteAndOperation(result.note, result.operation);
            await reload();
            if (action === "delete") {
                setSelectedId(null);
                setFilter("all");
            }
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "操作失败");
        }
    }

    async function switchRevision(revision: RevisionValue) {
        if (!selectedNote || revision.id === selectedNote.currentRevisionId) return;
        try {
            const result = selectRevision({note: selectedNote, revisions: selectedRevisions, revisionId: revision.id});
            await persistNoteAndOperation(result.note, result.operation);
            await reload();
            setNotice("已切换到这个版本，之后的修改会从此处继续");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法切换版本");
        }
    }

    async function downloadBackup() {
        try {
            const data = await exportLocalBackup();
            const blob = new Blob([JSON.stringify({
                format: "jianjian-backup",
                version: 1,
                exportedAt: new Date().toISOString(),
                data
            }, null, 2)], {type: "application/json"});
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `jianjian-backup-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(url);
            setNotice("本地备份已导出");
        } catch {
            setNotice("导出失败，请重试");
        }
    }

    async function requestSignInLink() {
        if (!emailInput.trim()) {
            setNotice("请先填写邮箱地址");
            return;
        }
        setBusy(true);
        try {
            const {sendSignInLink} = await import("./infrastructure/supabase");
            await sendSignInLink(emailInput.trim());
            setMagicLinkSent(true);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法发送登录链接");
        } finally {
            setBusy(false);
        }
    }

    async function backupToGithub() {
        if (!cloudEmail || backingUp) return;
        setBackingUp(true);
        try {
            if (!githubStatus?.connection?.repositoryId) throw new Error("请先连接 GitHub 并选择备份仓库");
            await runSync(false);
            const fresh = await loadSnapshot();
            if (fresh.outbox.length) throw new Error("还有笔记等待云端同步，请联网并稍后重试 GitHub 备份");
            const {backupToGithub: backup} = await import("./infrastructure/supabase");
            const result = await backup();
            setNotice(`已备份 ${result.noteCount} 条笔记到 ${result.repository} · ${result.commitSha.slice(0, 7)}`);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "GitHub 备份失败");
        } finally {
            setBackingUp(false);
        }
    }

    async function connectGithub() {
        setGithubBusy(true);
        try {
            const {startGithubConnection} = await import("./infrastructure/supabase");
            const {installUrl} = await startGithubConnection();
            window.location.assign(installUrl);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法开始 GitHub 授权");
        } finally {
            setGithubBusy(false);
        }
    }

    async function chooseGithubRepository(repositoryId: string) {
        if (!repositoryId) return;
        setGithubBusy(true);
        try {
            const {selectGithubRepository} = await import("./infrastructure/supabase");
            const {connection} = await selectGithubRepository(repositoryId);
            setGithubStatus((previous) => previous ? {...previous, connection} : previous);
            setGithubPickerOpen(false);
            const repositoryName = githubRepositories.find((repository) => repository.id === repositoryId)?.fullName;
            setNotice(`GitHub 备份仓库已设为 ${repositoryName ?? connection.repositoryFullName}`);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法选择 GitHub 仓库");
        } finally {
            setGithubBusy(false);
        }
    }

    async function disconnectGithub() {
        setGithubBusy(true);
        try {
            const {disconnectGithub: disconnect} = await import("./infrastructure/supabase");
            await disconnect();
            setGithubStatus((previous) => previous ? {...previous, connection: null} : previous);
            setGithubRepositories([]);
            setGithubPickerOpen(false);
            setNotice("已断开 revnote 与 GitHub 的连接");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法断开 GitHub 连接");
        } finally {
            setGithubBusy(false);
        }
    }

    async function restoreBackup(file?: File) {
        if (!file) return;
        if (!window.confirm("导入备份会替换此浏览器中的全部笔记和版本记录。建议先导出现有数据。继续吗？")) return;
        setBusy(true);
        try {
            const parsed = JSON.parse(await file.text()) as { format?: string; data?: unknown };
            if (parsed.format !== "jianjian-backup" || !parsed.data) throw new Error("这不是 revnote 的有效备份文件");
            await importLocalBackup(parsed.data);
            await reload();
            setSelectedId(null);
            setNotice("备份已恢复");
            setSettingsOpen(false);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "无法读取备份文件");
        } finally {
            setBusy(false);
            if (fileInput.current) fileInput.current.value = "";
        }
    }

    if (!snapshot) return <div className="boot-screen">
        <div className="brand-mark"><FileText size={19}/></div>
        <span>正在打开你的笔记…</span></div>;

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="sidebar-top">
                    <div className="brand-row">
                        <div className="brand-mark"><FileText size={18} strokeWidth={2.2}/></div>
                        <div className="brand-copy"><span className="brand-name">revnote</span><span
                            className="brand-caption">留住每一个念头</span></div>
                        <button className="icon-button subtle brand-menu" aria-label="设置"
                                onClick={() => setSettingsOpen(true)}><Settings2 size={17}/></button>
                    </div>
                    <div className="search-wrap"><Search size={15}/><input ref={searchInput} value={query}
                                                                           onChange={(event) => setQuery(event.target.value)}
                                                                           placeholder="搜索笔记"
                                                                           aria-label="搜索笔记"/><kbd>⌘ K</kbd></div>
                    <button className="new-note-button" onClick={() => void createBlankNote()}><FilePlus2
                        size={16}/><span>写一条新笔记</span><span className="shortcut">⌘ N</span></button>
                    <nav className="nav-list" aria-label="笔记筛选">
                        <button className={`nav-item ${filter === "all" ? "active" : ""}`}
                                onClick={() => setFilter("all")}><Inbox size={16}/><span>所有笔记</span><span
                            className="nav-count">{snapshot.notes.filter((note) => note.status === "active").length}</span>
                        </button>
                        <button className={`nav-item ${filter === "pinned" ? "active" : ""}`}
                                onClick={() => setFilter("pinned")}><Pin size={15}/><span>已固定</span></button>
                        <button className={`nav-item ${filter === "trash" ? "active" : ""}`} onClick={() => {
                            setFilter("trash");
                            setSelectedId(null);
                        }}><Trash2 size={15}/><span>回收站</span><span
                            className="nav-count">{snapshot.notes.filter((note) => note.status === "deleted").length || ""}</span>
                        </button>
                    </nav>
                </div>

                <div className="notes-list-heading">
                    <span>{filter === "trash" ? "最近删除" : filter === "pinned" ? "固定的笔记" : "最近记录"}</span>
                    <button className="icon-button tiny" aria-label="更多" onClick={() => setSettingsOpen(true)}>
                        <MoreHorizontal size={17}/></button>
                </div>
                <div className="notes-list">
                    {noteRows.map((note) => {
                        const current = snapshot.revisions.find((revision) => revision.id === note.currentRevisionId);
                        const preference = snapshot.preferences.find((item) => item.noteId === note.id);
                        const revisions = snapshot.revisions.filter((item) => item.noteId === note.id);
                        const branch = [...childrenPerRevision(revisions).values()].some((count) => count > 1);
                        return <button key={note.id} className={`note-row ${selectedId === note.id ? "selected" : ""}`}
                                       onClick={() => setSelectedId(note.id)}>
                            <span className={`note-color-dot color-${preference?.color ?? "neutral"}`}/>
                            <span className="note-row-body"><span
                                className="note-preview">{excerpt(current?.content ?? "")}</span><span
                                className="note-row-meta">{formatRelativeDate(current?.captureContext.time.datetime ?? note.createdAt)}{branch &&
                                <span className="branch-mini"><GitBranch size={11}/> 分支</span>}</span></span>
                            {preference?.pinned && <Pin size={12} className="row-pin"/>}
                        </button>;
                    })}
                    {noteRows.length === 0 && <div className="list-empty">
                        <div className="empty-glyph"><FileText size={18}/></div>
                        <span>{query ? "没有找到匹配的笔记" : filter === "trash" ? "回收站是空的" : filter === "pinned" ? "还没有固定笔记" : "还没有笔记"}</span>{!query && filter === "all" &&
                        <button onClick={() => void createBlankNote()}>开始记录 <ArrowUpRight size={13}/></button>}
                    </div>}
                </div>
                <div className="sidebar-bottom">
                    <div className="sync-card">
                        <div className="sync-card-icon"><Cloud size={15}/></div>
                        <div className="sync-copy">
                            <strong>{cloudEmail ? "已连接云端" : "只保存在此设备"}</strong><span>{cloudEmail ? (snapshot.outbox.length ? `${snapshot.outbox.length} 项等待同步` : "多设备同步已开启") : snapshot.outbox.length ? `${snapshot.outbox.length} 项等待同步` : "本地保存已开启"}</span>
                        </div>
                        <span className={`sync-dot ${cloudEmail ? "connected" : ""}`}/></div>
                    <button className="profile-row" onClick={() => setSettingsOpen(true)}>
                        <div className="avatar">我</div>
                        <span><strong>我的空间</strong><small>私人笔记</small></span><ChevronDown size={14}
                                                                                                  className="profile-chevron"/>
                    </button>
                </div>
            </aside>

            <main className="workspace">
                <header className="topbar">
                    <div className="breadcrumbs"><span>revnote</span><span className="crumb-slash">/</span><span
                        className="crumb-current">{filter === "trash" ? "回收站" : selectedNote ? "笔记" : "所有笔记"}</span>
                    </div>
                    <div className="topbar-actions">
                        <div className="saved-state">{syncing ? <LoaderCircle className="spin" size={13}/> : <span
                            className="saved-dot"/>}{syncing ? "正在同步" : cloudEmail ? (snapshot.outbox.length ? "等待云端同步" : "已与云端连接") : "仅本地保存"}</div>
                        {cloudEmail &&
                            <button className="icon-button" onClick={() => void runSync()} aria-label="立即同步">
                                <RefreshCw size={15}/></button>}
                        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="打开设置">
                            <Settings2 size={17}/></button>
                        <button className="help-button" aria-label="帮助"><CircleHelp size={16}/></button>
                    </div>
                </header>

                {selectedNote && selectedRevision ? <div className="editor-layout">
                    <section className={`editor-main paper-${selectedPreference?.color ?? "neutral"}`}>
                        <div className="editor-toolbar">
                            <div className="note-date"><span className="date-mark"><FileText
                                size={14}/></span><span>{formatFullDate(selectedRevision.captureContext.time.datetime)}</span><span
                                className="date-separator">·</span><span>{selectedRevision.captureContext.time.timezone}</span>
                            </div>
                            <div className="editor-actions">
                                <div className="color-control" aria-label="笔记颜色">{colors.map((color) => <button
                                    key={color.value}
                                    className={`color-choice color-${color.value} ${selectedPreference?.color === color.value || (!selectedPreference?.color && color.value === "neutral") ? "chosen" : ""}`}
                                    aria-label={`设置颜色：${color.label}`} title={color.label}
                                    onClick={() => void setColor(color.value)}/>)}</div>
                                {selectedNote.status === "active" &&
                                    <button className={`icon-button ${selectedPreference?.pinned ? "pinned" : ""}`}
                                            onClick={() => void togglePinned()}
                                            aria-label={selectedPreference?.pinned ? "取消固定" : "固定笔记"}>{selectedPreference?.pinned ?
                                        <Pin size={16}/> : <PinOff size={16}/>}</button>}
                                <button className="icon-button history-toggle"
                                        onClick={() => setHistoryOpen((open) => !open)} aria-label="版本历史"><History
                                    size={16}/></button>
                                <button className="icon-button"
                                        onClick={() => void changeLifecycle(selectedNote.status === "active" ? "delete" : "restore")}
                                        aria-label={selectedNote.status === "active" ? "移入回收站" : "恢复笔记"}>{selectedNote.status === "active" ?
                                    <Trash2 size={16}/> : <Undo2 size={16}/>}</button>
                            </div>
                        </div>
                        {hasBranches && <div className="branch-alert"><GitBranch
                            size={15}/><span>这条笔记有多个版本分支，所有内容都已保留。</span>
                            <button onClick={() => setHistoryOpen(true)}>查看分支</button>
                        </div>}
                        {selectedNote.status === "deleted" &&
                            <div className="trash-alert"><Trash2 size={14}/><span>这条笔记在回收站中。</span>
                                <button onClick={() => void changeLifecycle("restore")}>恢复笔记</button>
                            </div>}
                        <div className="editor-content-wrap"><textarea className="note-editor" value={draft}
                                                                       onChange={(event) => setDraft(event.target.value)}
                                                                       onKeyDown={(event) => {
                                                                           if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                                                               event.preventDefault();
                                                                               const input = event.currentTarget;
                                                                               const start = input.selectionStart;
                                                                               const end = input.selectionEnd;
                                                                               const next = `${draft.slice(0, start)}\n${draft.slice(end)}`;
                                                                               setDraft(next);
                                                                               requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
                                                                           }
                                                                       }} placeholder="把脑海里的念头写下来…" spellCheck
                                                                       lang="zh-CN"
                                                                       readOnly={selectedNote.status === "deleted"}
                                                                       autoFocus={selectedRevisions.length === 1 && selectedRevision.content === ""}/>
                            <div className="editor-hint">
                                <span>没有标题，只有你想记下的事。</span><span><kbd>⌘</kbd> + <kbd>Enter</kbd> 换行</span>
                            </div>
                        </div>
                        <footer className="editor-footer">
                            <div className="capture-info"><span
                                className="capture-avatar">{selectedRevision.author.type === "human" ? "你" : selectedRevision.author.type === "llm" ? "AI" : "程"}</span><span>{selectedRevision.author.name ?? (selectedRevision.author.type === "human" ? "你" : selectedRevision.author.type)}</span><span
                                className="footer-sep">·</span><Laptop
                                size={13}/><span>{selectedRevision.captureContext.device?.os ?? "unknown"}</span>{selectedRevision.captureContext.place?.city && <>
                                <span
                                    className="footer-sep">·</span><span>{selectedRevision.captureContext.place.city}</span></>}
                            </div>
                            <div className="content-stats"><span>{[...draft].length} 字</span><span
                                className="footer-sep">·</span>{isDraftSaving ?
                                <LoaderCircle className="spin" size={13}/> :
                                <CheckCheck size={14}/>}<span>{isDraftSaving ? "正在保存" : "已保存在此设备"}</span>
                            </div>
                        </footer>
                    </section>

                    {historyOpen && <aside className="history-panel">
                        <div className="history-heading">
                            <div><span className="eyebrow">NOTE HISTORY</span><h2>版本记录</h2></div>
                            <button className="icon-button tiny" onClick={() => setHistoryOpen(false)}
                                    aria-label="关闭版本记录"><X size={15}/></button>
                        </div>
                        <div className="history-summary">
                            <div className="history-summary-icon"><Clock3 size={16}/></div>
                            <div><strong>{selectedRevisions.length} 个版本</strong><span>每次修改都会留下记录</span>
                            </div>
                        </div>
                        <div className="history-timeline">{selectedRevisions.map((revision, index) => {
                            const current = revision.id === selectedNote.currentRevisionId;
                            const isBranch = (branchCounts.get(revision.parentRevisionId ?? "") ?? 0) > 1;
                            return <div className={`history-item ${current ? "current" : ""}`} key={revision.id}>
                                <div className="timeline-rail"><span className="timeline-node">{current ?
                                    <Check size={10}/> : null}</span>{index < selectedRevisions.length - 1 &&
                                    <span className="timeline-line"/>}</div>
                                <button className="history-card" onClick={() => void switchRevision(revision)}><span
                                    className="history-card-top"><strong>{current ? "当前版本" : formatRelativeDate(revision.captureContext.time.datetime)}</strong>{isBranch &&
                                    <span className="branch-tag"><GitBranch size={10}/> 分支</span>}{current &&
                                    <span className="current-tag">当前</span>}</span><span
                                    className="history-card-time">{new Intl.DateTimeFormat("zh-CN", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit"
                                }).format(new Date(revision.captureContext.time.datetime))} · {[...revision.content].length} 字</span><span
                                    className="history-excerpt">{excerpt(revision.content, 90)}</span>{!current &&
                                    <span className="restore-link">切换到此版本 <ArrowUpRight size={12}/></span>}
                                </button>
                            </div>;
                        })}</div>
                        <div className="history-note"><Sparkles
                            size={14}/><span>版本不可覆盖。你可以随时回到任意一次修改。</span></div>
                    </aside>}
                </div> : <EmptyWorkspace onCreate={() => void createBlankNote()} filter={filter}/>}
            </main>

            {notice && <div className="toast" role="status"><Check size={15}/>{notice}
                <button className="icon-button tiny" onClick={() => setNotice("")} aria-label="关闭通知"><X size={14}/>
                </button>
            </div>}

            <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}><Dialog.Portal><Dialog.Overlay
                className="dialog-overlay"/><Dialog.Content className="settings-dialog">
                <div className="dialog-head">
                    <div className="settings-icon"><Settings2 size={17}/></div>
                    <div>
                        <Dialog.Title>设置与数据</Dialog.Title><Dialog.Description>你的笔记保存在当前浏览器。</Dialog.Description>
                    </div>
                    <Dialog.Close className="icon-button tiny dialog-close" aria-label="关闭"><X
                        size={15}/></Dialog.Close></div>
                <div className="settings-section"><span className="settings-label">数据安全</span>
                    <button className="settings-action" onClick={() => void downloadBackup()}><span
                        className="settings-action-icon"><ArrowDownToLine
                        size={16}/></span><span><strong>导出本地备份</strong><small>下载包含笔记、版本和偏好的 JSON 文件</small></span><ArrowUpRight
                        size={14}/></button>
                    <button className="settings-action" onClick={() => fileInput.current?.click()} disabled={busy}><span
                        className="settings-action-icon"><Undo2
                        size={16}/></span><span><strong>从备份恢复</strong><small>使用 revnote JSON 备份替换当前数据</small></span><ArrowUpRight
                        size={14}/></button>
                    <input ref={fileInput} type="file" accept="application/json,.json" hidden
                           onChange={(event) => void restoreBackup(event.target.files?.[0])}/></div>
                <div className="settings-section"><span className="settings-label">多设备同步</span>{!cloudConfigured ?
                    <div className="sync-explainer">
                        <div className="sync-card-icon"><Cloud size={15}/></div>
                        <div><strong>本地优先模式</strong><p>云端同步尚未配置。配置 Supabase
                            环境变量并应用数据库迁移后，即可通过邮箱链接开启同步。</p></div>
                    </div> : cloudEmail ? <>
                        <div className="sync-explainer">
                            <div className="sync-card-icon"><Cloud size={15}/></div>
                            <div><strong>{cloudEmail}</strong>
                                <p>离线修改会先保存在此设备，联网后自动补传。冲突版本会完整保留。</p></div>
                        </div>
                        <div className="github-panel">
                            <div className="github-panel-heading">
                                <div className="github-panel-icon"><Github size={15}/></div>
                                <div><strong>备份到个人 GitHub 仓库</strong><p>每位用户独立授权并选择自己的仓库，建议使用私有仓库。</p></div>
                            </div>
                            {githubStatusLoading ? <div className="github-status-line"><LoaderCircle className="spin" size={13}/>正在读取 GitHub 连接…</div> :
                                !githubStatus?.configured ? <p className="github-help">GitHub App 尚未配置，请联系应用管理员。</p> :
                                    !githubStatus.connection ? <div className="github-connect-row">
                                        <button className="backup-github-button" onClick={() => void connectGithub()} disabled={githubBusy}>
                                            {githubBusy ? <LoaderCircle className="spin" size={13}/> : <Github size={13}/>}连接我的 GitHub
                                        </button>
                                        <span>安装 App 后再选择要备份的仓库</span>
                                    </div> : <>
                                        <div className="github-status-line"><span className="github-connected-dot"/>已连接 @{githubStatus.connection.installationAccountLogin}
                                            <span className="github-repository-name">{githubStatus.connection.repositoryFullName ?? "尚未选择仓库"}</span>
                                        </div>
                                        <div className="github-management-row">
                                            <button className="github-link-button" onClick={() => void refreshGithubRepositories(true)} disabled={githubBusy}>
                                                {githubBusy ? "读取中…" : githubStatus.connection.repositoryId ? "更换仓库" : "选择仓库"}
                                            </button>
                                            <button className="github-link-button" onClick={() => void connectGithub()} disabled={githubBusy}>更换 GitHub 账号</button>
                                            <button className="github-link-button muted" onClick={() => void disconnectGithub()} disabled={githubBusy}>断开</button>
                                        </div>
                                        {githubPickerOpen && <div className="github-repository-picker">
                                            {githubRepositories.length ? <select aria-label="GitHub 备份仓库" value={githubStatus.connection.repositoryId ?? ""}
                                                                                onChange={(event) => void chooseGithubRepository(event.target.value)} disabled={githubBusy}>
                                                <option value="" disabled>选择一个已授权的仓库</option>
                                                {githubRepositories.map((repository) => <option key={repository.id} value={repository.id}>
                                                    {repository.fullName}{repository.private ? " · 私有" : " · 公开"}
                                                </option>)}
                                            </select> : <span>{githubBusy ? "正在加载仓库…" : "没有可用仓库；请检查 GitHub App 的仓库访问权限。"}</span>}
                                        </div>}
                                    </>}
                        </div>
                        <div className="cloud-buttons">
                            <button className="sync-now-button" onClick={() => void runSync()}
                                    disabled={syncing}>{syncing ? <LoaderCircle className="spin" size={14}/> :
                                <RefreshCw size={14}/>}{syncing ? "同步中" : "立即同步"}</button>
                            <button className="backup-github-button" onClick={() => void backupToGithub()}
                                    disabled={backingUp || !githubStatus?.connection?.repositoryId || githubStatusLoading}>{backingUp ? <LoaderCircle className="spin" size={13}/> :
                                <ArrowDownToLine size={13}/>}{backingUp ? "备份中" : "GitHub 备份"}</button>
                            <button className="sign-out-button"
                                    onClick={() => void import("./infrastructure/supabase").then(({signOutCloud}) => signOutCloud()).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "无法退出登录"))}>
                                <LogOut size={13}/>退出登录
                            </button>
                        </div>
                        <div className="outbox-count"><span>待同步操作</span><strong>{snapshot.outbox.length}</strong>
                        </div>
                    </> : <>
                        <form className="cloud-login" onSubmit={(event) => {
                            event.preventDefault();
                            void requestSignInLink();
                        }}><label htmlFor="sync-email">使用邮箱登录</label>
                            <div className="cloud-login-row"><span className="email-input-icon"><Mail size={14}/></span><input
                                id="sync-email" type="email" value={emailInput} onChange={(event) => {
                                setEmailInput(event.target.value);
                                setMagicLinkSent(false);
                            }} placeholder="you@example.com" required/>
                                <button type="submit" disabled={busy}>{busy ?
                                    <LoaderCircle className="spin" size={14}/> : "发送链接"}</button>
                            </div>
                            {magicLinkSent ? <p className="magic-link-sent">登录链接已发送，请查看邮箱。</p> :
                                <p>我们会发送一次性登录链接，不需要设置密码。</p>}</form>
                        <div className="outbox-count"><span>待同步操作</span><strong>{snapshot.outbox.length}</strong>
                        </div>
                    </>}
                    <div className="settings-footnote">GitHub 安装令牌只在服务端使用。断开连接不会卸载 GitHub App；如需撤销仓库权限，请在 GitHub 设置中卸载该 App。笔记跨设备同步仍由 Supabase 完成。
                    </div>
                </div>
                <div className="dialog-footer"><span>revnote · Web 版</span><span>版本 0.1.0</span></div>
            </Dialog.Content></Dialog.Portal></Dialog.Root>
        </div>
    );
}

function EmptyWorkspace({onCreate, filter}: { onCreate: () => void; filter: Filter }) {
    return <section className="empty-workspace">
        <div className="empty-decoration">
            <div className="empty-paper paper-blue"><span/><span/><span/></div>
            <div className="empty-paper paper-yellow"><span/><span/><span/></div>
            <div className="empty-paper paper-purple"><span/><span/><span/></div>
            <div className="empty-main-icon"><FileText size={24}/></div>
            <div className="sparkle sparkle-one">✳</div>
            <div className="sparkle sparkle-two">✦</div>
        </div>
        <div className="empty-copy"><span className="eyebrow">A QUIET PLACE FOR YOUR THOUGHTS</span>
            <h1>{filter === "trash" ? "回收站是空的" : "给念头一个落脚处"}</h1>
            <p>{filter === "trash" ? "删除的笔记会在这里等待你。" : "不必整理，也不用起标题。想到什么，就写下来。"}</p>{filter !== "trash" &&
                <button className="new-note-button empty-create" onClick={onCreate}><FilePlus2 size={16}/>写下第一条笔记<ArrowUpRight
                    size={14}/></button>}
            <div className="privacy-note"><span className="privacy-lock">⌑</span>每次修改都会保存为新版本 · 数据留在你的设备
            </div>
        </div>
    </section>;
}
