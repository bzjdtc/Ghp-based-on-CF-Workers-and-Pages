# 安全与资源限制

本项目通过代理认证、仓库白名单、限流和受限回源控制访问与资源消耗。应用内防护不能作为月度账单硬上限；实际费用和配额以 Cloudflare 的账号套餐为准。[Workers 定价文档](https://developers.cloudflare.com/workers/platform/pricing/)

## 认证与访问控制

默认所有下载都需要代理认证。受保护类型未配置 `PROXY_TOKEN` 时返回 503，客户端缺少有效凭证时返回 401。`/`、`/health` 和 OPTIONS 是公开的健康检查与预检接口。

免认证需要同时设置 `ALLOW_ANONYMOUS="true"`，并在 `ANONYMOUS_ROUTES` 中列出对应类型。类型依据已校验的下载路由判断，开关关闭、列表缺失或为空均不豁免下载。免认证请求也执行仓库白名单、路径校验和限流。

`ALLOWED_GITHUB_REPOSITORIES` 和 `ALLOWED_GHCR_REPOSITORIES` 使用逗号分隔的精确仓库名，大小写不敏感，不支持通配符。未设置时允许该类全部仓库，空字符串表示禁止该类仓库；GHCR 的 `/v2/` 登录检查不受仓库白名单限制。

个人部署参数保存在 Git 忽略的 `wrangler.local.jsonc`；线上代理密码使用 Worker Secret，本地开发密码使用 `.dev.vars`。GitHub PAT 由下载客户端提供，不统一配置到服务端。配置方法见 [CONFIGURATION.md](CONFIGURATION.md)。

## 回源与凭证边界

- 下载仅支持 GET 和 HEAD，并提供 OPTIONS 预检。回源目标限定为支持的 GitHub 文件和 GHCR manifests/blobs 接口，不提供任意 URL 代理、上传、删除、目录或标签列表。
- 路径逐段解码、校验并重新编码，拒绝路径穿越、编码后的分隔符、控制字符和无效组件。重定向逐跳检查，只接受固定 HTTPS 域名，拒绝用户信息和自定义端口，最多三跳；跨域时删除 Authorization。
- Gist 回源与重定向限定为 `gist.githubusercontent.com`。GHCR 回源与镜像层跳转限定为 `ghcr.io` 和 `pkg-containers.githubusercontent.com`。完整 Gist URL 的不同入口使用相同的路径校验、白名单和缓存规则。
- GHCR 令牌接口固定为 `https://ghcr.io/token`，service 固定为 `ghcr.io`，scope 由已校验的仓库名构造且只有 `pull`。不信任客户端或认证 challenge 提供的 realm、service、scope。
- 代理密码与 GitHub 身份分别验证。受保护的 GHCR 路由使用 `GitHub用户名` 和 `代理密码:GitHub_PAT`，HTTP 客户端也可使用代理 Bearer 与独立的 `X-GHCR-Authorization: Basic ...`。代理密码本身不授予私有包权限。
- 开放 `ghcr` 免代理认证后，私有包需要有效的 GitHub 凭证，可使用原生 GitHub Basic 登录或 `X-GHCR-Authorization`。配置了 `PROXY_TOKEN` 时也支持复合密码。登录校验凭证，具体包的读取权限在请求仓库时校验；GHCR 拒绝认证或访问时返回 403。
- PAT 只发送到固定的 GHCR 令牌接口，清单和 Blob 使用兑换后的 Bearer 令牌。PAT 不发送到镜像层 CDN 或 GitHub 文件下载域名。项目代码不将 PAT 写入 URL、日志、Worker 配置或持久化存储，也不返回给客户端。代理 Worker 会接收 PAT，应使用可信的部署。
- 携带 GitHub 凭证的请求逐次兑换令牌，跳过共享 Cache API 的读取和写入，私有令牌不进入共享内存缓存。权限不足、无效凭证或撤销后的请求不回退到匿名访问或共享缓存；权限变更的生效时间由 GHCR 决定。
- 只有匿名令牌进入短期内存缓存，最多保存 128 个仓库；令牌响应解析上限为 64 KiB。匿名认证最多重试一次，私有认证不自动重试。

GHCR 公开包支持上游匿名读取，代理入口是否要求代理密码由认证配置决定。[GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

## 缓存与资源保护

| 防护项 | 当前行为 |
| --- | --- |
| 请求限流 | 默认每 IP 每分钟 120 次，每个 Cloudflare 节点合计每分钟 600 次有效下载请求；缓存命中同样计数，超限返回 429。缺少任一限流绑定时拒绝下载 |
| 缓存体积 | 仅缓存大小已知、未压缩、可公开缓存且不超过 1 MiB 的完整 200 响应；实际读取有大小上限。较大、长度未知、私有或带 Cookie 的响应直接流式传输 |
| 缓存键 | 丢弃客户端查询参数，按实际上游地址统一入口别名；GHCR Accept 类型规范化，限制缓存变体 |
| 客户端缓存 | 下载响应使用 `private, no-store`。内部 Cache API 访问前执行认证策略、白名单和限流检查 |
| 范围请求 | 仅接受单段 Range，支持断点续传；拒绝多段或无效 Range |
| 上游等待 | 每次等待上游响应头最多 15 秒；大型响应体以流式方式返回，不创建后台缓存副本持续下载整个文件 |

限流使用 Workers 原生 Rate Limiting binding。计数在各 Cloudflare 节点分别执行，采用宽松一致性，不能作为全局精确预算或准确记账系统。[Rate Limiting 文档](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## 依赖安全

依赖版本由 `package.json` 和 `package-lock.json` 管理，使用 `npm ci` 安装。Wrangler、TypeScript 及其工具依赖用于本地开发、测试与部署，不由 Worker 业务源码导入运行产物。

检查依赖公告，并在更新依赖后运行验证：

```powershell
npm audit
npm run typecheck
npm test
npm run deploy -- --dry-run
```

漏洞状态以运行 `npm audit` 时的数据库为准。评估公告的影响范围和升级变更，避免未经检查使用强制升级。

## 部署建议与风险

1. **请求洪泛。** 认证和返回 429 都发生在 Worker 被调用之后，错误密码、无效路径、健康检查和 OPTIONS 也会消耗请求。可在自定义域名前配置 Cloudflare WAF、Rate Limiting 或适合 Docker/CLI 的网络访问限制，在请求进入 Worker 前拦截。Docker/CLI 接口不适合浏览器交互挑战。
2. **分布式流量。** 多个节点或大量不同 IP 可以分别消耗配额，限流不能保证账号的总请求量。根据实际用途选择匿名类型和仓库白名单，并监控请求数、CPU、异常率与限流率。
3. **平台限制。** 默认配置支持 Workers Free，不设置自定义 `limits`，使用账号套餐的 CPU 和子请求限制。CPU 上限限制单次调用，不限制月度总用量；网络等待不计入 CPU。大文件会消耗连接与上游资源。[Workers 限制文档](https://developers.cloudflare.com/workers/platform/limits/)
4. **密钥维护。** 使用高熵随机代理密码，泄漏后更换；GitHub PAT 只授予需要的权限。匿名类型一旦开放，即使配置了代理密码也可被匿名客户端使用。
5. **外部缓存。** 检查自定义域名的 Cache Rules，确保不会强制忽略响应中的 `no-store`。更改缓存规则时检查并清理可能包含受保护响应的缓存。
6. **部署与日志。** 部署时配置代码、Secret 和两个限流绑定，并验证实际下载。dry-run 只检查本地打包，不能替代线上套餐和回源验证。默认 `workers_dev=false`；Cloudflare 平台的日志、指标和访问权限由部署账号管理。
