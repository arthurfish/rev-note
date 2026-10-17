# RevNote（简笺）

一款本地优先、无标题的极简笔记 Web 应用。每次编辑都会追加一个不可变版本；回收站只改变笔记生命周期，不删除版本。Android 客户端暂不在本项目范围内。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：`npm run build`。

Edge Functions 使用 Deno 2 和 Effect 4（依赖分别由各函数目录的 `deno.json` 固定；共享测试使用 `supabase/functions/deno.json`）；前端继续使用根目录的 Effect 3。可运行 `npm test` 测试共享模块，`npm run check:edge` 检查两个函数入口。

## 已实现

- React、TypeScript、Tailwind CSS 与 Radix UI primitives；领域数据以 Effect Schema 定义。
- IndexedDB 本地持久化，笔记内容、版本、偏好与待同步操作分库存放。
- `createNote`、`reviseNote`、`deleteNote`、`restoreNote`、`selectRevision`、`setNotePreference` 领域命令。
- 每次编辑追加 Revision；选中历史版本后继续编辑会从该版本产生新分支。
- 版本历史、分支提示、固定、语义颜色、回收站、当前版本全文/元数据搜索。
- JSON 导出与恢复；恢复前会提示替换当前浏览器的数据。
- 可选 Supabase Auth 邮箱链接、幂等 push、按 `server_seq` pull、Realtime 唤醒和 RLS 数据库迁移。
- 每位用户可连接一个仅授权单仓库的 fine-grained personal access token；Effect 4 编写的 Supabase Edge Functions 在服务端解密并将当前版本备份为 Markdown 和 JSON 元数据，客户端不会再次读取已保存的 token。

## Supabase 同步配置

1. 创建 Supabase 项目，运行 `npx supabase login`、`npx supabase link --project-ref <project-ref>` 和 `npx supabase db push` 应用数据库迁移。`<project-ref>` 可从 Supabase Dashboard 项目 URL 中找到。
2. 在 Auth > URL Configuration 中设置 Site URL 和 Redirect URLs，加入本地 `http://localhost:5173` 与生产站点 URL。Supabase Email Magic Link 默认启用，确认 Email provider 可用。
3. 复制 `.env.example` 为 `.env.local`，填入 Project URL 和 Publishable key（`sb_publishable_...`）。旧的 anon key 变量名仍作为兼容回退支持，但新项目推荐使用 publishable key。
4. 为备份仓库创建 fine-grained personal access token：
   - 打开 [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new?name=RevNote%20backup&description=Backup%20notes%20from%20RevNote&contents=write)。
   - Resource owner 选择仓库所属的个人账号；Repository access 只选择一个目标仓库。
   - Repository permissions 仅需 **Contents: Read and write**；Metadata read 是 GitHub 自动包含的只读权限。
   - 建议设置 token 过期时间，并在 token 创建后立即复制。RevNote 不会收到或保存 GitHub 登录密码。
5. 生成一次服务端加密密钥，例如运行 `openssl rand -base64 32`。将输出设置为 Supabase Edge Function Secret `GITHUB_TOKEN_ENCRYPTION_KEY`；本地运行 Edge Functions 时，将同一值和本地 Supabase URL/server key 放入未提交的 `.env.edge`，并使用 `npx supabase functions serve --env-file .env.edge` 启动。该密钥只用于加密数据库中的 PAT，不要放进 `.env.local` 或前端代码；丢失或更换密钥后，用户需要重新连接 PAT。
6. 部署迁移和两个 Edge Functions：
    ```bash
    npx supabase db push --project-ref <project-ref>
    npx supabase functions deploy github-account --project-ref <project-ref>
    npx supabase functions deploy github-backup --project-ref <project-ref>
    ```
7. 用户打开“设置与数据”，使用邮箱链接登录，在 GitHub 连接区域填写仓库名（`owner/repository`）和刚创建的 PAT。应用会在服务端验证 PAT 能读取该仓库，并以 AES-GCM 加密后保存。之后先完成 Supabase 同步，再点击“GitHub 备份”。

匿名键只用于浏览器端 Auth；不要把 Supabase service role key、`GITHUB_TOKEN_ENCRYPTION_KEY` 或 PAT 放入客户端。PAT 密文和备份连接信息只由 Edge Functions 读写。断开 RevNote 连接会删除服务器保存的密文，但不会撤销 GitHub 上的 token；如需撤销权限，请在 GitHub 的 fine-grained token 设置中删除该 token。

可用 `npx supabase test db` 运行连接凭证表的权限测试。

切换后，旧版 GitHub App 连接和备份状态会被迁移清除，用户需重新填写 PAT；迁移不会卸载用户此前安装的 GitHub App，如不再需要，可在 GitHub 的 Installed GitHub Apps 设置中手动卸载。

## 架构

```text
src/domain/             Effect Schema 与业务命令
src/infrastructure/     IndexedDB、Supabase 同步适配器
src/App.tsx             Web UI
supabase/migrations/    Postgres 表、RLS、push/pull/search RPC
supabase/functions/_shared/shared-schema.ts         跨模块共享的备份契约
supabase/functions/_shared/github/                 GitHub Schema、Service、Layer 与测试
supabase/functions/_shared/supabase/               Supabase Schema、Service、Layer 与测试
supabase/functions/_shared/backup-coordinator/      用例、Layer 组合与测试
supabase/functions/github-account/index.ts          HTTP/Deno 入口
supabase/functions/github-backup/index.ts           HTTP/Deno 入口
```

Supabase 迁移预留了 `pgvector` embedding 字段和当前版本全文检索 RPC；本版尚未配置 embedding 生成任务或语义检索界面。GitHub 备份只写当前版本；每位用户备份到自己选择的仓库根目录，Markdown 和元数据分别保存在 `notes/` 与 `metadata/` 中，JSON 导出可作为手动本地备份。GitHub 是单向备份目的地，多设备同步仍由 Supabase 完成。Android、自动合并、多人实时协作均不在本版实现范围内。

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
