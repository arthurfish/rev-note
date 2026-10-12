# RevNote（简笺）

一款本地优先、无标题的极简笔记 Web 应用。每次编辑都会追加一个不可变版本；回收站只改变笔记生命周期，不删除版本。Android 客户端暂不在本项目范围内。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：`npm run build`。

## 已实现

- React、TypeScript、Tailwind CSS 与 Radix UI primitives；领域数据以 Effect Schema 定义。
- IndexedDB 本地持久化，笔记内容、版本、偏好与待同步操作分库存放。
- `createNote`、`reviseNote`、`deleteNote`、`restoreNote`、`selectRevision`、`setNotePreference` 领域命令。
- 每次编辑追加 Revision；选中历史版本后继续编辑会从该版本产生新分支。
- 版本历史、分支提示、固定、语义颜色、回收站、当前版本全文/元数据搜索。
- JSON 导出与恢复；恢复前会提示替换当前浏览器的数据。
- 可选 Supabase Auth 邮箱链接、幂等 push、按 `server_seq` pull、Realtime 唤醒和 RLS 数据库迁移。
- 每位用户可单独安装 GitHub App、选择自己授权的仓库；Supabase Edge Function 使用短期 installation token 将当前版本备份为 Markdown 和 JSON 元数据，客户端不会接触 GitHub token。

## Supabase 同步配置

1. 创建 Supabase 项目，运行 `npx supabase login`、`npx supabase link --project-ref <project-ref>` 和 `npx supabase db push` 应用数据库迁移。`<project-ref>` 可从 Supabase Dashboard 项目 URL 中找到。
2. 在 Auth > URL Configuration 中设置 Site URL 和 Redirect URLs，加入本地 `http://localhost:5173` 与生产站点 URL。Supabase Email Magic Link 默认启用，确认 Email provider 可用。
3. 复制 `.env.example` 为 `.env.local`，填入 Project URL 和 Publishable key（`sb_publishable_...`）。旧的 anon key 变量名仍作为兼容回退支持，但新项目推荐使用 publishable key。
4. 在 GitHub > Settings > Developer settings > GitHub Apps 创建 GitHub App：
   - Repository permissions 设置 **Contents: Read and write**；不需要申请其他仓库权限。
   - 将 App 设置为可安装到 **Any account**，这样其他 GitHub 用户才能安装。
   - Callback URL 设置为 `https://<project-ref>.supabase.co/functions/v1/github-oauth-callback`。
   - Setup URL 设置为 `https://<project-ref>.supabase.co/functions/v1/github-install-callback`。无需启用 “Redirect on update”。
   - 不要勾选 “Request user authorization (OAuth) during installation”；应用会在安装后的安全校验步骤单独请求 GitHub 授权。用户授权令牌只用于校验安装归属，校验后立即撤销，不会存入数据库。
   - 记下 App ID、App slug 和 Client ID，生成一把 private key，并创建 Client secret。
5. 在 Supabase Edge Function Secrets 中设置 `GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET` 和 `APP_BASE_URL`。`APP_BASE_URL` 是应用的根地址，例如本地 `http://localhost:5173` 或生产站点 URL。Private key 只保存在 Supabase Secrets；不要放进 `.env.local` 或前端代码。
6. 部署迁移和四个 Edge Functions：
   ```bash
   npx supabase db push --project-ref <project-ref>
   npx supabase functions deploy github-account --project-ref <project-ref>
   npx supabase functions deploy github-install-callback --project-ref <project-ref>
   npx supabase functions deploy github-oauth-callback --project-ref <project-ref>
   npx supabase functions deploy github-backup --project-ref <project-ref>
   ```
7. 用户打开“设置与数据”，使用邮箱链接登录，点击“连接我的 GitHub”，在 GitHub 页面把 App 安装到自己的个人账号，并只授权该账号拥有的目标仓库。建议选择私有仓库以保护笔记内容。GitHub 会要求确认账号授权；回到应用后选择备份仓库。之后先完成 Supabase 同步，再点击“GitHub 备份”。

匿名键只用于浏览器端 Auth；不要把 Supabase service role key 或 GitHub App private key 放入客户端。GitHub 安装回调使用一次性随机 state 绑定 Supabase 用户；OAuth 回调会验证该 GitHub 用户确实能访问对应的 App installation，避免仅信任可伪造的 `installation_id`。连接信息和授权 state 仅由 Edge Functions 读写。

## 架构

```text
src/domain/             Effect Schema 与业务命令
src/infrastructure/     IndexedDB、Supabase 同步适配器
src/App.tsx             Web UI
supabase/migrations/    Postgres 表、RLS、push/pull/search RPC
supabase/functions/     用户级 GitHub App 授权、仓库选择与备份
```

Supabase 迁移预留了 `pgvector` embedding 字段和当前版本全文检索 RPC；本版尚未配置 embedding 生成任务或语义检索界面。GitHub 备份只写当前版本；每位用户的文件保存在所选仓库的 `users/<supabase-user-id>/` 目录中，JSON 导出可作为手动本地备份。GitHub 是单向备份目的地，多设备同步仍由 Supabase 完成。Android、自动合并、多人实时协作均不在本版实现范围内。

## Cloudflare Workers 部署

项目通过 Workers Static Assets 托管 Vite 构建出的 SPA：`wrangler.jsonc` 将 `dist/` 配置为静态资源目录，并对客户端路由启用 SPA fallback。Worker 名称为 `revnote`。

### 连接 GitHub 自动部署

1. 在 Cloudflare Dashboard 打开 **Workers & Pages**，选择 **Create application** > **Import a repository**，授权 GitHub 并选择 `arthurfish/rev-note`。
2. 选择生产分支 `main`，根目录保持仓库根目录；Worker 名称必须是 `revnote`，与 `wrangler.jsonc` 一致。
3. 构建设置使用：
   - Build command：`npm run build`
   - Deploy command：`npm run deploy`
4. 在该 Worker 的 **Settings > Builds** 中设置构建变量 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`。它们会在 Vite 构建时写入浏览器资源，因此只使用 Supabase Project URL 和 Publishable key；不要使用 service role key 或其他秘密。请配置 **Build variables and secrets**，而非仅配置运行时变量。
5. 保存并部署。之后推送到 `main` 会触发新的构建和部署。也可以在本地运行 `npm run build && npm run deploy`。
6. 部署后，在 Supabase Auth 的 URL Configuration 中，将 Worker 的 `workers.dev` 地址（以及之后使用的自定义域名）加入允许的 Redirect URLs，并设置对应的 Site URL。

Cloudflare Workers Builds 的 GitHub 连接必须在 Cloudflare Dashboard 中授权完成；具体菜单和配置说明见 [Workers Builds 文档](https://developers.cloudflare.com/workers/ci-cd/builds/)。
