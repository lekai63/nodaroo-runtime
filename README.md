# nodaroo-runtime

`free.nodaroo.com`（Pterodactyl / Heliactyl node.js egg）上的 shoes + paseo 运行时。

- 薄入口 `index.js`，逻辑按功能拆到 `src/`。
- 敏感信息全部走 `secrets.json`，**不进 Git**；repo 里只有 `secrets.example.json`。
- 非敏感配置可放 `config.local.json`，不填则使用 `src/config.js` 的默认值。
- 当前默认：`publicHost=se2.nodaroo.fun`、shoes 0.3.8、paseo 0.17.3、paseo 监听 `127.0.0.1:6768`、relay 开启；**paseo + pi + opencode 三个 CLI 都由 `npm install` 自动安装**并注册为 provider（见「默认 provider：pi / opencode」）；mistral-vibe / Muse Code 的 **CLI 仍需自行安装**（见「添加 agent provider」）。

## 目录

```text
index.js              # MAIN_FILE 入口
src/
  main.js             # 编排
  shoes.js            # 下载/写 config.yaml/启动 shoes
  paseo.js            # 启动 paseo、生成配对 URI
  paseo-config.js     # 向 .paseo/config.json 合并 provider（含 env 白名单）
  vibe.js             # mistral-vibe ACP provider
  native-providers.js # paseo 内置 provider：pi / opencode
  config.js           # PATH、路径、config.local.json / secrets.json
  util.js             # log / sh / paseoExec / redact / 状态页
package.json
config.example.json
secrets.example.json
.gitignore
```

## 面板设置

| 面板项 | 建议值 | 说明 |
| --- | --- | --- |
| `GIT_ADDRESS` | CNB 仓库的 HTTPS clone URL | 私有 repo 需要配合 `USERNAME` / `ACCESS_TOKEN` |
| `BRANCH` | `main` | |
| `USER_UPLOAD` | `0` | 让面板走 clone/install；设 1 会跳过安装 |
| `AUTO_UPDATE` | 先 `0` 验证，稳定后 `1` | 启动命令里的 `[[ 0 == "1" ]]`；1 = 每次启动 `git pull` |
| `MAIN_FILE` | `index.js` | |
| Docker image | `nodejs_24` | pi 要求 ≥22.19；24 已验证 |
| `NODE_PACKAGES` | 空 | 依赖交给 `package.json` |
| `UNNODE_PACKAGES` | 空 | |
| `USERNAME` / `ACCESS_TOKEN` | 私有 repo 必填 | CNB 只读访问令牌/部署令牌；不要写进 URL 或 README |

### 私有仓库凭据

CNB 私有 repo 不能匿名 clone。面板的 `USERNAME` / `ACCESS_TOKEN` 填 CNB 的**只读**访问令牌/部署令牌（用户名按 CNB 页面说明，常见为 `cnb`）。

- token 只给这个 repo 读权限，不要复用个人全权限 token。
- 不要把 token 写进 `GIT_ADDRESS`（会出现在命令/日志里）。
- 如果面板 clone 仍失败，用 SFTP 上传 release zip 兜底，并把 `AUTO_UPDATE` 设为 `0`。

## 首次部署

1. 把本目录推到 CNB 私有仓库，记下 HTTPS clone URL。
2. 面板填好上面的设置；`AUTO_UPDATE` 先保持 0，避免首次安装时被 `git pull` 干扰。
3. 触发面板安装/重装，让 egg clone 仓库；如果不想重装，也可以在容器 shell 里手工接管：
   ```bash
   cd /home/container
   git init
   git remote add origin <CNB clone URL>
   git fetch origin main
   git checkout -f -B main origin/main
   ```
   `-f` 只覆盖 repo 跟踪的文件，未跟踪的 `.paseo`、`secrets.json`、`config.local.json` 会保留。
4. 用 SFTP 上传两个本地文件（不要提交到 Git）：
   - `secrets.json`：从 `secrets.example.json` 复制，填入旧的 Reality 凭据、用户 ID、`paseoPassword`（自己设的强口令）、可选的 `mistralApiKey`。
   - `config.local.json`（可选）：从 `config.example.json` 复制，改 `publicHost`、端口、开关等。
