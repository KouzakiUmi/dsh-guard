# Codex 审批与沙盒设计参考

> 面向 dsh-guard 的技术参考。目标是把 OpenAI Codex 的审批决策链与沙盒设计讲清楚，并逐条判定哪些机制能映射到 DSH 已有的官方 API、哪些不能。
>
> 抓取与取证日期：**2026-10-05**。本文所有外部资料均于该日通过 `web_fetch` 抓取官方页面原文；所有本机取证均于该日只读采集，未运行 Codex、未修改任何 Codex 或 DSH 文件。

---

## 0. 阅读须知：证据分级与不可核实项

本文每条结论都标注来源，分三级：

| 标记 | 含义 |
|---|---|
| **[本机]** | 读取本机实际安装产物或配置文件得到的事实，附绝对路径与行号／原文片段 |
| **[官方文档]** | OpenAI 官方文档页面原文，附 URL 与抓取日期 |
| **[源码文档]** | openai/codex 仓库内的 markdown 原文，附 raw URL 与抓取日期 |
| **[推断]** | 由上述证据推导，**未经直接核实**，仅作参考 |
| **[未核实]** | 未能取得证据，不做补全 |

**关于"Codex 实际实现"与"文档声称"的区分**：本机安装的 Codex CLI 是 Rust 编译产物（`C:\Users\Fractal\.codex\.sandbox-bin\codex.exe`，321,953,584 字节，另有 `.sandbox-bin\codex-command-runner-0.160.0.exe` 8,207,152 字节），无法逐行阅读源码。因此本文中**所有关于 Rust 内部实现细节的描述均为「文档声称」或「本机运行态观察」，没有一条来自逐行源码审计**。本机可核实的只有三类产物：配置文件、规则文件、沙箱状态与日志。

---

## 1. Codex 审批决策流程

### 1.1 完整判定链

Codex 的审批不是一个开关，而是**四段串联**。以下每一段都有出处。

#### 第 1 段：自动分类（不询问用户）

命令先被 execpolicy 引擎按 token 前缀匹配规则，得到一个 `decision`。规则语言是 Starlark 子集，核心函数为 `prefix_rule(pattern=[...], decision?, justification?, match?, not_match?)` **[源码文档]**（<https://raw.githubusercontent.com/openai/codex/main/codex-rs/execpolicy/README.md>，2026-10-05 抓取）：

- `decision` 默认为 `allow`，合法值 `allow` / `prompt` / `forbidden`。
- 多规则命中时，**最严格者胜**：`forbidden` > `prompt` > `allow`（同 README 的 "The effective `decision` is the strictest severity across all matches"）。
- 无规则命中时 `matchedRules` 为空数组，`decision` 字段被省略。

命令字符串在分类前会先被**切段**。同 README 与官方 Rules 文档记载：命令在 shell 控制算子处被切成独立段（管道 `|`、`&&`、`||`、命令分隔符 `;`、子 shell 边界 `(...)` / `$(...)`），每段独立评估 **[源码文档 + 官方文档]**。

对 `bash -lc` / `bash -c` / `zsh` / `sh` 形式，Codex 用 tree-sitter 解析脚本，**仅当脚本是线性链**（只有普通词、无变量展开、无通配符、用 `&&`/`||`/`;`/`|` 连接）时才切分；一旦出现重定向、命令替换、`VAR=...`、通配符、控制流，就**不切分**，整个调用被当作单个 `["bash", "-lc", "<full script>"]` 套用规则 **[官方文档]**（<https://learn.chatgpt.com/docs/agent-configuration/rules.md>，2026-10-05 抓取）：

```text
["bash", "-lc", "git add . && rm -rf /"]
→ 切成 ["git", "add", "."] 与 ["rm", "-rf", "/"]
→ 即便 allow pattern=["git","add"]，也不会放行整条，因为 rm -rf / 被独立评估
```

#### 第 2 段：何时询问

分类结果为 `prompt` 时进入询问。是否真的弹窗还受第二个正交旋钮 `approval_policy` 控制 **[官方文档]**（<https://learn.chatgpt.com/docs/config-file/config-reference.md>，2026-10-05 抓取，本地副本 `config-reference.md:155-195`）：

```toml
approval_policy = "on-request" | "never" | { granular = { ... } }
```

- `on-request`：模型可自行决定何时请求越权。
- `never`：不停下来问。
- `granular`：把**五类提示**各自设为可弹窗或自动拒绝——`sandbox_approval`（沙箱越权）、`rules`（execpolicy `prompt` 规则触发）、`mcp_elicitations`、`request_permissions`、`skill_approval`。
- `untrusted` **已废弃并移除**，可能导致客户端无法启动；官方给出的迁移路径是 `[projects."<path>"] trust_level = "untrusted"`，让命令默认需要批准，但**禁用项目本地配置** **[官方文档]**（<https://learn.chatgpt.com/docs/agent-approvals-security.md>，2026-10-05 抓取）。
- `on-failure` 已 deprecated。

第三旋钮 `approvals_reviewer = "user" | "auto_review"` 决定弹窗给谁看，默认 `user` **[官方文档]**（同上 config-reference `approvals_reviewer` 条目）。`auto_review` 是**评审者替换，不是权限放宽**：文档明确 "It is a reviewer swap, not a permission grant. It does not expand `writable_roots`, enable network access, or weaken protected paths."（<https://learn.chatgpt.com/docs/sandboxing/auto-review.md>，2026-10-05 抓取）。

#### 第 3 段：用户选择

Codex 的审批结果有**五个取值**。官方 OTel 指标表直接列出了这组枚举 **[官方文档]**（<https://learn.chatgpt.com/docs/config-file/config-advanced.md>，2026-10-05 抓取，本地副本 `config-advanced.md:569`）：

```markdown
| `approval.requested` | counter | `tool`, `approved` |
  Tool approval request result
  (`approved`, `approved_with_amendment`, `approved_for_session`, `denied`, `abort`). |
```

对应关系：

| 取值 | 含义 | 授权范围 |
|---|---|---|
| `approved` | 单次批准 | 仅这一条命令／这一次调用 |
| `approved_with_amendment` | 用户修改了命令后再批准 | 仅修改后的这一条 |
| `approved_for_session` | 本会话内放行 | 会话内等价调用 |
| `denied` | 拒绝 | 无 |
| `abort` | 中断 | 无 |

官方 sandboxing 文档在权限章节独立确认了多档 scope 的存在 **[官方文档]**（<https://learn.chatgpt.com/docs/sandboxing.md>，2026-10-05 抓取）：

> When an approval offers different scopes, such as approving once or for the session, choose the narrowest scope that lets the task continue.

也就是说，**Codex 官方推荐"选最窄的 scope"，而不是无脑选最宽的**。

此外还有第四类入口：模型可在请求越权时**主动提议**一条 `prefix_rule`，它会展示给用户并附带"持久化该规则供未来会话使用"的选项 **[源码文档]**（<https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request.md>，2026-10-05 经搜索摘要获得全文要点）：

> Optionally suggest a `prefix_rule` - this will be shown to the user with an option to persist the rule approval for future sessions.

同提示词给出的前缀建议规范（对 dsh-guard 直接可抄，见 §5.4）：

> **Banned prefix_rules**：避免请求过宽前缀，例如不要用 `["python3"]`、`["python", "-"]` 这类可执行任意脚本的前缀。**绝不要**为 `rm` 这类破坏性命令提供 `prefix_rule`。命令使用 heredoc 或 herestring 时**绝不**提供 `prefix_rule`。
> 好的前缀示例：`["npm", "run", "dev"]`、`["gh", "pr", "check"]`、`["cargo", "test"]`。

