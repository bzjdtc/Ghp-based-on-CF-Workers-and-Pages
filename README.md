# GitHub / GHCR 下载代理

Cloudflare Worker，支持 GitHub Release、Raw、源码归档、Gist Raw、公开仓库的 Git HTTPS 克隆与拉取，以及 GHCR 公开和私有镜像、OCI 产物的只读下载。私有包使用拉取方自己的 GitHub 凭证。

**默认所有下载都需要代理认证。** 可按类型配置免认证；代理密码与 GitHub PAT 分开使用。本文中的 `proxy.example.com`、`owner/repo`、`owner/image`、标签和文件名都是示例，请替换成自己的实际值。

- [配置与部署](#配置与部署)
- [按代理类型选择免认证](#按代理类型选择免认证)
- [拉取 GHCR 镜像](#拉取-ghcr-镜像)
- [下载 OCI 产物及直接使用 HTTPS](#下载-oci-产物及直接使用-https)
- [GitHub 文件下载](#github-文件下载)
- [Git HTTPS 克隆与拉取](#git-https-克隆与拉取)
- [本地开发与常用命令](#本地开发与常用命令)
- [常见问题](#常见问题)
- [上传 GitHub 与凭证保护](#上传-github-与凭证保护)
- [许可证](#许可证)

## 配置与部署

### 运行环境

部署机器需要 Node.js 22 或更新版本及 npm。使用自定义域名需要自己的 Cloudflare 账号和该账号下已激活的域名区域；域名配置方式见 [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。下载镜像的客户端需要 Docker，下载普通 OCI 文件推荐使用 ORAS，HTTP 下载可使用 curl。

下面标注 `powershell` 的命令用于 Windows PowerShell；标注 `bash` 的命令用于 Linux/macOS Bash，两种多行语法不能混用。Linux/macOS 的 curl 命令使用 `curl`，Windows 示例明确使用 `curl.exe`。

Windows PowerShell 若提示禁止运行 `npm.ps1` 或 `npx.ps1`，将命令中的 `npm`、`npx` 分别改为 `npm.cmd`、`npx.cmd`，例如 `npm.cmd run deploy`。

### 1. 安装依赖并生成配置

在本项目根目录执行：

```powershell
npm ci
npm run configure
```

`npm ci` 按 `package-lock.json` 安装依赖并重建 `node_modules`。`npm run configure` 从公开模板创建 `wrangler.local.jsonc`，已有文件不会被覆盖。

### 2. 填写个人部署配置

编辑 `wrangler.local.jsonc`，至少检查以下字段：

| 字段 | 设置方法 |
| --- | --- |
| `name` | Worker 名称，默认 `github-proxy`；Secret 绑定到指定账号和 Worker |
| `account_id`（可选） | 有多个账号时填写目标 Cloudflare 账号 ID |
| `routes[].pattern` | 将 `proxy.example.com` 改为自己的完整代理域名，不带 `https://` 或路径 |
| `routes[].custom_domain` | 使用自定义域名时保留 `true` |
| `workers_dev` | 默认 `false`，关闭额外的 workers.dev 入口 |
| `ratelimits[].namespace_id` | 分别设置两个独立的数字字符串，账号内避免与其他 Worker 共用 |
| `vars` | 设置免认证策略和可选仓库白名单，详见下文 |

域名配置片段：

```jsonc
"routes": [
  { "pattern": "proxy.example.com", "custom_domain": true }
]
```

在 `wrangler.local.jsonc` 中修改对应字段，并保留其他配置。

### 3. 登录 Cloudflare

首次部署时执行以下命令，并在浏览器完成 Cloudflare 授权：

```powershell
npx wrangler login
```

已登录时可继续下一步。远程终端的登录方法及无浏览器环境的 API Token 方式见 [Wrangler 登录文档](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)。Cloudflare 部署凭证、下面的代理密码和 GitHub PAT 是三种不同的凭证。

### 4. 生成并设置服务端代理密码

可以在本机生成 32 字节随机密码，输出为 64 个十六进制字符：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

保存输出到自己的密码管理器，再单独执行：

```powershell
npm run secret:put
```

在提示中输入生成的代理密码。密码以 `PROXY_TOKEN` Secret 保存，不要写入配置文件的 `vars`。该命令等同于：

```powershell
npx wrangler secret put PROXY_TOKEN --config wrangler.local.jsonc
```

Secret 绑定到指定账号和 Worker。更换密码时再次运行 `npm run secret:put`，并同步更新客户端凭证。下面的命令列出已配置的 Secret 名称，不显示密码值：

```powershell
npx wrangler secret list --config wrangler.local.jsonc
```

服务端 Secret 与本地开发变量分别设置，详见 [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

### 5. 部署并检查

```powershell
npm run deploy
```

检查健康接口：

```powershell
curl.exe --fail "https://proxy.example.com/health"
```

正常返回 `GitHub / GHCR Proxy OK`。健康接口无需密码，只能证明 Worker 可访问；要验证认证和回源，请再按下文下载一个真实存在的文件或镜像。

配置或代码变更后执行 `npm run deploy`。部署到另一个账号或 Worker 时，需要为目标 Worker 设置 Secret。

仓库中的 `wrangler.jsonc` 是可公开的模板，域名使用 `proxy.example.com` 占位。`npm run dev`、`npm run deploy` 和 `npm run secret:put` 使用 **Git 忽略的 `wrangler.local.jsonc`**，缺失时会自动复制模板，已有文件不会被覆盖。直接运行 Wrangler 时请加 `--config wrangler.local.jsonc`。类型声明由公开模板生成，避免把个人变量写入生成文件。

配置文件速查见 [CONFIGURATION.md](CONFIGURATION.md)。

## 按代理类型选择免认证

开关位于 **`wrangler.local.jsonc` 的 `vars` 对象**中。示例中的 `"true"`、`"false"` 都是字符串。下面展示的是配置片段，修改时保留 `vars` 内已有的其他设置，不要再增加第二个 `vars` 对象。

### 默认：全部需要认证

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "false",
  "ANONYMOUS_ROUTES": ""
}
```

### 只让 Gist 免认证

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "true",
  "ANONYMOUS_ROUTES": "gist"
}
```

### 同时让多个类型免认证

例如，开放 Gist、GitHub Raw 和 Release 附件免认证，源码归档和 GHCR 需要代理密码：

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "true",
  "ANONYMOUS_ROUTES": "gist,raw,releases"
}
```

### 所有支持的类型都免代理认证

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "true",
  "ANONYMOUS_ROUTES": "gist,raw,releases,archive,ghcr,git"
}
```

`ALLOW_ANONYMOUS` 是总开关，设为字符串 `"false"` 会关闭所有下载路由的免认证。`ANONYMOUS_ROUTES` 是逗号分隔的类型列表：

| 值 | 对应下载 |
| --- | --- |
| `gist` | Gist Raw，含完整 URL 入口 |
| `raw` | GitHub Raw，含两种路径写法 |
| `releases` | GitHub Release 附件 |
| `archive` | 源码归档、zipball、tarball |
| `git` | 公开 GitHub 仓库的 Git HTTPS 克隆与拉取 |
| `ghcr` | GHCR `/v2/` 登录检查、镜像和 OCI manifests/blobs |

默认 `ALLOW_ANONYMOUS="false"`、`ANONYMOUS_ROUTES` 为空。未豁免的类型需要 `PROXY_TOKEN`：服务端缺少 Secret 时返回 503，客户端缺少凭证或密码错误时返回 401。只有总开关为 `"true"` 且列表包含对应类型时才免认证；列表不支持通配符，缺失、为空或拼写错误的条目不会开放对应路由。配置免认证类型时可以保留代理 Secret，供其他类型使用。

免代理认证的请求执行仓库白名单、两级限流和路径校验；GHCR 私有包需要有效的 GitHub 凭证。`/`、`/health` 和 OPTIONS 是公开健康检查/预检接口。

改完后运行 `npm run deploy` 才会生效。临时关闭全部下载豁免时，只需把总开关改为 `"false"`；列表可以保留，之后重新开启总开关会恢复该列表中的豁免。

### 限流与仓库白名单

默认限制为每 IP 每分钟 120 次、每个 Cloudflare 节点所有有效下载请求合计每分钟 600 次，超限返回 429。命中内部缓存的请求同样受限。两个计数器的 `namespace_id` 应在你的 Cloudflare 账号内保持独立，避免与其他 Worker 共用。

计数在各 Cloudflare 节点分别执行且采用宽松一致性，不是全局精确预算，也不能作为月度账单硬上限。开放免认证前应结合实际用途选择类型和白名单。参见 [Rate Limiting 的范围与精度](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

默认配置支持 Workers Free，采用平台的 CPU 和子请求限制，不设置自定义 `limits`。Free 计划每次请求的限制为 10 ms CPU、50 个外部子请求；网络等待不计入 CPU 时间。代理另行限制请求频率、重定向次数和认证重试。[Workers 限制文档](https://developers.cloudflare.com/workers/platform/limits/)

可按实际用途配置逗号分隔的精确仓库白名单：

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "false",
  "ANONYMOUS_ROUTES": "",
  "ALLOWED_GITHUB_REPOSITORIES": "owner/repo",
  "ALLOWED_GHCR_REPOSITORIES": "owner/image,owner/nested/image"
}
```

不设置对应白名单表示允许所有仓库；设为空字符串表示禁止该类仓库。Gist 使用 `用户名/gist-id`。白名单在缓存读取前执行。

若只允许特定 Gist 和 GitHub 仓库，可以在同一个列表中填写：

```jsonc
"ALLOWED_GITHUB_REPOSITORIES": "owner/repo,user/gist-id"
```

白名单采用完整仓库名匹配，大小写不敏感，不支持 `*`。GHCR 白名单不会限制 `/v2/` 登录检查，但会限制具体包的读取。白名单值和真实域名一样，应填写在本地部署配置中。

## 拉取 GHCR 镜像

Docker 登录在**需要下载镜像的机器**上执行，不要求进入本项目目录。它配置的是客户端访问代理的凭证，不会设置或修改服务端 `PROXY_TOKEN`。

| GHCR 代理策略 | 目标包 | Docker 登录用户名 | Docker 登录密码 |
| --- | --- | --- | --- |
| 默认需要认证 | 公开包 | 任意，例如 `proxy` | 实际代理密码 |
| 默认需要认证 | 私有包 | 真实 GitHub 用户名 | `实际代理密码:GitHub_PAT` |
| 已开放 `ghcr` 免认证 | 公开包 | 无需登录 | 无需密码 |
| 已开放 `ghcr` 免认证 | 私有包 | 真实 GitHub 用户名 | GitHub PAT；配置了 `PROXY_TOKEN` 时也支持 `代理密码:PAT` |

### 公开镜像

把原始镜像地址 `ghcr.io/owner/image:tag` 中的域名换为代理域名：

```powershell
docker login proxy.example.com --username proxy
# 在 Password 提示中输入实际代理密码。
docker pull proxy.example.com/owner/image:tag
docker pull "proxy.example.com/owner/image@sha256:<64位十六进制摘要>"
```

以上为公开包下载方式：用户名可任意填写，密码为代理密钥。代理使用匿名 `pull` 令牌，最多在内存缓存 128 个仓库的短期令牌，并跟随经过校验的镜像层重定向。代理密码不会发送到任何上游，GHCR 令牌不会返回给客户端。

如果已开启总开关且列表中包含 `ghcr`，公开镜像可以直接执行 `docker pull`。本项目不是所有容器仓库的通用镜像源，只代理 GHCR；不需要把它配置成 Docker Hub 的 `registry-mirrors`。

### 私有镜像与 OCI 产物

拉取方需要 GitHub 用户名和 PAT（classic），PAT 至少具有 `read:packages`，对应账号还必须能读取目标包。组织启用 SSO 时，需要为 PAT 授权 SSO。`read:packages` 不会自动授予所有私有包的访问权。[GitHub 认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic)

使用 GitHub 用户名登录**代理域名**，密码按 `PROXY_TOKEN:GHCR_PAT` 拼接，中间使用英文冒号：

```powershell
docker login proxy.example.com --username YOUR_GITHUB_USERNAME
# 在 Password 提示中输入：代理密钥:GitHub_PAT
docker pull proxy.example.com/owner/private-image:tag
```

密码格式为 `代理密码:GitHub_PAT`，例如 `proxy-example:github-example`（仅为格式示例）。Docker 将整段字符串作为密码发送给代理，代理拆分并校验凭证。直接登录 `ghcr.io` 时，密码为 GitHub PAT。

Bash 交互登录示例：

```bash
{
  read -rsp "Proxy token: " proxy_token
  printf '\n'
  read -rsp "GHCR read token: " ghcr_read_token
  printf '\n'

  printf '%s' "${proxy_token}:${ghcr_read_token}" |
    docker login proxy.example.com --username YOUR_GITHUB_USERNAME --password-stdin

  unset proxy_token ghcr_read_token
}
```

替换域名和 `YOUR_GITHUB_USERNAME`，在 Bash 终端运行，并按提示输入代理密码和 GitHub PAT。

如果客户端已经从安全来源获得环境变量，也可以通过标准输入登录，避免密码出现在命令行参数中：

```powershell
"$($env:PROXY_TOKEN):$($env:GHCR_PAT)" | docker login proxy.example.com `
  --username $env:GHCR_USERNAME --password-stdin
```

无需在 Worker 配置统一的 GitHub PAT。代理先校验代理密钥，再将该客户端的 GitHub 用户名/PAT 通过 Basic 认证发送到固定的 `https://ghcr.io/token`，请求目标仓库的 `pull` 令牌；实际清单和层文件请求只携带兑换得到的 Bearer 令牌。PAT 不会发送到镜像层 CDN、GitHub 文件下载域名或返回给客户端。

代理 Worker 会接收客户端提供的 PAT，使用私有包功能时需要信任该部署及其管理者。

带 GitHub 凭证的请求**每次重新兑换令牌，并完全绕过代理内部 Cache API 的读取和写入**；私有令牌不会存入共享令牌缓存。不同用户的权限不会互相借用，失败时也不会退回匿名访问或使用已有公开缓存。代价是每个私有清单/Blob 请求都增加一次 GHCR 令牌请求，仍受相同限流保护。登录会验证 GitHub 凭证，具体仓库的读取权限在拉取时验证。

HTTP 客户端可用 `Authorization: Bearer <PROXY_TOKEN>` 提供代理密码，并通过独立请求头提供 GitHub 凭证：

```text
X-GHCR-Authorization: Basic <base64(GitHub用户名:GitHub_PAT)>
```

该头仅支持 GHCR 路由，不能与上述复合密码同时使用。所有凭证都应通过 HTTPS 传输。只执行 `docker login ghcr.io` 不会为代理域名配置登录信息。

总开关开启且类型列表包含 `ghcr` 时，私有包可用 GitHub 用户名/PAT 登录代理，或通过 `X-GHCR-Authorization` 提供凭证；配置了 `PROXY_TOKEN` 时也支持复合密码。匿名客户端只能读取公开包。

需要删除客户端保存的代理登录信息时执行：

```powershell
docker logout proxy.example.com
```

`unset` 仅清除 Bash 变量；Docker 登录信息由凭证助手或客户端配置文件管理，使用 `docker logout` 删除。`ghcr.io` 与代理域名使用独立的登录配置。客户端凭证的保存方式见 [Docker 登录文档](https://docs.docker.com/reference/cli/docker/login/)。

## 下载 OCI 产物及直接使用 HTTPS

OCI 是 Open Container Initiative 的规范体系。这里的 OCI 产物存放在 GHCR 中，通过 manifest 描述内容，再按摘要下载 blob；它可能是镜像，也可能是普通文件。文件结构参见 [OCI manifest 规范](https://github.com/opencontainers/image-spec/blob/main/manifest.md)。

### 使用 ORAS 下载文件

默认需要代理认证。公开产物的用户名可以填 `proxy`，密码填实际代理密码：

```powershell
oras login proxy.example.com --username proxy
oras pull proxy.example.com/owner/artifact:tag --output ./downloads
```

私有产物使用真实 GitHub 用户名，在密码提示中输入 `代理密码:GitHub_PAT`：

```powershell
oras login proxy.example.com --username YOUR_GITHUB_USERNAME
oras pull proxy.example.com/owner/private-artifact:tag --output ./downloads
```

如果开放了 `ghcr` 免代理认证，公开产物跳过登录即可；私有产物仍要登录，密码可直接使用 GitHub PAT。文件写入 `downloads` 目录。ORAS 按产物中的文件信息下载，命令选项见 [oras pull 官方文档](https://oras.land/docs/commands/oras_pull/)。

### 通过 HTTPS 请求 manifest 和 blob

支持以下只读接口：

```text
/v2/
/v2/owner/image/manifests/tag
/v2/owner/image/manifests/sha256:<digest>
/v2/owner/image/blobs/sha256:<digest>
```

HTTP 下载另支持 `/ghcr.io/v2/...` 别名。Docker 镜像名中直接替换域名即可。OCI 客户端可通过上述 manifests/blobs 接口，按标签或摘要下载公开/私有产物；上传、删除、仓库目录、标签列表和 referrers 发现接口不在支持范围内。引用外部域名的 foreign layer 不会通过此代理下载。

例如，在默认认证配置下获取私有产物的 manifest：

```powershell
curl.exe --fail --user YOUR_GITHUB_USERNAME `
  --header "Accept: application/vnd.oci.image.manifest.v1+json" `
  "https://proxy.example.com/v2/owner/private-artifact/manifests/tag" `
  --output manifest.json
```

curl 提示输入密码时填写 `代理密码:GitHub_PAT`。查看 manifest 中目标文件对应的 `layers[].digest`，将其 `sha256:` 后的摘要替换到下例中，再下载 blob：

```powershell
curl.exe --fail --location --user YOUR_GITHUB_USERNAME `
  "https://proxy.example.com/v2/owner/private-artifact/blobs/sha256:<64位十六进制摘要>" `
  --output file.bin
```

每次调用 curl 都按提示输入密码；下载公开产物时改用 `--user proxy` 并输入代理密码。若 `ghcr` 已免代理认证，公开产物可省略 `--user`，私有产物的密码可直接填 GitHub PAT。

如果返回的是镜像索引，应先选择 `manifests[].digest` 对应的平台清单，再请求 `/manifests/sha256:...`；最终文件可能对应多个层，不能把 manifest JSON 当成文件内容。ORAS 会处理常规产物的 manifest 与 blob 下载，镜像则交给 Docker 拉取。

### 工具只能填写一个 HTTPS 链接时

如果工具能设置请求头，可以使用 `Authorization: Bearer <实际代理密码>`；私有 GHCR 还要附加前文的 `X-GHCR-Authorization`。如果工具支持 HTTP Basic，则按前面的用户名/密码规则填写。

如果工具既不能设置请求头，也不能提供 Basic 凭证或完成浏览器登录，只能给它使用**已开放免认证的类型中的公开上游内容**。例如开放 `gist` 后使用 Gist 链接，或开放 `ghcr` 后使用已知公开 blob 的 HTTPS 地址。项目不提供查询参数密码，不能靠在 URL 后加 `?token=...` 完成认证。

私有 GHCR 不能只凭一个无凭证 HTTPS 地址下载；它仍需 GitHub 权限。项目也没有 `/owner/artifact/tag/文件名` 这样的 OCI 文件映射接口，需要先解析 manifest，或使用 ORAS。

## GitHub 文件下载

### 带代理密码下载

默认可以使用 HTTP Basic，curl 会提示输入代理密码，用户名填 `proxy`：

```powershell
curl.exe --fail --location --user proxy `
  "https://proxy.example.com/owner/repo/releases/download/v1.0.0/app.zip" `
  --output app.zip
```

Linux/macOS Bash 的同一下载可以使用单行命令：

```bash
curl --fail --location --user proxy "https://proxy.example.com/owner/repo/releases/download/v1.0.0/app.zip" --output app.zip
```

也支持 Bearer 请求头，格式如下；`<PROXY_TOKEN>` 应替换为实际代理密码，自动化工具可从自己的密钥配置中生成该请求头：

```powershell
curl.exe -L -H "Authorization: Bearer <PROXY_TOKEN>" `
  "https://proxy.example.com/owner/repo/releases/download/v1.0.0/app.zip" -o app.zip
```

### 地址转换

将表中的路径接在 `https://proxy.example.com` 后面：

| 上游内容 | 代理路径 |
| --- | --- |
| GitHub Release 附件 | `/owner/repo/releases/download/tag/file` |
| GitHub Raw 文件 | `/raw/owner/repo/ref/file` |
| GitHub Raw 的另一入口 | `/owner/repo/raw/ref/file` |
| 按标签下载源码归档 | `/owner/repo/archive/refs/tags/v1.0.0.tar.gz` |
| 按分支下载源码归档 | `/owner/repo/archive/refs/heads/main.zip` |
| Zipball / Tarball | `/owner/repo/zipball/ref`、`/owner/repo/tarball/ref` |
| Gist 最新 Raw | `/gist/user/gist-id/raw` 或 `/gist/user/gist-id/raw/file` |
| Gist 指定版本 Raw | `/gist/user/gist-id/raw/revision/file` |

`owner` 是 GitHub 用户或组织名，`repo` 是仓库名，`ref` 是分支、标签或提交。文件名含空格等字符时需进行 URL 编码，例如空格使用 `%20`。

例如，原始 Raw 地址 `https://raw.githubusercontent.com/owner/repo/main/config.yaml` 对应：

```text
https://proxy.example.com/raw/owner/repo/main/config.yaml
```

GitHub 文件代理读取公开内容，不向这些地址转发客户端 GitHub PAT。GitHub 凭证功能用于 GHCR 包下载。Gist 支持下述完整 URL 入口，其他文件使用表中的路径。

### 续传与免认证下载

已有部分文件时可以尝试断点续传，上游也需要支持 Range：

```powershell
curl.exe --fail --location --continue-at - --user proxy `
  "https://proxy.example.com/owner/repo/releases/download/v1.0.0/app.zip" `
  --output app.zip
```

对应类型已开放免认证后，可省略 `--user proxy`，例如开放了 `releases`：

```powershell
curl.exe --fail --location `
  "https://proxy.example.com/owner/repo/releases/download/v1.0.0/app.zip" `
  --output app.zip
```

### Gist Raw 选择性免鉴权下载

将 `ALLOW_ANONYMOUS` 设为 `"true"`，并在 `ANONYMOUS_ROUTES` 中加入 `gist`，部署后可通过以下地址免认证下载 Gist Raw：

```text
https://proxy.example.com/gist/user/gist-id/raw/file.txt
https://proxy.example.com/gist/user/gist-id/raw/revision/file.txt
```

也支持在代理域名后直接附加完整的 Gist Raw HTTPS URL：

```text
https://proxy.example.com/https://gist.githubusercontent.com/user/gist-id/raw/file.txt
https://proxy.example.com/https://gist.githubusercontent.com/gist/user/gist-id/raw/file.txt
```

这些完整 URL 入口使用相同的 Gist 路径校验与缓存规则，仅接受 `https://gist.githubusercontent.com` 和合法的 Gist Raw 路径，不接受其他域名、HTTP、用户信息或自定义端口。

匿名访问按验证后的路由类型判断。Gist 请求执行两级限流、路径校验和 `ALLOWED_GITHUB_REPOSITORIES` 白名单检查，重定向目标限定为 `gist.githubusercontent.com`。配置了白名单时，需要加入对应的 `用户名/gist-id`。

### 范围请求与缓存

文件下载支持 GET、HEAD、单段 `Range`、`If-Range` 和条件请求。文件下载的客户端查询参数会被丢弃，不能用于绕过缓存，也不支持用查询参数向上游传递私有下载令牌。Git 协议的请求与查询参数规则见下节。

只有未携带 GitHub 凭证、大小已知、未压缩、可公开缓存且不超过 1 MiB 的完整 200 响应会写入内部 Cache API；实际读取也有大小上限。GHCR 公开标签清单缓存 60 秒，其余符合条件的响应缓存一小时，清单的缓存键区分规范化后的 Accept 类型。较大或长度未知的内容直接流式传输，客户端断开后不会有后台缓存副本继续下载整个文件。对客户端始终返回 `private, no-store`，防止共享缓存绕过代理鉴权。

## Git HTTPS 克隆与拉取

支持公开 GitHub 仓库的 `git clone`、`git fetch`、`git pull` 和 `git ls-remote`，采用 [Git Smart HTTP 协议](https://git-scm.com/docs/gitprotocol-http)。不支持 SSH、`git://`、推送、Git LFS 或私有 GitHub 仓库；GitHub PAT 功能用于 GHCR，不转发到 Git 仓库。

### 免认证配置

Git 使用独立的 `git` 类型。在本地配置中开启总开关，并把 `git` 加入免认证列表；保留需要开放的其他类型。例如只开放 Git 和 Gist：

```jsonc
"vars": {
  "ALLOW_ANONYMOUS": "true",
  "ANONYMOUS_ROUTES": "git,gist"
}
```

修改后执行 `npm run deploy`。

### 克隆与更新

安装 Git 后，在客户端执行。以下两种地址等价，`.git` 后缀必须保留：

```powershell
git clone "https://proxy.example.com/https://github.com/owner/repo.git"
```

```powershell
git clone "https://proxy.example.com/owner/repo.git"
```

通过代理克隆后，`origin` 已指向代理，可直接更新：

```powershell
git -C repo pull --ff-only
```

已有本地仓库时，只修改该仓库的远端地址，然后拉取：

```powershell
git -C repo remote set-url origin "https://proxy.example.com/https://github.com/owner/repo.git"
git -C repo fetch origin
```

支持 Git 协议版本 0、1、2，以及 `--depth 1`、`--filter=blob:none` 等上游支持的拉取选项。源码压缩包使用归档下载路径。

若未开放 `git` 免认证，可使用 `https://proxy@proxy.example.com/owner/repo.git`，提示密码时输入 `PROXY_TOKEN`，也可使用自己的 Git 凭证管理器。不要把密码写进 URL。

### 协议与资源限制

仅转发 `GET/HEAD /owner/repo.git/info/refs?service=git-upload-pack` 和 `POST /owner/repo.git/git-upload-pack`。引用查询必须只有这一项固定参数，POST 不接受查询参数；`git-receive-pack` 推送接口被拒绝。

POST 只接受 Git 协商格式，支持未压缩或 gzip 编码，请求体上限 1 MiB（gzip 按传输大小计算），读取最多等待 15 秒；超限返回 413，超时返回 408。Git 响应直接流式返回，不进入共享缓存。克隆通常包含多次 HTTP 请求，每次都执行认证策略、白名单和限流。

Git 与文件下载共用 `ALLOWED_GITHUB_REPOSITORIES`，白名单填写 `owner/repo`，不带 `.git`。重定向仅限 `github.com` 的同一仓库与同一读取接口，仓库重命名后应改用最新地址。子模块需分别设置代理地址，并满足对应白名单。

## 本地开发与常用命令

### 本地开发

首次生成个人配置后，复制本地密钥示例：

```powershell
npm run configure
Copy-Item .dev.vars.example .dev.vars
```

Linux/macOS 的复制命令是 `cp .dev.vars.example .dev.vars`。已经存在 `.dev.vars` 时直接编辑，不要用示例覆盖已有密码。

在 `.dev.vars` 中把示例值改成自己的本地开发密码：

```dotenv
PROXY_TOKEN=replace-with-your-local-random-token
```

然后启动：

```powershell
npm run dev
```

按终端打印的本地地址访问，通常为 `http://localhost:8787`，用本地密码通过 curl 等客户端测试 GitHub 文件或 HTTP 接口。`.dev.vars` 只用于本地开发，不会通过 `npm run deploy` 自动变成线上 Secret。Docker/ORAS 正式使用请连接部署后的 HTTPS 域名。

### 命令速查

以下命令在本项目根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件重新安装依赖 |
| `npm run configure` | 创建个人配置，已有文件不覆盖 |
| `npm run secret:put` | 交互式设置或更换线上 `PROXY_TOKEN` |
| `npm run dev` | 使用个人配置和本地变量启动开发服务 |
| `npm run deploy` | 使用个人配置部署到 Cloudflare |
| `npm run deploy -- --dry-run` | 本地打包检查，不执行部署 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 使用 workerd/Miniflare 测试 Worker |
| `npm run types` | 根据公开模板重新生成类型声明 |

直接调用 Wrangler 时记得指定个人配置，例如 `npx wrangler secret list --config wrangler.local.jsonc`。`npm run types` 特意使用公开模板，以免将个人变量复制到要提交的类型文件中。

### 验证

```powershell
npm run typecheck
npm test
npm run deploy -- --dry-run
```

`npm test` 使用 Wrangler 自带的 workerd/Miniflare 运行 Worker，并模拟上游网络。测试覆盖公开/私有 GHCR 认证、OCI 下载、Git 协商与推送拦截、用户与缓存隔离、权限撤销、Blob 重定向、各类型免认证、白名单、限流、范围请求和路径校验。真实服务的端到端验证需要使用自己的包和客户端。

## 常见问题

| 现象 | 排查方法 |
| --- | --- |
| 返回 401 或弹出 Basic 登录框 | 当前类型需要代理认证。GitHub 文件和公开 GHCR 包输入实际代理密码；私有 GHCR 使用真实 GitHub 用户名和复合密码。浏览器可以响应 Basic 提示，但不会自动复用 Docker 的登录信息 |
| 返回 503，提示配置 `PROXY_TOKEN` | 目标 Worker 尚未设置 Secret；运行 `npm run secret:put`，确认账号和 Worker 名称正确 |
| 返回 503，提示缺少限流绑定 | 检查 `wrangler.local.jsonc` 是否保留两个 `ratelimits` 绑定，并重新部署 |
| 返回 403，提示仓库不允许 | 检查对应白名单，Gist 要填写 `user/gist-id`；空字符串表示禁止全部该类仓库 |
| 私有 GHCR 返回 403 | 检查 GitHub 用户名、PAT 是否有效、是否具有 `read:packages`、账号是否有包读取权，以及组织 SSO 授权 |
| 已开放 `ghcr`，公开镜像仍返回 403 | 检查客户端是否保存了错误或失效的 GitHub 凭证；携带凭证的请求失败时不会自动降级匿名访问，可先 `docker logout proxy.example.com` 再拉取公开包 |
| 修改免认证配置后仍需密码 | 修改的是 `wrangler.local.jsonc`，总开关为字符串 `"true"`，列表含正确类型，并已执行 `npm run deploy`；只改公开模板不会覆盖已有本地文件 |
| 返回 400 | 检查 GHCR Basic 格式；复合密码与独立 `X-GHCR-Authorization` 不可同时使用，普通 GitHub 受保护路由也不接受该 GHCR 专用头 |
| 返回 404 | 路径可能不在支持范围，或上游文件/包/标签不存在；除 Gist 外，不要使用 `/https://任意域名/...` 写法 |
| 返回 405 / 406 / 416 | 分别检查是否使用了不支持的方法、manifest 的 Accept 类型、或多段/无效 Range |
| 返回 429 | 请求达到代理或 GHCR 限流，降低并发并稍后重试；代理自身的 429 包含 `Retry-After: 60` |
| 返回 502 | 上游响应头超时、令牌服务异常或出现不允许的重定向；先检查上游和目标地址，不要直接取消域名校验 |
| 部署报错 `100328`，CPU limits 不支持 Free | 移除个人配置中额外添加的自定义 `limits`，使用模板中的默认设置；本地 dry-run 不会校验线上账号套餐限制 |
| PowerShell 不认识 `read -rsp` 或 `unset` | 这是 Bash 命令，改用 PowerShell 标注的示例，或在真正的 Bash 终端运行 |
| `npm ci` 报依赖漏洞 | 运行 `npm audit` 查看公告和影响范围，按 [SECURITY.md](SECURITY.md) 中的方法检查依赖更新 |

## 上传 GitHub 与凭证保护

| 内容 | 保存位置 | 提交到 GitHub |
| --- | --- | --- |
| 通用部署配置 | `wrangler.jsonc`，保留示例域名和通用值 | 是 |
| 真实域名、Worker 名称、账号 ID、限流编号、策略及私人仓库列表 | `wrangler.local.jsonc` | 否，已忽略 |
| 线上 `PROXY_TOKEN` | Cloudflare Worker Secret | 否 |
| 本地开发密码 | `.dev.vars` | 否，已忽略 |
| 本地变量示例 | `.dev.vars.example`，只保留占位值 | 是 |
| GitHub PAT | 拉取客户端的凭证存储 | 否 |
| 依赖、日志、本地状态及部署产物 | `node_modules/`、`.wrangler/`、`dist/` | 否，已忽略 |

`.env*` 和 `.dev.vars*` 也被忽略，示例文件除外。上传前用 `git status --short` 和 `git diff --cached` 检查实际提交内容；不要将真实密码写入 URL、README、公开模板或脚本。

不要提交密钥或私密配置。忽略规则不能撤销已经提交的敏感内容；凭证泄漏后应撤销或更换，并按需清理 Git 历史。

Docker/ORAS 登录凭证由客户端凭证存储管理。

项目代码不提供下载历史查询接口，也不主动记录正常下载日志。Cloudflare 平台日志、请求指标及可见权限取决于部署账号的设置，不能把它当作匿名服务；上游仍能观察回源请求。

费用风险及部署层面的剩余措施见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖和生成文件中的版权与许可声明遵循各自条款。
