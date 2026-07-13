# COFORGE 内置 Reasonix Runtime

## 当前实现状态（2026-07-13）

Reasonix beta 已形成可运行闭环：

- 固定上游 `esengine/DeepSeek-Reasonix` CLI `v1.17.11`，commit
  `20a64b4d15687fbddb7ccc658daf909f71d01427`（GitHub 标记为 verified）。
- `src/lib/reasonix/release-manifest.json` 固定 macOS/Linux/Windows 的 x64/arm64
  发布压缩包 SHA-256，并额外固定解压后 `reasonix`/`reasonix.exe` 的 SHA-256。
- `src/lib/reasonix/manifest.ts` 在启动前校验实际可执行文件，拒绝名称不符、非普通文件、
  Unix 无执行位、越出平台目录的符号链接和 SHA 不匹配。
- `src/lib/reasonix/home.ts` 创建权限为 `0700` 的独立 Reasonix home/state/cache/workspace，
  配置文件为 `0600`；ACP 的 `cwd` 固定为空的 COFORGE 工作区，不接受用户项目路径。
- `src/lib/reasonix/acp-client.ts` 实现 ACP v1 NDJSON stdio 的 `initialize`、`session/new`、
  `session/load`、`session/prompt`、`session/cancel`、`session/close`、流式
  `session/update`、权限请求、超时、AbortSignal 取消、崩溃检测和 session reload。
- `session/new` 只注入名为 `coforge` 的第一方 stdio MCP。host 仅接受
  `mcp__coforge__*` 工具事件；其他工具会立即取消 turn，并把结果标记为策略违规。
- `mcp-stdio.ts` 暴露 schema、guarded query 与 bidding、sourcing、freight、laytime、inventory、
  blending、coswap 七个业务引擎；每个工具都有封闭 JSON Schema、输入/输出字节上限、显式角色，
  不暴露数据库路径、文件系统或任意 SQL 执行器。
- `orchestrator.ts` 串行化 turn、聚合流式回复、保留真实 MCP call hash/query audit evidence，
  并在进程崩溃后 reload session。macOS 桌面 chat 默认启用该 beta；只有显式设置
  `COFORGE_REASONIX_ENABLED=0` 才回退到原有 agent 路径。
- `desktop/build_macos.sh` 把当前 host 架构的 pinned Reasonix、MCP bundle、COFORGE Apache
  `LICENSE`/`NOTICE`、Node.js 许可证与上游 Reasonix MIT license 放入应用 Resources；构建会拒绝
  缺失、空文件或符号链接许可资源。构建先校验上游 Reasonix SHA，再签名嵌套 Mach-O，随后生成
  受外层 app seal 保护的 packaged manifest；运行时按其中签名后 SHA 校验实际 binary，不在启动时下载。
  默认 ad-hoc 签名仅供本机测试；Developer ID 签名、公证、stapling 与团队 designated requirement
  是正式分发门槛，不能把 ad-hoc 包描述为可发布签名包。ad-hoc Node 为加载本机开发 native addons
  带 `disable-library-validation` 例外；Developer ID Node 必须删除该 entitlement、保持 library validation
  开启，并把 Node、Reasonix、helper 与 native addons 签到同一 Developer ID 团队，否则构建失败。

仍未完成的是 ACP v1 token usage 回传、Windows/Linux 桌面打包、
生产数据适配器、最终桌面/容器制品级 SBOM attestation 与真实 DeepSeek live smoke。仓库已能生成并
验证 npm 生产依赖的 CycloneDX 1.6 JSON，CI 也发布对应 artifact；它还不是最终安装包或镜像 digest
的完整制品 SBOM。ACP v1 当前没有可靠 usage 字段，因此 beta
只在调用前检查预算是否尚有容量，并在结果显式返回 `usageUnavailable: true`。macOS 桌面版已经默认
走 Reasonix beta，但不能把这一 beta 称为已完成生产级 token 结算，也不能声称每个 turn 已精确入账。

## 产品决策

COFORGE 把 Reasonix 当作内置 Agent Runtime，而不是面向用户暴露的第二个产品。用户只安装、启动和配置 COFORGE；Reasonix 二进制、配置、会话与升级都由 COFORGE 管理。