#### 第 4 段：授权范围与记忆

Codex 的持久授权**不是运行时授权缓存，而是一份声明式规则文件**。这是本次调研最关键的发现。

**[官方文档]**（<https://learn.chatgpt.com/docs/agent-configuration/rules.md>，2026-10-05 抓取）：

> When you add a command to the allow list in the TUI, Codex writes to the user layer at `~/.codex/rules/default.rules` so future runs can skip the prompt.

**[本机]** 该文件在本机真实存在，内容是一条完整落盘的授权规则：

```
路径：C:\Users\Fractal\.codex\rules\default.rules
大小：177 字节，最后修改 2026-09-12 16:38:24
全文：
prefix_rule(pattern=["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "Remove-Item -LiteralPath \"$env:TEMP\\epc\\propose.py\" -Force; \"removed\""], decision="allow")
```

这条规则把一条**完整命令**（可执行文件绝对路径 + 参数）记为 `allow`，跨会话生效。这坐实了三件事：记忆介质是纯文本规则文件；记忆键是**命令 token 前缀**；作用域是**跨会话的用户级**。

规则文件的**加载面**与**加载时机**（同官方文档）：

- Codex 在**启动时**扫描每个活跃配置层下的 `rules/`，包括团队配置位置与用户层 `~/.codex/rules/`。
- 项目本地规则位于 `<repo>/.codex/rules/`，**仅当项目 `.codex/` 层被信任时才加载**。
- 官方文档第 3 步明确写 "Restart Codex"；社区与 issue 讨论同样记录 "Rules are loaded at startup, so restart your Codex app/session"。
  **[未核实]** 该"需重启才生效"来自官方文档的操作步骤与第三方描述，**未从 Codex 源码直接确认是否存在热加载路径**。

#### 授权作用域矩阵

| 作用域 | 载体 | 生命周期 | 撤销方式 | 出处 |
|---|---|---|---|---|
| 单次 | 内存中的当前决定 | 一次调用 | 无需撤销 | config-advanced OTel 枚举 `approved` |
| 本会话 | 会话内已批准命令向量 | 进程/会话 | 重启即失效 | config-advanced `approved_for_session` + GitHub issue #4212 |
| 单命令前缀（跨会话） | `~/.codex/rules/default.rules` | 跨会话，重启后加载 | 编辑或删除该 `.rules` 文件 | rules.md + 本机 default.rules |
| 项目内命令前缀 | `<repo>/.codex/rules/*.rules` | 跨会话，限该项目且需项目层受信任 | 删除文件 | rules.md |
| 路径白名单（跨会话） | `[sandbox_workspace_write] writable_roots` 或 `[permissions.<name>.filesystem]` | 跨会话 | 改 config.toml | config-reference + permissions.md |
| 目录信任 | `[projects."<path>"] trust_level` | 跨会话 | 改 config.toml | 本机 config.toml + agent-approvals-security.md |

**[本机]** 本机 `C:\Users\Fractal\.codex\config.toml` 实际内容里，信任与沙箱相关键为：

```toml
[projects.'c:\users\fractal']
trust_level = "trusted"
[projects.'d:\dsh-subusage']
trust_level = "trusted"
[projects.'d:\pyasar']
trust_level = "trusted"

[windows]
sandbox = "elevated"
```

同文件**没有** `approval_policy`、`sandbox_mode` 顶层键，说明本机使用 CLI/桌面端默认值。

### 1.2 「授权一次」与「永久允许」在 Codex 里到底怎么落地

这是 dsh-guard 最关心的问题，答案分三层：

1. **一次**（`approved`）= 纯内存，不写任何文件。这是 Codex 的默认路径。
2. **本会话**（`approved_for_session`）= 会话内命令向量缓存，**不写文件**，重启即失效。
3. **跨会话** = 写 `.rules` 文件。这条路径的官方描述是"TUI 里加入 allow list 时 Codex 写入 `~/.codex/rules/default.rules`"，即**由用户在 allow list 界面显式选择**，而非审批弹窗的默认按钮。

**[本机+官方文档]** 由此可以确认：Codex 的"永久"是**用户主动把规则落成文件**，且 Codex 并不替用户在审批弹窗里默认勾选永久。rules.md 用了 "**may** propose a `prefix_rule` ... Review the suggested prefix carefully **before accepting it**" 的措辞——模型只能提议，接受由用户决定。

### 1.3 一个必须记取的失败案例

**[官方 GitHub issue]** <https://github.com/openai/codex/issues/4212>（2026-10-05 经 GitHub API 抓取，标题 "Windows approval 'Allow for this session' isn't remembered"，labels `bug` / `windows-os` / `sandbox`，state `open`，44 条评论，2026-08-18 最后更新）：

> Codex repeats the approval prompt because the stored command vector only matches the PowerShell-wrapped version that actually ran, not the original `bash -lc …` the UI shows and the model reuses.
>
> Additional information: Bug reproduces reliably on Windows because exec command translation swaps the command vector before caching. Broad fix is to store both the displayed command and the executed command when the user approves "for this session."

**对 dsh-guard 的直接含义**：记忆键必须锚定在**规范化后的实际执行目标**上，而不是 UI 展示字符串、也不是模型提议的字符串。本机 sandbox 日志正好印证了这个断裂点——`C:\Users\Fractal\.codex\.sandbox\sandbox.2026-10-04.log` 中记录的 `START:` 行是 PowerShell 包装后的实际命令行：

```
[2026-10-04 09:32:34.464 codex.exe] START: C:\Program Files\PowerShell\7\pwsh.exe -NoProfile -Command try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}
git status --short --branch; git log -6 --oneline --decorate
```

而模型侧的调用形态是另一串。两者不一致就会让前缀记忆失效。

---

## 2. Codex 沙盒设计

### 2.1 权限档位枚举

Codex 目前**并存两套**权限系统，官方文档明确它们**不组合** **[官方文档]**（<https://learn.chatgpt.com/docs/permissions.md>，2026-10-05 抓取）：

> Permission profiles do not compose with the older sandbox settings. Configure either `default_permissions` and `[permissions]`, or `sandbox_mode` / `sandbox_workspace_write`, but not both. If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or the selected config profile sets `sandbox_mode`, Codex uses those older sandbox settings instead.

#### 旧体系：`sandbox_mode`（三档）

| 值 | 含义 | 出处 |
|---|---|---|
| `read-only` | 可读文件、跑命令，但不能编辑，越界需批准 | config-reference `sandbox_mode` |
| `workspace-write` | 可在 workspace 内编辑与运行命令；**默认** | 同上 + agent-approvals-security |
| `danger-full-access` | 无沙盒限制 | 同上 |

`[sandbox_workspace_write]` 子表提供三到四个额外旋钮 **[官方文档]**（config-advanced.md:359-363，config-reference.md:221-234）：

```toml
[sandbox_workspace_write]
exclude_tmpdir_env_var = false   # 是否放行 $TMPDIR
exclude_slash_tmp = false        # 是否放行 /tmp
writable_roots = ["/Users/YOU/.pyenv/shims"]   # 追加可写根
network_access = false           # 是否放行出网
```

#### 新体系：permission profiles（beta）

内置三个 profile：`:read-only`、`:workspace`、`danger-full-access`（后者不能被继承）。命名 profile 形如 `[permissions.<name>]`，支持 `extends`、`workspace_roots`、`filesystem`、`network` 四个子表 **[官方文档]**（permissions.md）。

**优先级规则**（permissions.md，"Filesystem permissions" 一节）：

> More specific entries override broader entries. When two entries target the same path, `deny` takes precedence over `write`, and `write` takes precedence over `read`.