5. 点 Start。首次启动会 `npm install`（paseo 约 700 MB，加 pi / opencode，可能几分钟），然后执行 `index.js`。
6. 看日志：
   - `[shoes] ...` / `shoes check: Configuration valid`
   - `[paseo] ...` / `[paseo] pairing URI written ...`
   - `[paseo] provider pi configured` / `[paseo] provider opencode configured`（再次启动变为 `already configured and usable`）
   - `[paseo] provider mistral-vibe configured`（如果装了 `vibe-acp`）
7. 验证通过后，把 `AUTO_UPDATE` 打开；以后 push 到 CNB，下次启动会 `git pull`，随后 `npm install` 再跑 `index.js`。

## 换节点 / 换域名

`publicHost` 不在代码里，放 `config.local.json`（已 gitignore，上传到 `/home/container/config.local.json`）：

```json
{ "publicHost": "se2.nodaroo.fun" }
```

换 server 或节点后：

1. 面板 Network 页确认新的分配域名/IP。
2. 只改本地 `config.local.json` 的 `publicHost`；如果面板只给 IP，就填 IP（Reality 的伪装 SNI 仍是 `realitySni`，不受影响）。
3. SFTP 覆盖 `/home/container/config.local.json`。
4. 重启；`client.yaml.txt` 会用新 host 重新生成。
5. 新 server 的 `.paseo` 是新的：重新下载 `paseo-pair.json` 并 `paseo host add`；`secrets.json` 也要重新上传。

`config.local.json` 还可以覆盖 `config.example.json` 里的其它非敏感项（`shoesVersion`、`paseoPort`、`vibeEnabled`、`piEnabled`、`opencodeEnabled` 等），不填则用 `src/config.js` 的默认值。启动时如果该文件缺失或没有 `publicHost`，日志会打印一条 `[config] ... using default ...` 警告。

## secrets.json

从 `secrets.example.json` 复制，字段对应：

| 字段 | 来源 |
| --- | --- |
| `realityPrivateKey` | 旧部署文件的 `REALITY_PRIVATE_KEY` |
| `realityPublicKey` | 旧部署文件的 `REALITY_PUBLIC_KEY` |
| `realityShortId` | 旧部署文件的 `REALITY_SHORT_ID` |
| `vlessUserId` | 旧部署文件的 `VLESS_USER_ID` |
| `vmessUserId` | 旧部署文件的 `VMESS_USER_ID`（可选，WS 入站用） |
| `paseoPassword` | 你的 paseo daemon 密码（强口令） |
| `mistralApiKey` | 可选；填了会注入 `mistral-vibe` provider 的 `env` |

**不要把 `secrets.json` 提交到 Git。** `.gitignore` 已排除。

## SFTP

面板提供 SFTP（端口 `2022`，地址/用户名/密码见面板），适合：

- 上传 `secrets.json` / `config.local.json`；
- 下载 `paseo-pair.json`、`shoes.log`、`config.yaml`；
- 备份/恢复 `.paseo`（paseo 的 serverId、密钥和会话历史）。

SFTP 不是 shell，不能执行 `git pull` / `npm install`；代码更新走 Git + `AUTO_UPDATE`，SFTP 只负责文件。

## 更新与回滚

- 更新：改 repo → push → `AUTO_UPDATE=1` 时下次启动 `git pull` + `npm install`；`AUTO_UPDATE=0` 时手动 pull 或重新上传。
- 回滚：repo 回退到上一个 commit → push（或切 branch）→ 重启。
- 不要在服务器上直接改 repo 跟踪的文件（`index.js`、`src/`、`package.json`）；`git pull` 会冲突。运行期配置一律放 `secrets.json` / `config.local.json`。

## 添加 agent provider（mistral-vibe / pi / Muse Code / 其它）

### 先分清三层（最容易误判的地方）

Paseo 只是编排层，**自己不带任何 agent CLI**（官方 Docker 镜像也不带）。一个 provider 真正可用要三样齐全：

