# 配置说明

## 文件与密钥放在哪里

| 内容 | 位置 | 是否提交到 GitHub |
| --- | --- | --- |
| 通用部署模板 | `wrangler.jsonc` | 是，保留示例值 |
| 个人 Worker 名称、域名、账号 ID、限流编号、匿名策略、仓库白名单 | `wrangler.local.jsonc` | 否，已忽略 |
| 线上代理密码 `PROXY_TOKEN` | Cloudflare Worker Secret，执行 `npm run secret:put` 设置 | 否 |
| 本地开发代理密码 | `.dev.vars`，可复制 `.dev.vars.example` 后填写 | 否 |
| GitHub 用户名与 GHCR PAT | 拉取方 Docker/ORAS 的凭证存储或 HTTP 请求头 | 否，不配置到 Worker |
| 本地状态、日志与部署产物 | `.wrangler/`、`dist/`、`node_modules/` | 否，已忽略 |

域名、账号 ID 和限流编号是部署参数，填写在 `wrangler.local.jsonc` 中。认证密钥单独管理，不要把 `PROXY_TOKEN`、Cloudflare API Token 或 GitHub PAT 放入 `vars`。Cloudflare 部署凭证由 Wrangler 登录或本机环境变量管理。

运行 `npm run configure` 从公开模板创建 `wrangler.local.jsonc`，已有文件不会被覆盖。`npm run dev`、`npm run deploy`、`npm run secret:put` 都使用此本地文件。线上 Secret 绑定到指定 Cloudflare 账号和 Worker。

手动执行 Wrangler 命令时，指定 `--config wrangler.local.jsonc`，例如：

```powershell
npx wrangler secret list --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc --dry-run
```

## 统一修改个人配置

编辑 `wrangler.local.jsonc`：

| 字段 | 用途 |
| --- | --- |
| `name` | Worker 名称；Secret 绑定到指定账号和 Worker，部署到不同目标时需要单独设置 |
| `account_id`（可选） | 有多个 Cloudflare 账号时选择部署账号 |
| `routes[].pattern` | 自定义域名，例如 `proxy.example.com` |
| `workers_dev` | 是否开放 workers.dev 入口，默认 `false` |
| `ratelimits[].namespace_id` | 两个独立的数字编号；账号内避免与其他 Worker 共用 |
| `ratelimits[].simple.limit` | 默认每 IP 120 次/60 秒、每节点合计 600 次/60 秒 |
| `vars.ALLOW_ANONYMOUS` | 默认字符串 `"false"`，全部下载都需要代理认证；`"true"` 开启选定类型免认证 |
| `vars.ANONYMOUS_ROUTES` | 逗号分隔的 `gist`、`raw`、`releases`、`archive`、`ghcr`、`git`；默认空字符串，不豁免任何类型 |
| `vars.ALLOWED_GITHUB_REPOSITORIES` | 可选，精确的 `owner/repo` 或 Gist `user/gist-id` 列表 |
| `vars.ALLOWED_GHCR_REPOSITORIES` | 可选，精确的 `owner/image` 列表，支持嵌套路径 |

两类仓库白名单都不设置时允许该类全部仓库；设为空字符串则禁止该类仓库。匿名策略不覆盖白名单和限流。

例如，只开放 Gist 和 Raw：

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "true",
  "ANONYMOUS_ROUTES": "gist,raw"
}
```

默认配置，所有下载都需要代理密码：

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "false",
  "ANONYMOUS_ROUTES": ""
}
```

若确需开放全部类型，开启总开关并填写 `gist,raw,releases,archive,ghcr,git`；不支持 `*`。缺少开关或列表时不豁免任何下载。对未豁免的类型，未配置 `PROXY_TOKEN` 返回 503，缺少/错误的客户端密码返回 401。健康检查 `/`、`/health` 和 OPTIONS 不受下载认证开关控制。

`git` 控制公开 GitHub 仓库的 Git HTTPS 克隆与拉取。Git 与文件下载共用 `ALLOWED_GITHUB_REPOSITORIES`，填写 `owner/repo`，不带 `.git`。免认证列表中的 `raw` 或 `archive` 不会自动开放 Git；推送、SSH、Git LFS 和私有 Git 仓库不受支持。完整使用方法见 [README.md](README.md#git-https-克隆与拉取)。

开放 `ghcr` 免代理认证后，公开包可匿名下载；私有包需要 GitHub 用户名/PAT，可使用 Docker/ORAS 登录或 HTTP 的 `X-GHCR-Authorization` 请求头。配置了 `PROXY_TOKEN` 时也支持 `代理密码:PAT` 复合密码。Registry 首次访问 `/v2/` 会返回 Bearer 401，客户端通过 `/__registry/token` 自动握手，主动登录时校验凭证。

`PROXY_TOKEN` 同时用于签名最多 60 秒、绑定仓库与代理域名的 Registry 会话，轮换后旧会话失效。没有该 Secret 的匿名部署使用 GHCR 短期令牌，不增加新的必填配置。令牌端点和下载都执行限流、仓库白名单；不支持扩大为 push 范围。携带凭证或会话令牌的下载不进入共享缓存。

更改配置后执行 `npm run deploy` 才会在线上生效。

## 上传 GitHub

提交源码、测试、文档、公开模板、依赖锁文件与示例文件即可。`.gitignore` 已排除本地部署配置、`.dev.vars*`、`.env*`（示例除外）、日志、依赖和产物。可先运行 `git status --short` 与 `git diff --cached` 检查实际提交内容。

不要提交密钥或私密配置。忽略规则不能撤销已经提交的敏感内容；凭证泄漏后应撤销或更换，并按需清理 Git 历史。