即 `deny` > `write` > `read`，且更具体路径覆盖更宽路径。这是**目录外写操作表达方式**的核心答案。

### 2.2 路径级规则如何表达（目录外写操作）

#### 路径取值域

permissions.md 列出的合法路径形式：

| 形式 | 含义 | 支持 scoped subpaths |
|---|---|---|
| `:root` | 文件系统根 | 仅 `.` |
| `:minimal` | 工具运行所需的平台最小集 | 仅 `.` |
| `:workspace_roots` | 会话运行时 workspace roots ∪ profile 定义的 roots | 是 |
| `:tmpdir` | `$TMPDIR` | 仅 `.` |
| `:slash_tmp` | `/tmp` | 仅 `.` |
| `/absolute/path` | 绝对路径（Windows 支持 `D:\work` 与 UNC `\\server\share`） | 是 |
| `~/path` | 用户目录下的相对路径（Windows 也支持 `~\work` 反斜杠写法） | 是 |

#### scoped subpath：同一根下的逐子路径权限

```toml
[permissions.project-edit.filesystem.":workspace_roots"]
"." = "write"          # 每个 workspace 根
"docs" = "read"        # 每个根下的 docs 目录
"generated" = "deny"   # 每个根下的 generated 目录
```

**约束**（permissions.md）：子路径必须留在 workspace 根内，`../other-repo` 这类父级穿越被拒。

#### glob deny-read：按模式拒绝读取

```toml
[permissions.project-edit.filesystem]
glob_scan_max_depth = 3          # 至少为 1

[permissions.project-edit.filesystem.":workspace_roots"]
"**/*.env" = "deny"
```

**平台限制**（permissions.md 原文）：`deny` glob 跨 Linux/WSL/原生 Windows 均支持；`read` 或 `write` glob 在这三个平台上**可移植性差**，官方建议优先用精确路径或子树规则如 `"docs/**" = "read"`。无界 `**` 在 Linux/WSL/Windows 上需要 `glob_scan_max_depth` 做有界预展开，否则可在启动前显式列出 `*.env`、`*/*.env`、`*/*/*.env`。

#### writable roots 内的受保护路径（目录外写问题最直接的答案）

**[官方文档]**（agent-approvals-security.md，"Protected paths in writable roots" 一节，2026-10-05 抓取）：

> In the default `workspace-write` sandbox policy, writable roots still include protected paths:
> - `<writable_root>/.git` is protected as read-only whether it appears as a directory or file.
> - If `<writable_root>/.git` is a pointer file (`gitdir: ...`), the resolved Git directory path is also protected as read-only.
> - `<writable_root>/.agents` is protected as read-only when it exists as a directory.
> - `<writable_root>/.codex` is protected as read-only when it exists as a directory.
> - Protection is recursive, so everything under those paths is read-only.

config-advanced.md:380-385 补充了动机：

> In workspace-write mode, some environments keep `.git/` and `.codex/` read-only even when the rest of the workspace is writable. This is why commands like `git commit` may still require approval to run outside the sandbox.

**这是 Codex 处理"目录内但语义敏感"路径的核心手法：不是靠询问，而是靠硬性只读保护。**

#### 扩大可写范围的两条正交通道

1. `sandbox_workspace_write.writable_roots = [...]`（旧体系，追加可写根）——**声明式、跨会话、无需每次询问**。
2. `request_permissions` 工具 + `sandbox_permissions: "with_additional_permissions"`（新体系，**单次调用增量授权**）。

**[源码文档]** 第二条来自 <https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md>（2026-10-05 搜索摘要）：

> When you need extra sandboxed permissions for one command, use:
> - `sandbox_permissions: "with_additional_permissions"`
> - `additional_permissions` with one or more of:
>   - `network.enabled`: set to `true` to enable network access
>   - `file_system.read`: list of paths that need read access
>   - `file_system.write`: list of paths that need write access
>
> This keeps execution inside the current sandbox policy, while adding only the requested permissions for that command, unless an exec-policy allow rule applies and authorizes running the command outside the sandbox.
>
> If the command already matches an exec-policy allow rule, the command can be auto-approved without an extra prompt. In that case, exec-policy allow behavior (including any sandbox bypass) takes precedence.

**这是本次调研对 dsh-guard 最有价值的一条：Codex 有"单次调用的路径级增量授权"，其粒度是 `file_system.write: [paths]`，而不是"整次调用升到全权"。** 详见 §4 对照表。

### 2.3 网络策略

Codex 的网络是**两个独立开关**加一组规则 **[官方文档]**（agent-approvals-security.md 与 permissions.md，2026-10-05 抓取）：

| 开关 | 作用 |
|---|---|
| `sandbox_workspace_write.network_access` / `permissions.<n>.network.enabled` | 决定命令**能否**出网 |
| `features.network_proxy.enabled` | 决定出网流量**是否被代理拦截并按域名规则过滤** |

官方给出四种组合的精确行为表：

- 网络关 + 代理开：网络仍关，代理不做任何事。
- 网络开 + 代理关：网络开，**无限制直连**。
- 网络开 + 代理开：网络开，出站被网络策略约束。
- 只写域名规则**不会**自动开启代理。

域名规则是 allowlist 优先：

- 精确主机只匹配自身。
- `*.example.com` 匹配子域，**不**匹配 `example.com`。
- `**.example.com` 同时匹配 apex 与子域。
- 全局 `*` 匹配任何未被 deny 的公网主机，官方要求"treat `*` as broad network access"。
- `deny` 永远压过 `allow`；`*` 只允许作 allow 规则。

本地与私有目标：`allow_local_binding` 默认 `false`，阻断 loopback、link-local 与私有地址。**解析到本地／私有 IP 的主机名即使匹配 allowlist 仍被阻断**（这是明确的 DNS rebinding 缓解），且文档承认"reduces the risk but does not eliminate it"。

**[本机]** 本机 Windows 沙箱的代理状态：

```
路径：C:\Users\Fractal\.codex\.sandbox\setup_marker.json
原文：
{
  "version": 5,
  "offline_username": "CodexSandboxOffline",
  "online_username": "CodexSandboxOnline",
  "created_at": "2026-09-20T20:20:36.621273300+00:00",
  "proxy_ports": [ 7890 ],
  "allow_local_binding": false,
  "read_roots": [],
  "write_roots": []
}
```

### 2.4 secret 隔离手段

Codex 有三层 secret 隔离，各层证据等级不同。

**第 1 层（Windows 专用）——专用低权账户 + 防火墙 + DPAPI 凭据。**
**[官方文档]**（<https://learn.chatgpt.com/docs/windows/windows-sandbox.md>，2026-10-05 抓取）：

> `elevated` is the preferred native Windows sandbox. It uses dedicated lower-privilege sandbox users, filesystem permission boundaries, firewall rules, and local policy changes needed for commands that run in the sandbox.
>
> `unelevated` is the fallback... It runs commands with a restricted Windows token derived from your current user, applies ACL-based filesystem boundaries, and uses environment-level offline controls **instead of** the dedicated offline-user firewall rule.

**[本机]** 账户确实存在于 setup 标记中（见上），且存在两份凭据：

```
路径：C:\Users\Fractal\.codex\.sandbox-secrets\sandbox_users.json
大小：828 字节，最后修改 2026-09-21 04:20:34
结构：{ "version": 5, "offline": { "username": "CodexSandboxOffline", "password": "<base64>" },
        "online":  { "username": "CodexSandboxOnline",  "password": "<base64>" } }
```

**[推断]** 两段 `password` 的 base64 解码后均以 `AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA` 开头，这是 Windows DPAPI（`CryptProtectData`）provider 熵头的典型形态，故判断为 DPAPI 加密的账户密码。**该推断未通过解密或官方文档直接核实。**

