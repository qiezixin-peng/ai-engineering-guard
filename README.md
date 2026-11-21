# AI Engineering Guard (`aeg`)

> **当前版本：`V0.0.1`** | 跨项目复用 · 轻便高能力 · 全体 AI Agent 共用适配（**Gemini / Codex / DeepSeek / Claude / Durable Pi**）

**AI Engineering Guard（简称 AEG，CLI 命令 `aeg`，MCP 服务 `aeg-mcp`）** 是一个独立部署、单进程、无守护进程、跨项目复用的**工程质量决策与门禁引擎**，面向本地开发者、AI Agent、CI（GitHub Actions / GitLab CI / Azure DevOps）以及 Windows / Linux / macOS 跨设备工作流。

它不是新的单元测试框架，也不是 Bazel / Nx / CI 平台的替代品，而是专门回答工程质量最核心的 **5 个问题**：

1. **改了什么？**（Git Diff 变更解析与文件分类 → `ChangeSet`）
2. **影响哪些模块、接口和数据？**（统一 `CapabilityPlanner` + 按需增强 Provider → `ImpactResult`）
3. **风险有多高、为什么？**（确定性 `L0`–`L4` 风险分级与可解释原因 → `RiskAssessment`）
4. **哪些测试必须跑、哪些结果可以安全复用？**（Suite 去重、DAG 依赖与历史失败率排序、精确缓存与跨平台矩阵 → `TestPlan`）
5. **当前变更是否满足提交、交付或合并条件？**（受保护基线防放宽门禁与最小摘要报告 → `GateDecision`）

---

## 核心特性（`V0.0.1`）

### 1. 默认极轻，按需变强
- **单 npm 包、单进程 CLI、零常驻守护进程、零中央数据库**：仅 **3 个直接运行时依赖**（`ajv`、`picomatch`、`yaml`），压缩包 < 100 KB，`aeg --help` 冷启动 ≤ 300 ms。
- **四种模式共享同一决策管线**：`fast` / `balanced`（默认）/ `deep` / `release`，遇到数据库迁移、安全权限、CI/发布或质量配置变更时自动升级深度验证。
- **按需增强 Provider（统一 `EvidenceEnvelope<T>`，同类证据不重复算）**：
  - `builtin-module`：文件到模块映射与显式反向依赖传播（`A depends_on B` → 修改 `B` 级联影响 `A`）
  - `existing-build-graph`：自动检测并复用已有 `Nx` / `moon` / `Pants` / `Bazel` 项目图，不强迫迁移构建体系
  - `import-graph`：轻量相对导入扫描与 `modules.yaml` 漂移检测
  - `ast-symbols`：TS / JS / Python 符号导出、接口契约与跨模块引用分析
  - `gitnexus`：可选的用户自行安装 Provider（不捆绑受限许可证代码，未安装时自动由 `ast-symbols` 接管）
  - `coverage-impact`：按需消费 `coverage/coverage-final.json` 与 `lcov.info`
  - `contracts-db`：OpenAPI / GraphQL / Proto / Prisma 契约变更及破坏性 SQL（`DROP TABLE` / `DROP COLUMN` / `TRUNCATE` 等）检测

### 2. 安全可信优先于“少跑测试”
- **防自我放水（Protected `PolicySnapshot`）**：门禁同时对比受保护基线分支的 `.engineering-guard/` 与当前分支候选配置；候选分支**只能收紧，不得删测试、改命令、降风险、扩缓存或放宽门禁**。
- **分层保守回退**：未分类文件、Provider 异常、缺失测试覆盖或缺失目标平台执行器绝不静默当成“通过”，自动扩大测试或返回 `incomplete`（退出码 `5`）。
- **结构化安全执行**：默认 `shell: false` 直接启动 `executable + args`、限制 `cwd` 逃逸工作区、环境变量白名单、敏感密钥脱敏、超时/取消整棵进程树终止（Windows `taskkill /T /F` + POSIX 进程组）。
- **三级严谨缓存模型**：
  1. **精确 Git Tree 本地缓存**（`.aeg/cache/index.json`）：绑定精确树哈希（含脏工作区内容）、配置、策略与平台指纹，带完整性校验与损坏自愈，失败结果永不入缓存。
  2. **Suite 级输入指纹与 Shadow 验证**：仅对 `hermetic: true` 套件开放，Shadow 对照出现 **1 次不一致立即吊销复用资格并清空缓存**。
  3. **安全签名远程缓存**（`remote-dir` / `remote-http`）：强制 HMAC-SHA256 验签、租户/项目/平台隔离、PR 分支默认只读拉取防投毒。