1. **provider 定义**：`~/.paseo/config.json` 的 `agents.providers.<id>`，只描述「用什么命令启动」。Paseo 自带一份 provider 目录，很多 agent **没装 CLI 时定义就已经在 config.json 里**——所以 `grep` 到 `mistral-vibe` 不能证明它能用。
2. **CLI 二进制**：必须装在 daemon 主机（本容器）上，且在 paseo 子进程的 PATH 里。本运行时已把 `~/.local/bin` 和 `~/node_modules/.bin` 放到子进程 PATH 最前（`src/config.js`）。
3. **凭据**：agent 自己的登录态或 API key（如 `MISTRAL_API_KEY`），paseo 不代管。

容器里没有 `sudo`，所有命令在容器 shell 里以 `container` 用户执行即可。

### 默认 provider：pi / opencode（随 `npm install` 自动安装）

`package.json` 的 `dependencies` 固定了 `@getpaseo/cli`（paseo）、`@earendil-works/pi-coding-agent`（pi）、`opencode-ai`（opencode）三个版本，面板启动时的 `npm install` 把它们一并装到 `~/node_modules/.bin`。`opencode-ai` 的 postinstall 会按容器的 CPU（是否支持 AVX2）和 libc（glibc / musl）自动选对应的平台二进制。

`src/native-providers.js` 在 daemon 就绪后把 pi / opencode 注册进 `.paseo/config.json` 的 `agents.providers`：只写 `command`（绝对路径）、`enabled: true` 和 env 白名单，**不写 `extends`**（它们是 paseo 内置 provider，不是 ACP 派生）、**不写 `models`**（模型列表由 CLI 运行时上报）。条目不存在则写入，已存在但不可用（如 `enabled: false`、相对路径命令）则纠正，可用则跳过。

Paseo 只负责拉起 CLI，**凭据要各自配置**，二选一：

- 用 SFTP 上传登录态文件：pi 是 `~/.pi/agent/auth.json`，opencode 是 `~/.local/share/opencode/auth.json`；
- 或在容器 shell 里跑 `pi` 后 `/login`、`opencode auth login`。面板不能设环境变量，所以 API key 走文件而不是 env。

开关（`config.local.json`）：`"piEnabled": false` / `"opencodeEnabled": false` 可让 runtime 不再注册对应 provider，默认都是 `true`。注意开关只管自动注册：已经写进 `.paseo/config.json` 的条目不会被删，需要在客户端里禁用或删除。

升级版本：改 `package.json` 里对应的版本号 → push → 重启（`npm install` 收敛 `node_modules`，runtime 下次启动把 `command` 指向的仍是同一路径，无需额外操作）。换新 server 后要重新上传两份 auth 文件。

验证：`~/node_modules/.bin/paseo provider diagnostic pi --json --home ~/.paseo`（`opencode` 同理），输出里 `Status: Ready` 表示 daemon 能拉起该 CLI；`Models` 取决于是否已配凭据。

### Mistral Vibe（本项目可自动注册，但 CLI 要自己装）

`src/vibe.js` 在 `vibeEnabled=true` 且检测到 `~/.local/bin/vibe-acp` 时会注册 `mistral-vibe`；文件不存在则只打印 `[vibe] ... not found; skip`。默认 `vibeEnabled=true`，但**二进制不会自动安装**。

1. 安装（官方）：`curl -LsSf https://mistral.ai/vibe/install.sh | bash`，或 `uv tool install --python 3.14 mistral-vibe`（需 Python ≥3.12，暂避开 3.15；uv 会自动下载 Python）。装完应有 `vibe` 和 `vibe-acp`，Linux 下默认落在 `~/.local/bin/`，正好对上 `src/config.js:6` 的期望路径。
2. 凭据二选一：`secrets.json` 填 `mistralApiKey`（`src/vibe.js:23-25` 注入 `MISTRAL_API_KEY`），或在容器里跑 `vibe --setup` 登录。
3. 重启运行时；日志里应出现 `[paseo] provider mistral-vibe configured` 或 `already configured`。
4. 验证：`vibe --version`、`~/.local/bin/vibe-acp --help`、`~/node_modules/.bin/paseo provider diagnostic --json`。

> `src/paseo-config.js` 的 `ensureProvider()` 对已存在且可用的 provider 跳过、不覆盖；Paseo 目录自带的 `mistral-vibe` 会保留（其 `command` 通常是 PATH 中的 `vibe-acp`），因此只要二进制在 PATH 上即可，不必强求绝对路径。