官方文档同时要求 **`CODEX_HOME/.sandbox-secrets/` 的内容不得外发**（windows-sandbox.md，"I need to send diagnostics to OpenAI" 一节的 "Do not send:" 列表），反向印证了该目录的敏感等级。

**[本机]** 沙箱日志证实每条命令执行前都会重跑 ACL 授予流程，且**只授予读权限**：

```
路径：C:\Users\Fractal\.codex\.sandbox\sandbox.2026-10-04.log
原文片段：
[2026-10-04T01:32:35.216120200+00:00] read-acl-only mode: applying read ACLs
[2026-10-04T01:32:35.217993400+00:00] granting read ACE to C:\Users\Fractal\.agentsanywhere for sandbox users
[2026-10-04T01:32:35.221216400+00:00] granting read ACE to C:\Users\Fractal\.gitconfig for sandbox users
[2026-10-04T01:32:35.229484200+00:00] grant read ACE failed on C:\Users\Fractal\.pytest_cache for sandbox_group
[2026-10-04T01:32:35.669366500+00:00] setup refresh: processed 0 write roots (read roots delegated); errors=[]
```

注意 `read-acl-only mode` 与 `processed 0 write roots`——**可写根不走这条日志路径**，可写授权由 sandbox-setup 载荷（`payload_len=7348`）另行处理。

**第 2 层——规则化 deny-read。** permissions.md 的 `"**/*.env" = "deny"` 是声明式 secret 屏蔽（见 §2.2）。

**第 3 层——云端两阶段运行时的 secret 时间隔离。**
**[官方文档]**（agent-approvals-security.md，Codex Cloud (Legacy) 段）：

> Uses a two-phase runtime model: setup runs before the agent phase and can access the network to install specified dependencies, then the agent phase runs offline by default unless you enable internet access for that environment. **Secrets configured for cloud environments are available only during setup and are removed before the agent phase starts.**

本机为本地 Windows 部署，该层不适用。

### 2.5 沙盒与审批的配合关系

官方把两者定位为**正交双层**（agent-approvals-security.md）：

> **Sandbox mode**: What Codex can do technically (for example, where it can write and whether it can reach the network) when it executes model-generated commands.
> **Approval policy**: When Codex must ask you before it executes an action (for example, leaving the sandbox, using the network, or running commands outside a trusted set).

沙盒还作用于**派生进程**，不只是内置文件操作（sandboxing.md）：

> The sandbox applies to spawned commands, not just to built-in file operations. If the agent runs tools like `git`, package managers, or test runners, those commands inherit the same sandbox boundaries.

**Windows 两种实现的强制力差异**（permissions.md，"How enforcement works"）：

- `elevated` 最强，可用专用低权沙箱账户、文件系统权限边界与防火墙规则。
- `unelevated` 较弱，**无法强制每一种读写分离的 carveout**，遇到无法强制的策略则**拒绝执行**而不是静默放行。
- macOS 用 Seatbelt，策略无法被平台强制时同样拒绝执行。

---

## 3. DSH 侧事实（供对照，全部来自本机安装的核心代码）