### 3. 全体 AI Agent 共用适配（Gemini / Codex / DeepSeek / Claude / Durable Pi）
- **零大模型 SDK 绑定**：完全确定性的 CLI + 稳定退出码 `0`–`5` + 极简 `--format agent-summary` JSON，大幅节省上下文 Token。
- **渐进披露与总字节预算**：测试通过时不向 Agent 灌入任何测试日志；失败时按总字节预算截断并脱敏，配合 `aeg inspect failure` / `aeg inspect log <id> --lines 80` 按需展开。
- **子目录自动定位**：Agent 在任意嵌套子目录运行 `aeg` 自动向上回溯仓库根 `.engineering-guard/`。
- **零依赖双帧 stdio MCP Server（`aeg-mcp`）**：同时兼容换行 JSON-RPC 与 `Content-Length` 帧，支持 `2024-11-05` / `2025-03-26` / `2025-06-18` 协议协商，提供全部 **16 个标准 MCP 工具**。
- **开箱即用适配包**：
  - **OpenAI Codex**：[AGENTS.md](./AGENTS.md)、`aeg agents config --agent codex`（生成 `~/.codex/config.toml` TOML 配置）
  - **Google Gemini / Antigravity**：[GEMINI.md](./GEMINI.md)、[universal-skill/SKILL.md](./integrations/agents/universal-skill/SKILL.md)、`aeg agents config --agent gemini`
  - **DeepSeek（Chat / Reasoner / Python & Node Agent）**：[tools.json](./integrations/agents/deepseek/tools.json)、[tool-dispatcher.mjs](./integrations/agents/deepseek/tool-dispatcher.mjs)、[tool_dispatcher.py](./integrations/agents/deepseek/tool_dispatcher.py)、[system-prompt.md](./integrations/agents/deepseek/system-prompt.md)
  - **Claude Code**：[CLAUDE.md](./CLAUDE.md)、`aeg agents config --agent claude`
  - **Durable Pi 跨设备协同**：Windows / Linux / macOS 执行矩阵路由 + Coordinator 凭证聚合（`aeg aggregate`，防重放、单调 Attempt 防旧结果覆盖、HMAC 验签）

### 4. CI、影子抽检与多项目可观测性
- **按需报告**：`text`、`json`、`agent-summary`、**SARIF 2.1.0**（GitHub Code Scanning）、**JUnit XML**。
- **多 CI 模板**：[GitHub Actions](./integrations/github-actions/workflow-example.yml)、[GitLab CI](./integrations/ci/gitlab-ci.yml)、[Azure DevOps](./integrations/ci/azure-pipelines.yml)。
- **预算受控影子全量抽检**：`aeg shadow-check` 定期验证排除套件并计算测试选择召回率（Recall），周预算耗尽时显式延后。
- **历史失败率排序与多项目离线面板**：自动记录 `.aeg/metrics/history.jsonl` 实现高频失败套件 Fail-Fast 优先执行，并可通过 `aeg dashboard --projects <a,b> --out dashboard.html` 生成零 CDN 离线 HTML 面板。

---

## 快速开始

### 1. 安装与构建（需要 Node.js ≥ 20）

```bash
git clone https://github.com/qiezixin-peng/ai-engineering-guard.git
cd ai-engineering-guard
npm install
npm run build
```

> **Windows PowerShell 说明**：如果系统禁用了 `.ps1` 脚本策略，请使用 `npm.cmd`、`.\bin\aeg.cmd` 或 `node ./bin/aeg.js`。

### 2. 接入任意目标 Git 仓库