### Muse Code（Meta）

Paseo 内置且默认启用，通过 `muse serve` 走 MSP，需 Muse ≥1.3.0（官方验证 1.4.1）：

1. 安装：`curl -fsSL https://dev.meta.ai/install.sh | sh`。
2. 认证：`muse login`，或在 daemon 环境设 `META_API_KEY`。
3. 在 Paseo 里选 Muse Code 即可；可用模型由 Muse 自己的配置决定。
4. 想改默认参数（沙箱默认关、workspace trust 默认开），写 `agents.providers.muse.options`：

   ```json
   { "agents": { "providers": { "muse": { "options": {
     "sandbox": { "enabled": true, "network": "proxy-only" },
     "trustWorkspace": false
   } } } } }
   ```

### 其它 provider：三种添加方式

1. **原生**（Antigravity/`agy`、Claude Code、Codex、GitHub Copilot、fx、Hoplite、Oh My Pi、OpenCode、Pi）：pi 和 opencode 已是默认 provider（见上）；其余的装 CLI → 登录/配 key，多数会自动出现在 Paseo；没出现就在 App 里 **Settings → Hosts → 本机 → Providers → + Provider** 添加（`fx`、`Hoplite` 需要从 Settings 添加）。
2. **ACP 目录**（Gemini CLI、Qwen Code、GLM Agent、goose、Cline、Cursor、Codebuddy Code、Kiro CLI、Mistral Vibe 等 40+）：若条目不是通过 `npx`/`uvx` 启动，先在容器装对应 CLI；再走 Settings → + Provider → 从目录选 Add。缺 CLI 时页面显示 **Not installed**。目录是版本锁定的权威来源：<https://paseo.sh/docs/supported-providers>。
3. **目录里没有的**：手写 `agents.providers`。ID 必须匹配 `^[a-z][a-z0-9-]*$`；自定义条目必须有 `extends`（一等 provider ID 或 `"acp"`）和 `label`；ACP agent 还要给 `command`（数组，首元素是二进制，其余是参数）。改完执行 `paseo reload`。例：

   ```json
   {
     "agents": {
       "providers": {
         "my-gemini": { "extends": "acp", "label": "Gemini", "command": ["gemini", "--acp"] },
         "my-claude": { "extends": "claude", "label": "Claude (proxy)", "env": {
           "ANTHROPIC_BASE_URL": "https://proxy.example.com/v1",
           "ANTHROPIC_API_KEY": "sk-..."
         } }
       }
     }
   }
   ```

   字段全参考：<https://paseo.sh/docs/custom-providers>。

### 配置落点与改法

provider 配置都写进容器的 `~/.paseo/config.json`（本项目 `PASEO_HOME=H + "/.paseo"`），**不要写 repo 跟踪的文件**（`git pull` 会冲突）。推荐用 paseo CLI 改，避免手写 JSON 出错：

```sh
~/node_modules/.bin/paseo daemon config get agents.providers --home ~/.paseo
~/node_modules/.bin/paseo daemon config set agents.providers '<整段 JSON>' --home ~/.paseo
~/node_modules/.bin/paseo daemon reload --home ~/.paseo        # 直接改 config.json 时也可用 paseo reload
~/node_modules/.bin/paseo provider diagnostic --json          # 看解析到的二进制、daemon PATH 与版本
```

`src/paseo-config.js:28-53` 的 `ensureProvider()` 就是按这套 `daemon config set` + `daemon reload` 自动写的。不要把 key 贴进日志或 README；密钥统一放 `secrets.json`。

## 注意

- `.paseo` 和 `paseo-pair.json` 都等同凭据；离机备份请加密。
- `AUTO_UPDATE=1` 会让启动依赖 CNB 可达性；网络异常时启动可能被 `git pull` 拖住。可以先保持 0，稳定后再开。
- 容器若为 Alpine(musl)，paseo 的 node-pty 会加载失败；本项目按 `nodejs_24`（glibc）验证。
- 本地干跑：`NODAROO_HOME=/tmp/nodaroo-test node index.js`（无 secrets 时会跳过 shoes/paseo，只验证模块加载）。
- 语法检查：`npm run check`。