以下每条都读自 `C:\Program Files\DSH NEXT\resources\app\node_modules\@deepseek-ai\` 下的实际文件。

| # | 事实 | 文件与行号 |
|---|---|---|
| D1 | 审批结果封闭枚举 `["allowed-once","rejected","cancelled","unavailable"]` | `dsh-user-approval\lib\index.js:30-35` |
| D2 | `request()` 文档注释：`'allowed-once' is the only grant` | `dsh-user-approval\lib\index.js:124` |
| D3 | 审批策略只有 `"ask" \| "never"`，经 `APPROVAL_POLICIES` 校验 | `dsh-user-approval\lib\index.js:37, 64, 74` |
| D4 | `never` 在 waterfall 分发**之前**返回 `rejected`，后注册的 `prepend` 监听器也绕不过 | `dsh-user-approval\lib\index.js:175` |
| D5 | 应答者是 `approval/request` waterfall 监听器；缺应答者或异常返回一律规范化为 `unavailable`（fail closed） | `dsh-user-approval\lib\index.js:176` |
| D6 | 请求必须发生在未结束的 turn 内，否则抛错；`approval/asked` + `approval/decided` 由服务成对写入 | `dsh-user-approval\lib\index.js:130-143` |
| D7 | 沙箱模式三档 `read-only / workspace-write / danger-full-access` | `dsh-sandbox-policy\lib\index.js:26-30` |
| D8 | `sandbox/mode` 事件**只携带 `mode` 一个字段**；`sandboxMode` 投影 schema 只接受三个字面量 | `dsh-sandbox-policy\lib\index.js:40-42, 85-89, 114-120` |
| D9 | `resolve()` 的 `workspaceRoot` 来自 `session.header.cwd` 或部署配置，**无追加根目录的入口** | `dsh-sandbox-policy\lib\index.js:141-148` |
| D10 | `writableRoots(policy)` 是**导出的官方函数**：`workspace-write` = workspaceRoot + `/tmp` + `os.tmpdir()`，全部经 `realpathSync` 规范化 | `dsh-sandbox\lib\index.js:166-173, 150-156` |
| D11 | 升级目标枚举 `ESCALATION_TARGETS = ["workspace-write","danger-full-access"]`，**只有两档且无路径粒度** | `dsh-sandbox\lib\index.js:42` |
| D12 | 升级必须严格更宽，否则抛错；`mode === effectiveMode` 时直接返回不询问 | `dsh-sandbox\lib\index.js:101` |
| D13 | `approveEscalation` 是**唯一**把沙箱升级接到审批服务的地方，`allowed-once` 直接返回请求的模式 | `dsh-sandbox\lib\index.js:99-123` |
| D14 | `Auto` 预设固定为 `sandbox: "danger-full-access"` + `approval: "ask"` | `dsh-permission-presets\lib\index.js:58-61` |
| D15 | 配置预设表固定两个条目：`workspace-write`+`ask`、`danger-full-access`+`never`；`custom` 与 `auto` 为保留名 | `dsh-permission-presets\lib\index.js:144-157, 175-176` |
| D16 | 预设切换只写 `permission/preset` 事件 + 各旋钮自己的 setter，不写任何授权记忆 | `dsh-permission-presets\lib\index.js:344-361` |
| D17 | 审批 UI 只有两个按钮：`拒绝` / `允许一次`；Enter=允许一次，Esc=拒绝 | `dsh-client-ui-approval\lib\client.js:124, 131, 262, 270` |
| D18 | 审批 UI 面板通过 `conversation.approval.detail` slot 由工具侧补充详情 | `dsh-client-ui-approval\lib\client.js:40, 350-353` |
| D19 | `dsh-fs-sandbox` 的围栏是**进程内策略检查，不是内核边界**；TOCTOU 被缩小但未消除 | `dsh-fs-sandbox\README.zh.md:64, 79, 123` |
| D20 | `dsh-fs-sandbox` 的可写集合与 Seatbelt profile 共享 `writableRoots`，避免两族能力漂移 | `dsh-fs-sandbox\README.zh.md:75, 124` |
| D21 | Windows ACL 沙箱后端：`workspace-write` 授予 workspace 与私有临时目录；写侧限制交叉检查，**读侧无隔离** | `dsh-sandbox-windows-acl\README.zh.md:12, 32` |
| D22 | `ctx.storageDomain.open(spec)` → `domain.table(name).put(id, value)` 持久 / `.get(id)` 同步 | `dsh-storage-domain\README.zh.md:49-54` |
| D23 | `kv` 是唯一数据形状；`domain/changed` 是**进程内**事件，跨进程不可见 | `dsh-storage\README.zh.md:130`；`dsh-storage-domain\README.zh.md:146` |
| D24 | `dsh-hooks-codex` 支持 5 个 hook 点，但**没有 pre-tool 审批或改写路径**，只认 deny | `dsh-hooks-codex\lib\index.js:92-99, 239-243` |
| D25 | `dsh-hooks-codex` 硬编码 `permission_mode: "default"` | `dsh-hooks-codex\lib\index.js:311` |
| D26 | `dsh-scope` 提供 scope 树与 `scopeTarget`，事件沿父链向上流动，**不向下** | `dsh-scope\lib\index.js:232-239, 327-338` |
| D27 | 官方 README 明写"**仅存在一次性授权**"：词汇含 `allowed-once` 但不含 `allow-always`、已记住的规则、撤销或授权存储 | `dsh-user-approval\README.zh.md:154` |
| D28 | `dsh-user-approval` 本身**没有内置应答者**，服务自身绝不提示人类 | `dsh-user-approval\README.zh.md:32, 156` |

**D1/D2/D27 三条共同坐实**：DSH 核心在设计上就没有预留"永久授权"位，dsh-guard 必须在**应答者层**自建记忆，而不是指望核心新增枚举。

---

## 4. 与 DSH 的对照表

| # | Codex 机制 | DSH 对应官方 API | 可抄？ | 理由 |
|---|---|---|---|---|
| C1 | 沙箱三档 `read-only/workspace-write/danger-full-access` | `SANDBOX_MODES`（`dsh-sandbox-policy`） | ✅ 已有 | 名义枚举完全一致（D7），无需新增 |
| C2 | `approval_policy` 二值 `on-request/never` | `APPROVAL_POLICIES = ["ask","never"]` | ✅ 已有 | D3；`ask`≈`on-request`，`never`≈`never` |
| C3 | 审批结果五档 `approved / approved_with_amendment / approved_for_session / denied / abort` | `OUTCOMES` 四值 | ⚠️ 部分 | 核心枚举封闭（D1），插件**不能**返回 `approved_for_session`。折中：命中记忆时仍返回 `allowed-once`，语义由插件侧记忆层承担 |
| C4 | 跨会话持久授权（`.rules` 文件） | `ctx.storageDomain`（`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`） | ✅ 可抄 | D22/D23 提供官方持久化；Codex 用文件，DSH 用 KV domain，机制等价 |
| C5 | 用户显式选择"永久"而非默认 | 插件自建 UI（在审批面板上加第三个按钮） | ✅ 可抄 | `dsh-client-ui-approval` 的 actionRow 是官方 slot 渲染，但按钮由插件自己的 `approval/request` 监听器控制，核心不限制选项数（D5 只校验返回值 ∈ OUTCOMES） |
| C6 | `.rules` 规则语言（Starlark `prefix_rule`） | 无 | ❌ 不可抄 | DSH 无命令解析器、无 tree-sitter 切段、无 execpolicy 引擎。**不建议自建**：成本高且与 DSH 的"路径级"痛点不匹配 |
| C7 | 命令切段（管道/`&&`/`;`/子 shell）后逐段评估 | 无 | ❌ 不可抄 | 同 C6。dsh-guard 的痛点是**文件路径**不是命令前缀，切段帮不上 |
| C8 | `writable_roots` 声明式追加可写根 | 无官方入口 | ❌ 不可抄 | `sandbox/mode` 事件只带 `mode` 字段（D8），`resolve()` 的 `workspaceRoot` 只来自 session cwd 或部署配置（D9）。插件无法扩展 DSH 的可写根 |
| C9 | 单次调用路径级增量授权 `sandbox_permissions:"with_additional_permissions"` + `file_system.write:[paths]` | `ESCALATION_TARGETS` 只有两档 mode（D11） | ❌ 不可抄 | 工具 schema 的 enum 是 registry 全局的，插件加不了第三档。**这是 DSH 与 Codex 最大的能力差** |
| C10 | 声明式路径规则 `path = read/write/deny`，`deny`> `write`> `read` | `writableRoots(policy)`（D10） | ⚠️ 部分 | `writableRoots` 是导出的官方函数，dsh-guard **可以**调用它取得权威可写根集合（这也是防漂移的关键）。但它是**只读派生**，没有 deny 列表概念 |
| C11 | workspace roots 内 `.git`/`.codex`/`.agents` 强制只读 | 无 | ⚠️ 插件层可补 | DSH 的 `writableRoots` 不含受保护子路径。可在 dsh-guard 侧加 deny 前缀表，在应答者阶段强制重新询问（但无法阻止"记忆命中后放行"，需在匹配逻辑里排除） |
| C12 | 网络策略：`network.enabled` 开关 + 代理域名规则 | 无（`dsh-http-proxy` 是另一回事） | ❌ 不可抄 | DSH 核心不管理工具出网。本机 DSH 侧证据：`dsh-sandbox-policy\lib\index.js:72-83` 的 `renderPolicyContext` 三档文案**完全不提网络** |
| C13 | Windows 专用低权沙箱账户 + 防火墙 + DPAPI 凭据 | `dsh-sandbox-windows-acl`（受限令牌 + ACL，D21） | ❌ 不可抄 | DSH Windows 后端是**受限令牌 + ACL**，没有专用账户、没有防火墙规则、没有 DPAPI 凭据存储。且 D21 明确"写侧限制交叉检查，请与读侧策略配对以获得更强隔离" |
| C14 | secret 隔离：`.env` glob deny-read | 无 deny-read 表达 | ⚠️ 插件层可补 | DSH 的 `dsh-fs-sandbox` 围栏**只管写**（D19：`writeText`/`editText` 上的模式围栏），读不受限。deny-read 只能在插件层做**提示性**过滤，无法强制 |
| C15 | 审批 UI 多档 scope（once / session） | `dsh-client-ui-approval` 双按钮（D17） | ✅ 可抄 | 插件的应答者可以渲染自己的确认组件；核心 UI 只是默认应答者之一 |
| C16 | `approvals_reviewer = user \| auto_review` | `dsh-guard` auto-review-router 已实现等价能力 | ✅ 已有 | 见 `D:\dsh-guard\docs\design-auto-review-router.md`。Codex 侧对应设计见 <https://learn.chatgpt.com/docs/sandboxing/auto-review.md>；官方明确它是"reviewer swap, not a permission grant" |
| C17 | `granular` 审批策略（5 类提示各自开关） | `approval` 只有二值（D3） | ⚠️ 插件层可补 | 核心枚举封闭，但 dsh-guard 的 router 已在审批层做分类，可在插件层实现"某些类别自动拒绝、某些类别弹窗" |
| C18 | 规则加载在启动时、需重启 | 会话投影实时折叠（D8/D16） | ❌ 不可抄（且不需要） | DSH 的 `sandbox/mode` 与 `approval/policy` 都是**会话日志事件**，实时生效。dsh-guard 的记忆命中应在**同一次 waterfall 调用内**返回，不需要重启 |
| C19 | `[projects.<path>].trust_level` 目录信任 | 无 | ❌ 不可抄 | DSH 信任模型基于工作区目录与沙箱模式，无 per-project 信任级别 |
| C20 | execpolicy allow 规则优先于沙箱升级（含 sandbox bypass） | 无 | ❌ 不可抄 | 依赖 C6 的规则引擎 |
| C21 | OTel `approval.requested` 指标（5 值标签） | `approval/asked` + `approval/decided` 会话事件对（D6） | ✅ 已有 | DSH 走会话日志而非 OTel，但**审计对完整性等价**，且 dsh-guard 已在做审批历史 Tab |
| C22 | 沙箱作用于派生进程（git/npm/test runner） | `ctx.shell` 的 confined runner + `dsh-fs-sandbox` 围栏 | ✅ 已有 | D19/D20；DSH 用"shell 走内核隔离、fs 走进程内围栏"的双族分工，与 Codex 的"所有命令都进沙箱"效果一致 |
| C23 | 会话 scope 隔离（规则按会话/项目分层） | `dsh-scope` scope 树（D26） | ✅ 可抄 | `scopeTarget` / `scopeOf` 可把授权记忆绑定到 sessionId，实现"会话级记忆" |

**汇总统计**：可抄 11 项（C1/C2/C4/C5/C15/C16/C18\* /C21/C22/C23），部分可抄 4 项（C3/C10/C11/C14/C17），不可抄 9 项（C6/C7/C8/C9/C12/C13/C19/C20）。

**核心结论**：**Codex 的"路径级授权"在 DSH 上无法直接复刻。** Codex 有一条 `file_system.write: [paths]` 的单次增量授权通道（C9），DSH 的升级只有 `workspace-write` / `danger-full-access` 两档 mode（D11）。因此 dsh-guard 能做的是**抑制重复询问**，而**不是收窄权限**。这个区别必须在设计与文案中说清楚，否则会给人"记忆让权限变窄了"的错觉。

---

## 5. 可抄作业的具体方案：目录级授权记忆 + 一次/永久二选一

### 5.1 方案定位

**做什么**：把"同一条项目目录外的中风险写操作每次都要重新确认"改为"首次二选一，之后在授权目录内不再打扰"。

**不做什么**：不收窄 DSH 的升级粒度。授权记忆是**询问抑制器**，不是权限收窄器。已放行的调用仍然是 `danger-full-access` 档的完整升级。

### 5.2 记忆键设计（吸取 issue #4212 的教训）

**必须锚定规范化后的实际目标路径，不能用 UI 展示字符串或模型提议字符串。**

```
key = canonicalTarget + "|" + opClass + "|" + toolName
```

- `canonicalTarget`：`realpathSync.native()` 解析后的**绝对路径**。DSH 侧有现成的官方函数可复用：`canonicalPath` 由 `@deepseek-ai/dsh-sandbox` 导出（`dsh-sandbox\lib\index.js:150-156`，源码注释即说明"canonical (symlinks resolved), because both Seatbelt filters and the fs fence's containment check match resolved paths"）。**直接用它，不要自己写 realpath。**
- `opClass`：`create` | `edit` | `rename` | `delete` | `delete-recursive`。取不到 opClass 时（工具未上报）**fail closed，不记忆**。
- `toolName`：`fs` / `pwsh` / `bash` 等。

**注意 D19 的 TOCTOU 警告**：`dsh-fs-sandbox` 自己都在"写入前立即重新规范化"来缩小 TOCTOU 窗口。dsh-guard 的记忆匹配必须**同样在每次匹配时重新规范化**，不能缓存上次比较用的字符串。

### 5.3 存储设计

用 `ctx.storageDomain`（D22）：

```ts
const domain = await ctx.storageDomain.open({
  name: 'dsh-guard-grants',
  schema: { /* 记录 schema */ },
})
await domain.table('grants').put(grantId, grantRecord)   // 持久
const record = domain.table('grants').get(grantId)       // 同步读
```

**记录形状（建议）**：

```
{
  id:            "<canonicalTarget-prefix>|<opClass>|<toolName>",
  root:          "<用户点选的目录绝对真实路径>",
  opClasses:     ["edit"],        // 用户勾选的操作类别白名单
  toolNames:     ["fs"],
  createdAt:     <epoch ms>,
  lastUsedAt:    <epoch ms>,
  useCount:      <int>,
  createdBy:     "user",         // 只有用户显式选择才写入此值
  origin:        "approval-panel"
}
```

**作用域默认取「用户级全局」**（对齐 Codex 的 `~/.codex/rules/default.rules`）。若要支持项目级，用 `dsh-scope` 的 scope 树（D26）按 `session.header.cwd` 派生二级命名空间，但**建议 v1 不做**——Codex 的项目级规则还需要项目层受信任才加载，复杂度收益比低。

**撤销**（对齐 Codex 的"编辑 .rules 文件"）：提供一条 `/permission`-风格的命令列出并删除记录。因为 DSH 的领域数据**对模型不可见**（`dsh-storage\README.zh.md:111-113`），撤销必须走显式命令或 UI，不能指望模型自省。

### 5.4 授权范围选择文案（抄 Codex 的两条规范）

Codex 官方提示词给出的规范可以直接翻译成 dsh-guard 的 UI 文案与前缀建议逻辑 **[源码文档]**（on_request.md，2026-10-05）：

1. **"选最窄的 scope"**（sandboxing.md 原文）→ 面板默认焦点放在"允许一次"，"允许此目录"作为次要选项。
2. **"目录而非整条命令"**（on_request.md：*"request one that will allow you to fulfill similar requests from the user in the future without re-requesting escalation. It should be categorical and reasonably scoped... You should rarely pass the entire command into `prefix_rule`"*）→ 授权记忆的键应是**目录 + 操作类别**，绝不是整条命令字符串。

### 5.5 挂在哪：审批 waterfall 应答者

**接入点**是 `approval/request` waterfall 监听器（D5），**不是**工具层、不是 `tools/pre-execute`、不是 `dsh-hooks-codex`（D24 明确 hooks 没有 pre-tool 审批路径）。

```
模型调用 fs 写 workspace 外路径
  → dsh-fs-sandbox 围栏抛 FS_SANDBOX_DENIED          [D19]
  → 工具层渲染 [sandbox: file access denied under <mode> mode] + 升级提示
  → 模型带 sandbox_permissions + justification 重试
  → approveEscalation()                                [dsh-sandbox/lib/index.js:99]
  → ctx.approval.request({ agent, toolName, callId, reason, displayReason, signal })
  → ApprovalService.request()                          [dsh-user-approval/lib/index.js:128]
      · hasOpenTurn 检查（D6）—— 插件不改这段
      · 追加 approval/asked
      → decide() → waterfall(scopeTarget(agent, agent), "approval/request", req)
          ├─ dsh-guard 监听器（最高优先级）
          │    ① 记忆命中且未触发 §5.6 任一红线 → return "allowed-once"  ← 不弹窗
          │    ② 未命中 → 渲染二选一面板，等待用户
          │         · 允许一次       → return "allowed-once"（不写记忆）
          │         · 允许此目录     → await domain.put(...) ; return "allowed-once"
          │    ③ 任何内部异常 → 一律 return "unavailable"（fail closed，抄 D5 的规范）
          └─ 其他监听器 / 无监听器 → "unavailable"
      · 追加 approval/decided