```bash
# 初始化 .engineering-guard/{config,modules,tests}.yaml
node ./bin/aeg.js init --cwd <目标仓库路径>

# 校验配置 Schema 与交叉引用
node ./bin/aeg.js config validate --cwd <目标仓库路径>

# 一键幂等注入 AGENTS.md / GEMINI.md / CLAUDE.md
node ./bin/aeg.js agents install --cwd <目标仓库路径>

# 运行完整质量检查（开发者文本视图）
node ./bin/aeg.js check --cwd <目标仓库路径>

# 运行完整质量检查（AI Agent 推荐最小摘要视图）
node ./bin/aeg.js check --format agent-summary --cwd <目标仓库路径>
```

### 3. 一键生成多 Agent 配置（Codex / Gemini / DeepSeek / Claude）

```bash
node ./bin/aeg.js agents config --agent all
```

---

## CLI 命令与稳定退出码

| 命令 | 说明 |
|---|---|
| `aeg init` | 扫描项目并在 `.engineering-guard/` 生成 Schema 合规初始配置 |
| `aeg check` | 日常主入口：`analyze → impact → risk → plan → test → gate` 单进程闭环 |
| `aeg config validate` | 校验 YAML 配置、DAG 依赖环、工作区路径边界与便携声明 |
| `aeg config migrate [--dry-run]` | 安全升级配置文件并自动生成时间戳备份 |
| `aeg explain risk` / `aeg explain test <suite>` | 解释风险分级原因或单个套件被选择/缓存/阻塞/排除的证据 |
| `aeg baseline` | 对比受保护基线 `PolicySnapshot` 与当前候选配置差异及放宽项 |
| `aeg analyze` / `aeg plan-tests` / `aeg test --plan <file>` / `aeg gate` | 分阶段管道切面（供 CI 与 Durable Pi 编排调用） |
| `aeg inspect failure [id]` / `aeg inspect log <id>` | 渐进式查看失败诊断与有界脱敏日志片段 |
| `aeg aggregate --plan <file> --receipts <path>` | Coordinator 侧跨平台（Win/Linux/macOS）凭证验签与聚合门禁 |
| `aeg shadow-check [--force]` | 预算受控的影子全量验证与召回率审计 |
| `aeg dashboard --projects <a,b> --out <html?>` | 多项目质量可观测性汇总与离线 HTML 面板 |
| `aeg agents config` / `aeg agents install` | 生成各 Agent 配置片段 / 幂等写入仓库 Agent 指令 |
| `aeg mcp`（或 `aeg-mcp`） | 启动零依赖双帧 stdio MCP Server（16 个工具） |

### 稳定退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 执行成功 / 门禁通过（`workflow_action` 为 `continue` 或 `require_approval`） |
| `1` | 测试套件失败 |
| `2` | 质量门禁拒绝（如候选配置企图放宽基线策略、`delivery`/`release` 脏工作区） |
| `3` | 配置或 JSON Schema 校验错误 |
| `4` | 工具、适配器或执行器错误（含命令超时终止） |
| `5` | 证据不完整且策略阻断（缺失平台执行器、受影响模块无测试覆盖、阻塞未知项） |

---

## 项目配置结构

每个接入仓库只需维护声明式的 `.engineering-guard/`（入 Git 版本控制），运行产物、日志与缓存统一写入已加入 `.gitignore` 的 `.aeg/`：

```text
.engineering-guard/
├── config.yaml    # 分析模式、Provider 开关、风险规则、缓存与门禁策略
├── modules.yaml   # 模块路径、反向依赖图、公共 API 与契约声明
└── tests.yaml     # 结构化测试命令、覆盖模块、平台能力与历史回归规则
```

---

## 开发与测试

```bash
npm run typecheck   # TypeScript 严格类型检查
npm run build       # 编译 dist/
npm test            # 运行全部单元测试、集成测试、黄金测试、多 Agent 兼容测试与性能预算基准
npm run check:self  # 使用 AEG 对自身仓库执行狗食（Dogfooding）质量检查
```

更多细节请参阅：
- [多 Agent 适配指南（Gemini / Codex / DeepSeek / Claude / Durable Pi）](./docs/AGENT-ADAPTATION.md)
- [架构决策记录 ADR-0001](./docs/adr/0001-mvp-architecture.md)
- [版本变更日志 CHANGELOG.md](./CHANGELOG.md)

## License

[MIT](./LICENSE)