默认模型组合：

- Provider：DeepSeek 官方 API `https://api.deepseek.com`
- Model：`deepseek-v4-pro`
- Reasoning effort：`max`
- Credential：用户自己的 `DEEPSEEK_API_KEY`

`max` 是推理强度，不是模型名。运行时应探测官方模型目录；只有经过 COFORGE 发布清单验证后，才把未来旗舰型号切成新默认，不能把“最新”解释为启动时自动选择任意未知模型。
Reasonix gate 不按字符串包含关系猜 provider：只接受 OpenAI-compatible backend、HTTPS
`api.deepseek.com`、默认 443、无 userinfo/query/fragment、根路径或 `/v1`，以及精确模型 ID
`deepseek-v4-pro`。任何代理路径、相似域名、非标准端口或其它模型都走 legacy agent。

## 推荐架构

```text
COFORGE UI
  -> COFORGE Orchestrator（会话、预算、审批、证据）
     -> bundled reasonix acp（ACP v1 / NDJSON / stdio）
        -> DeepSeek official API（Pro + max）
        -> coforge MCP server（唯一业务工具入口）
           -> SQL guard -> isolated query worker -> synthetic/private adapter
           -> bidding / sourcing / freight / laytime / blending / swap / inventory
```

Reasonix `acp` 已提供 `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、流式 `session/update` 和 `session/request_permission`。COFORGE 应作为 ACP host 管理一个长驻子进程，而不是为每次提问调用 `reasonix run`；这样可以复用会话、前缀缓存、取消和工具审批。

COFORGE runtime 启动一个第一方 MCP stdio server，并在 `session/new.mcpServers` 中只注入该 server。MCP 只暴露显式 JSON Schema 工具，不把 SQLite 文件、内部路径或不受限 SQL 执行权交给 Reasonix。query 工具仍经过现有表/列白名单、隔离子进程、结果上限与审计链。

## 安全边界

- Reasonix 使用独立 `REASONIX_HOME=<COFORGE config>/reasonix`、独立 state/cache 和空 workspace，不读取用户已有的 `~/.reasonix`；ACP `cwd` 不能指向用户项目，否则上游会读取项目 `reasonix.toml`、`.mcp.json`、skills 和 hooks。
- 隔离配置把 `[tools].enabled` 设为固定的无效 sentinel（上游空数组反而代表全部 built-in），并以 `[permissions] mode="deny"` 和显式 deny 列表阻止额外注册的 shell、文件、web、记忆、skills、session-history 与插件管理工具；host 再对流式 `tool_call` 执行 `mcp__coforge__*` allowlist，违规即取消。ACP 使用 `balanced` profile，使 host 注入的 MCP eager 可见；`economy` 会把 MCP 藏在 `connect_tool_source` 后，不适合此边界。上游 `v1.17.11` 尚无真正的 “MCP-only registry” 开关，因此这层 host allowlist 不能删除。
- 当前 beta 没有权限审批 UI，也不会把 `session/request_permission` 转交给用户；host 对所有请求
  fail closed 返回 `reject_once`。在实现带上下文和明确操作说明的审批界面前，不能启用 `allow_once`，
  也不能依赖 Reasonix 对 `Ask` 的非交互回退。
- DeepSeek key 的长期来源在当前 macOS 桌面包中是 Keychain，不写入 COFORGE settings JSON、项目目录或日志。上游 `v1.17.11` 的正常 provider runtime 只从 `REASONIX_HOME/.env` 解析 key（进程环境只被 setup probe 使用），所以 `session/new`/`session/load` 前会把 Keychain 取出的 key 用 `O_CREAT|O_EXCL`、`0600` 写成短生命周期初始化桥，并在请求返回、超时、spawn/进程失败或 stop 时删除；进程已把值载入内存。Windows Credential Manager helper 尚未实现，缺失时必须 fail closed；升级到支持内存凭证注入的上游后必须删除该兼容桥。
- Reasonix beta 在模型调用前 fail-closed 检查 COFORGE 月度预算。ACP v1 尚未给 host 返回可靠 token usage，
  因而当前不做虚假预留或估算结算；结果明确标记 usage unavailable。获得 provider-reported usage 后，
  必须接入原子账本的 reserve/settle 流程，才允许宣称生产级精确结算。
- 生产数据只通过私有适配器进入 MCP，发送给模型的内容按字段最小化并带租户/角色过滤。

## 依赖与发布

上游：`esengine/DeepSeek-Reasonix`，MIT，当前实现基线为 Go `main-v2` / CLI `v1.17.11` / commit `20a64b4d15687fbddb7ccc658daf909f71d01427`。

COFORGE 已固定每个平台的 Reasonix 版本、发布压缩包 SHA-256、可执行文件 SHA-256 和上游
license SHA-256。macOS 构建从显式 `REASONIX_BINARY`/`REASONIX_LICENSE` 或固定
`desktop/.runtime/reasonix-v<version>-<platform>/` 缓存读取当前架构文件；缺失或哈希不符就失败。
应用启动时只使用打包文件，不能依赖 `npm i -g reasonix`，也不会静默下载二进制。

升级策略：机器可读发布清单固定顶层 `{version, tag, commit, protocolVersion, licenseSha256, assets}`；
每个 `assets[platform]` 固定 `{archive, format, archiveSha256, binary, binarySha256}`。运行时与独立发布校验脚本
都拒绝未知/缺失平台、字段或名称漂移；`npm run verify:reasonix` 和 ACP 合约测试通过后才升级。
保留一个已知可用版本以便回滚。

本地有经过清单校验的二进制时，可运行
`npm run smoke:reasonix -- /absolute/path/to/reasonix`；该检查使用 fixture key（不会访问模型 API）和
第一方 MCP fixture，验证真实 `v1.17.11` 的 initialize/session-new/MCP 启动顺序及凭证桥删除。

## 分阶段实现

1. **Runtime spike（已完成）**：已有固定 manifest/校验、隔离 home、ACP TypeScript client，以及 initialize/new/load/prompt/cancel/close、崩溃 reload、超时和工具策略测试。
2. **MCP bridge（beta 已完成）**：query/schema 与七个业务引擎已封装为第一方 MCP server，
   有 JSON Schema、角色、大小、顺序调度与独立 append-only 调用审计；审计只记录 call/event ID、
   工具、操作、角色、结果和输入哈希，不落原始业务参数。
3. **DeepSeek onboarding**：界面默认 DeepSeek Pro/Max，只要求 key；提供连接测试、余额链接/查询、预算与退款提示链接，不代收款、不保管账户。
4. **Desktop packaging**：macOS 构建已内置当前 host 架构 Reasonix、MCP、Node、Keychain helper，
   并携带 COFORGE、Node.js 与 Reasonix 许可资源；arm64 必须在 arm64 host 使用对应 pinned cache 构建。
   Windows helper/打包与最终桌面制品 SBOM 待完成；npm 生产依赖 CycloneDX SBOM 已进入 CI artifact。
5. **Cutover（macOS beta 已完成）**：macOS 桌面默认使用 Reasonix runtime，并可用
   `COFORGE_REASONIX_ENABLED=0` 显式回退。仍需对 SQL、证据、延迟、token 和失败恢复做发布级对比；
   ACP usage 缺口关闭前继续标记 beta，不宣称生产级精确结算。

## 验收门槛

- macOS beta 用户机器没有全局 Reasonix 也能运行；构建不会从 PATH 取 Reasonix，启动时也不下载。
- 默认 UI 只需 DeepSeek key；模型显示“DeepSeek Pro · Max”。
- Reasonix 无法调用 shell、读任意文件或绕过 COFORGE query guard。
- 取消、进程崩溃、API 429/余额不足、MCP 超时均有可恢复状态。
- query 结论可关联 executed SQL、query/audit ID、result hash、Reasonix session/turn；业务方法关联
  MCP call/input/result hash。token usage 尚不可用时必须显式标记，不能伪造或估算成已结算 usage。
- 固定版本、哈希、许可证、升级与回滚可审计；npm 生产依赖 CycloneDX SBOM 已可重复生成并验证。
  最终桌面安装包和容器 image digest 的制品级 SBOM/attestation 仍是正式发布门槛。