```

**实现约束（逐条对应 DSH 官方语义）**：

- 监听器返回值**必须** ∈ `OUTCOMES`，否则被规范化为 `unavailable`（D5）。**不能**返回自定义的 `"allowed-always"`。
- 记忆命中时返回 `allowed-once` 而非新枚举——`approveEscalation` 的 switch（D13）只认这四个值，返回别的会落到 `assertNever` 抛错。
- 面板渲染建议走 `conversation.approval.detail` slot（D18）补充具体目标路径，而不是改核心 UI 组件。这条对 dsh-guard 已有意义：`docs/checkpoint-main-20261005.md` 记录的"缺陷 2"（`lib/index.js:461-464` 的 `displayReason` 不含命令内容）正好可以在这里补。
- 监听器抛异常 → 规范化为 `unavailable` → fail closed。所以**记忆读取的 I/O 必须在 try/catch 内，且异常路径必须 fail closed**，绝不能"读不到就放行"。
- 记忆写入必须 `await` 完成后再返回，因为 `put` 写完才算持久（D22）。

### 5.6 安全边界：以下情况必须重新问

每一条都对应一个可核实的依据，不是经验之谈。

| # | 触发条件 | 依据 | 处理 |
|---|---|---|---|
| R1 | 目标路径规范化后不在任何已授权 `root` 之下 | Codex 的 allowlist 语义（permissions.md） | 重新问 |
| R2 | 目标落在 `root/.git`、`root/.codex`、`root/.agents`、`root/.ssh` 或匹配 `**/*.env` 之下 | agent-approvals-security.md 的受保护路径 + permissions.md 的 deny glob | **重新问，不受记忆抑制**（Codex 是硬性只读，DSH 只能靠重新问近似） |
| R3 | `opClass` 为 `delete` 或 `delete-recursive` | on_request.md：**"NEVER provide a prefix_rule for destructive commands like rm"** | **永不记忆**，每次必问 |
| R4 | 会话审批策略为 `never` | D4：核心在 waterfall 前就返回 `rejected` | 不询问也不记忆（记忆无意义） |
| R5 | 会话沙箱模式已是 `danger-full-access` | D12：`mode === effectiveMode` 时直接返回，根本不询问 | 不询问也不记忆 |
| R6 | 用户未显式点"允许此目录" | Codex 的 allow 落盘由用户显式触发（rules.md） | 不写记忆 |
| R7 | `canonicalTarget` 无法解析，或解析后落在 `root` 之外（符号链接/junction 逃逸） | D19 的 TOCTOU 说明 + D10 的 `canonicalPath` 语义 | **fail closed，重新问**；解析失败时不得按原字符串比较 |
| R8 | 目标位于用户目录根、`C:\`、用户 profile 根、系统目录 | 参照 Codex 对过宽前缀的禁令（on_request.md banned prefix_rules） | **永不记忆** |
| R9 | 记忆记录本身的 `root` 字段与当前解析出的目标不在同一卷/同一逻辑边界 | Windows ACL 沙箱的已知缺口（D21：硬链接是文件对象别名） | 重新问 |
| R10 | 同一 `id` 的 `useCount` 超过阈值（建议 100）或 `lastUsedAt` 超过 N 天（建议 30 天） | Codex 无此机制，**属新增建议，无外部依据** | 重新问一次并提示"该授权已使用 N 次，是否保留" |

**R10 明确标注为新增建议**，Codex 没有对应设计，其唯一价值是防止"一次授权长期静默生效"这类用户可感知不到的风险累积。

### 5.7 与 DSH 官方机制的复用点汇总

| 官方 API | 出处 | 在本方案中的用途 |
|---|---|---|
| `canonicalPath` from `@deepseek-ai/dsh-sandbox` | `dsh-sandbox\lib\index.js:150-156` | 记忆键的路径规范化，**必须复用而非重写** |
| `writableRoots` from `@deepseek-ai/dsh-sandbox` | `dsh-sandbox\lib\index.js:166-173` | R2 的判定基准：目标必须在权威可写根集合内 |
| `ctx.approval.request(...)` | `dsh-user-approval\lib\index.js:128` | 唯一合法接入点 |
| `approval/request` waterfall | `dsh-user-approval\lib\index.js:176` | 记忆短路与面板渲染的挂载点 |
| `OUTCOMES` | `dsh-user-approval\lib\index.js:30-35` | 返回值白名单 |
| `ctx.storageDomain.open()` | `dsh-storage-domain\README.zh.md:52` | 记忆持久化 |
| `ctx.sandboxPolicy.resolve({ session })` | `dsh-sandbox-policy\lib\index.js:141` | 读取当前模式用于 R4/R5 判定 |
| `ctx.sessions.scopeOf(owner)` | `dsh-client-ui-approval\lib\client.js:285` | 会话作用域绑定（D26） |
| `conversation.approval.detail` slot | `dsh-client-ui-approval\lib\client.js:350-353` | 在官方面板内补充目标路径详情 |

---

## 6. 未覆盖与不确定项

### 6.1 未查到

1. **Codex Rust 源码中审批决策链的逐行实现**。`codex.exe` 为 321 MB 编译产物，无法逐行审计。本文所有关于内部流程的描述均来自官方文档与提示词模板，**没有一条来自源码行级验证**。
2. **`approved_for_session` 的会话内存储结构**。官方只在 OTel 指标枚举与 issue #4212 的描述中间接体现其存在，**未找到**说明它存在哪个结构体、如何与 execpolicy 规则交互的文档或源码。issue #4212 显示它在 Windows 上因命令向量被 PowerShell 包装替换而**实际失效**。
3. **`.rules` 是否支持热加载**。官方文档第 3 步写 "Restart Codex"，社区描述也称启动时加载，但**未从源码确认**是否存在运行中重载路径。
4. **Codex TUI 审批弹窗的完整按钮列表与键盘布局**。sandboxing.md 只提到 "approving once or for the session"，`on_request.md` 提到 `prefix_rule` 可选持久化；**未找到**权威文档枚举全部可选项及其默认焦点。
5. **DSH 侧 `dsh-http-proxy` 是否可复用为 Codex 式网络策略载体**。本次只确认了 `dsh-sandbox-policy` 的策略文案完全不含网络（D12/C12），**未阅读** `dsh-http-proxy` 的实现，故不能判定其可抄性。
6. **DSH 是否已有官方 per-project 信任机制**。只确认了沙箱模式三档与 session cwd 绑定（D8/D9），**未检索** `dsh-authorization` 包的实现。

### 6.2 存疑

1. **DPAPI 推断**（§2.4）：`sandbox_users.json` 中两段 base64 以 `AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA` 开头，判断为 Windows DPAPI 熵头。**未解密验证**，官方文档亦未说明该文件格式。
2. **Codex 版本对应关系**：本机 `C:\Users\Fractal\AppData\Local\OpenAI\Codex\bin\` 下有两个版本目录（`8aaf1547b825b104`、`f1e5e36960c35938`），`config.toml` 的 `CODEX_CLI_PATH` 指向前者。**未能确定**其对应的 Codex 语义化版本号，因此本文引用的官方文档（描述 `0.138.0+` 的 permission profiles）**与本机实际运行版本是否完全对应，无法判定**。本机 `config.toml` 使用的是**旧体系** `[windows] sandbox = "elevated"`，与文档所述并存的新旧两套一致。
3. **`dsh-fs-sandbox` 的可写根与 `dsh-sandbox-windows-acl` 的可写根是否完全一致**：`dsh-sandbox\README.zh.md` 注释（D20）说 Seatbelt profile 与 fs fence 共享 `writableRoots`，但 Windows ACL 后端的 README（D21）说 `workspace-write` 授予"工作区**和私有临时目录**"，措辞与 `writableRoots` 的"workspaceRoot + /tmp + os.tmpdir()"不完全对齐。**本次未读 `dsh-sandbox-windows-acl` 源码**，无法判定是否真的存在差异。若存在，dsh-guard 用 `writableRoots()` 做 R2 判定基线时需注意。

### 6.3 本次调研未触碰的范围

- 未运行 Codex 任何子命令（包括 `codex execpolicy check`），故 §1.1 的切段与匹配行为**未做本机实测**。
- 未修改 `C:\Users\Fractal\.codex\` 下任何文件，未新增/删除/编辑 `default.rules`。
- 未修改 `D:\dsh-guard\` 下除本文档之外的任何文件。
- 未修改 DSH 安装目录 `C:\Program Files\DSH NEXT\` 下任何文件。
- 外部文档抓取产生的临时副本位于 `C:\Users\Fractal\AppData\Local\Temp\codex-docs\`（`config-reference.md` 131,163 字节、`config-advanced.md` 54,620 字节、`auto-review.md` 13,215 字节），**未清理**，可复查。

---

## 7. 证据索引

### 7.1 本机取证

| 文件 | 取用内容 |
|---|---|
| `C:\Users\Fractal\.codex\config.toml` | `[projects.*] trust_level = "trusted"`（3 项）、`[windows] sandbox = "elevated"`；无 `approval_policy` / `sandbox_mode` 顶层键 |
| `C:\Users\Fractal\.codex\rules\default.rules` | 177 字节，唯一一条 `prefix_rule(pattern=[...], decision="allow")`，键为 pwsh.exe 绝对路径 + 完整参数 |
| `C:\Users\Fractal\.codex\.sandbox\setup_marker.json` | `version:5`、`offline_username: CodexSandboxOffline`、`online_username: CodexSandboxOnline`、`proxy_ports:[7890]`、`allow_local_binding:false`、`read_roots:[]`、`write_roots:[]` |
| `C:\Users\Fractal\.codex\.sandbox-secrets\sandbox_users.json` | 828 字节，两组 `username` + DPAPI 形态 base64 `password` |
| `C:\Users\Fractal\.codex\.sandbox\sandbox.2026-10-04.log` | `read-acl-only mode`、`granting read ACE to ... for sandbox users`、`processed 0 write roots`、`setup refresh: spawning codex-windows-sandbox-setup.exe (payload_len=7348)`、`START: pwsh.exe -NoProfile -Command ...` 实际命令行 |
| `C:\Users\Fractal\.codex\.sandbox\` | 55 个日志文件（2026-07-15 至 2026-10-04），证实逐条命令前重跑 ACL 授予 |
| `C:\Users\Fractal\.sandbox-bin\codex.exe` | 321,953,584 字节，Rust 编译产物，不可逐行审计 |
| `C:\Users\Fractal\AppData\Local\OpenAI\Codex\bin\` | 两个版本目录 `8aaf1547b825b104`、`f1e5e36960c35938` |

### 7.2 外部资料（全部于 2026-10-05 抓取）

| URL | 取用内容 |
|---|---|
| <https://learn.chatgpt.com/docs/agent-configuration/rules.md> | `.rules` 文件创建、`prefix_rule` 字段语义、三档 decision 与最严格者胜、Starlark 语法、`bash -lc` 切段规则、TUI allow list 写入 `~/.codex/rules/default.rules`、项目级规则需项目层受信任、重启要求、`codex execpolicy check` |
| <https://raw.githubusercontent.com/openai/codex/main/codex-rs/execpolicy/README.md> | execpolicy 引擎规格、`decision` 默认值、最严格严重度合并、host_executable basename 回退、CLI 用法与响应 JSON 形状 |
| <https://learn.chatgpt.com/docs/agent-approvals-security.md> | 沙盒/审批双层定位、`untrusted` 迁移、受保护路径（`.git`/`.agents`/`.codex`）、网络开关两分表、域名规则语法、本地/私有绑定与 DNS rebinding 缓解、`approvals_reviewer`、五组常用组合、OS 级沙箱实现、OTel 事件类别、Codex Cloud 两阶段 secret 隔离 |
| <https://learn.chatgpt.com/docs/permissions.md> | permission profiles 全量 spec、两体系互斥、路径取值域表、scoped subpath、`deny`>`write`>`read` 优先级、glob deny-read 与 `glob_scan_max_depth`、网络开关组合、Unix socket、平台强制力差异 |
| <https://learn.chatgpt.com/docs/sandboxing.md> | 沙盒作用于派生命令、**"approving once or for the session" 多档 scope 与"选最窄"建议**、权限选择器 UI 形态、三档 sandbox 与两档 approval 概述 |
| <https://learn.chatgpt.com/docs/sandboxing/auto-review.md> | auto-review 触发条件、**"reviewer swap, not a permission grant"**、不扩展 `writable_roots`、不启用网络、不弱化受保护路径 |
| <https://learn.chatgpt.com/docs/config-file/config-reference.md> | `approval_policy` 与五个 granular 子键、`approvals_reviewer`、`sandbox_mode`、`sandbox_workspace_write.writable_roots` / `.network_access`、`projects.<path>.trust_level`（本地副本第 155-234、1771 行附近） |
| <https://learn.chatgpt.com/docs/config-file/config-advanced.md> | **`approval.requested` 指标五值枚举 `approved` / `approved_with_amendment` / `approved_for_session` / `denied` / `abort`**（第 569 行）、`[sandbox_workspace_write]` 四子键示例、`.git`/`.codex` 只读动机（第 380-385 行） |
| <https://learn.chatgpt.com/docs/windows/windows-sandbox.md> | `elevated` / `unelevated` 两模式机制差异、`allowed_sandbox_implementations`、私有桌面、`/sandbox-add-read-dir`、**"Do not send: CODEX_HOME/.sandbox-secrets/"** |
| <https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request.md> | `prefix_rule` 提议与持久化选项、命令切段、**banned prefix_rules（禁止 `rm`、禁止过宽前缀、heredoc 场景）**、前缀应"categorical and reasonably scoped" |
| <https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md> | **`sandbox_permissions:"with_additional_permissions"` + `additional_permissions.{network.enabled, file_system.read, file_system.write}` 单次路径级增量授权**、execpolicy allow 规则优先 |
| <https://api.github.com/repos/openai/codex/issues/4212> | Windows 上 `approved_for_session` 失效的根因（存储的命令向量与实际执行的 PowerShell 包装命令不一致），state `open`，2026-08-18 更新 |
| <https://raw.githubusercontent.com/openai/codex/main/docs/execpolicy.md> | 仅一行指向 exec-policy 文档，无独立内容 |

### 7.3 DSH 侧取证文件

| 文件 | 关键行号 |
|---|---|
| `dsh-user-approval\lib\index.js` | 30-35（OUTCOMES）、37（APPROVAL_POLICIES）、124（"the only grant"）、128-144（request）、152-165（effectivePolicy/overrideOf）、172-189（decide） |
| `dsh-user-approval\README.zh.md` | 12、28、32、77、154（"仅存在一次性授权"）、156（无内置应答者） |
| `dsh-sandbox-policy\lib\index.js` | 26-30（SANDBOX_MODES）、40-42（setSandboxMode）、72-83（renderPolicyContext，无网络）、85-89、114-120（投影）、141-148（resolve） |
| `dsh-sandbox\lib\index.js` | 42（ESCALATION_TARGETS）、99-123（approveEscalation）、150-156（canonicalPath）、166-173（writableRoots） |
| `dsh-fs-sandbox\README.zh.md` | 12、46、64、75、79、123、124 |
| `dsh-sandbox-windows-acl\README.zh.md` | 12、28、32 |
| `dsh-permission-presets\lib\index.js` | 50-61（CUSTOM/AUTO 预设）、62-71（state schema）、85-105（applyPermissionEvent）、138-159（Config 默认预设）、175-176（保留名）、291-306（derive）、344-361（apply） |
| `dsh-permission-presets\README.zh.md` | 12、32、49-52、56、60、64、133-137 |
| `dsh-client-ui-approval\lib\client.js` | 40、111、124、131、262、270、285、311、350-353 |
| `dsh-scope\lib\index.js` | 232-239、276-280、327-338 |
| `dsh-storage\README.zh.md` | 12、32、72-75、111-113、130 |
| `dsh-storage-domain\README.zh.md` | 12、49-54、62、73、89、94、146 |
| `dsh-hooks-codex\lib\index.js` | 13-19（五个 hook 点）、92-99（无 pre-tool 审批）、239-243、311 |
