## Easy Code Added Memories
### 项目概述
Easy Code 是一个 AI 驱动的智能编程助手，采用 monorepo 架构，包含 4 个主要包：
- **cli** (easycode-cli): 命令行界面 (binary: "easycode")
- **core** (easycode-core): 核心功能库，被其他包依赖
- **vscode-ui-plugin** (easycode-ai-vscode-ui-plugin): 完整的 VS Code 扩展，提供可视化 AI 编码辅助
- **desktop** (easycode-desktop): Electron 桌面应用
- **vscode-ide-companion** (easycode-ai-vscode-companion): 轻量级 IDE 集成伙伴（不常更新）

**技术栈**: Node.js 20+, TypeScript 5.9+, React 19, Ink 6.4.7, esbuild 0.25, Vitest 3.2

### 项目架构
```
Easy Code (Monorepo)
├── packages/
│   ├── cli/                     # 命令行界面
│   │   ├── src/ui/              # React-based terminal UI (Ink框架)
│   │   ├── src/services/        # 服务层 (CommandService, SkillLoader等)
│   │   ├── src/auth/            # 身份认证
│   │   ├── src/config/          # 配置管理 (extensions, settings)
│   │   ├── src/commands/        # 内置命令 + extensions 命令
│   │   ├── src/acp/             # 自动代码补全
│   │   ├── src/remote/          # 远程功能
│   │   └── gemini.tsx           # 主入口点
│   ├── core/                    # 核心功能库
│   │   ├── src/tools/           # 工具系统 (文件、shell、web、MCP等)
│   │   ├── src/core/            # 核心逻辑 (GeminiChat、prompt管理)
│   │   ├── src/auth/            # 身份认证系统 (OAuth2)
│   │   ├── src/mcp/             # Model Context Protocol 支持
│   │   ├── src/code_assist/     # 代码辅助功能
│   │   ├── src/hooks/           # Hooks 钩子系统
│   │   ├── src/skills/          # Skills 技能系统
│   │   ├── src/lsp/             # Language Server Protocol
│   │   ├── src/services/        # 核心服务层
│   │   ├── src/telemetry/       # 遥测系统
│   │   └── src/utils/           # 工具函数
│   ├── vscode-ui-plugin/        # VS Code 完整扩展
│   │   ├── src/                 # Extension 主代码
│   │   └── webview/             # React webview UI
│   └── vscode-ide-companion/    # VS Code 轻量级集成
├── docs/                        # 完整文档系统
│   ├── HOOKS_*.md              # Hooks 系统文档
│   ├── cli/                    # CLI 文档
│   ├── core/                   # Core 文档
│   └── tools/                  # 工具文档
├── scripts/                     # 构建和工具脚本
│   ├── build.js                # 主构建脚本
│   ├── newpack.js              # 打包脚本
│   └── tests/                  # 脚本测试
└── 配置文件 (package.json, tsconfig.json, eslint.config.js等)
```

**内部依赖关系**: cli → core; vscode-ui-plugin → core (通过 npm workspaces)

**核心特点**:
- 🏗️ 单仓库架构 (npm workspaces)
- 🔧 丰富的工具系统 (20+ 内置工具)
- 🔌 MCP 协议支持 (与外部服务集成)
- 🪝 Hooks 钩子机制 (安全控制和扩展)
- 🎯 Skills 技能系统 (可复用的 AI 工作流)
- 🧪 完整测试覆盖 (396 测试文件)
- 📦 跨平台支持 (Windows, macOS, Linux)
- 🌐 i18n 国际化支持

### 开发规范

#### AI 工作流程规范
1. **构建测试**: 始终使用 `npm run build` 测试代码是否能通过编译
2. **禁止交互式启动**: 不要使用 `npm run dev` 或 `npm start`（会启动交互式 CLI）
3. **临时脚本管理**: 可以编写临时测试脚本验证功能，但完成后必须清理
4. **测试要求**: 对 cli 和 core 包的业务修改，必须同时更新对应的 test 文件。测试难度大时可先用 skip 占位
5. **单文件测试优先**: ⚠️ 禁止运行全量测试（`npm run test`）！仅测试修改的文件：
   - 使用 `npx vitest run <test-file-path>` 测试单个文件
   - 例如：`npx vitest run packages/cli/src/ui/hooks/useCompletion.test.ts`
   - 全量测试由 CI/CD 自动运行，本地开发节省时间
6. **Git 提交规范**: 在解决同一个任务或修复同一个问题的过程中，应优先使用 `git commit --amend` 将多次修改合并为一笔提交，避免产生大量琐碎的提交记录。只有在完成一个逻辑独立的阶段性功能时，才创建新的提交。
7. **发版流程规范**: 在执行任何代码提交推送和发版流程前，**必须在主线分支上拉取最终代码并双重执行 `npm run build` 确保本地构建 100% 全绿**！创建与合并 Merge Request 时，应**优先使用本地 `glab` 命令行工具**。严禁“带病发版”或越过本地编译，详情请务必主动阅读并查阅发版指南 Wiki [`.llm-wiki/wiki/release-process.md`](.llm-wiki/wiki/release-process.md)。

#### 代码规范
1. **i18n 国际化**: 所有面向最终用户的 UI 文案必须国际化
2. **日志语言**: 开发调试日志可不做 i18n，但尽量使用英文
3. **类型安全**: 使用 TypeScript strict 模式
4. **代码风格**: 遵循 ESLint 配置 (eslint.config.js)

#### 测试规范
- **单元测试**: 使用 Vitest 3.2
- **测试覆盖**: 396 测试文件覆盖核心功能
- **CI/CD**: `npm run test:ci` 自动化测试
- **测试命令**:
  - ⚠️ `npm run test` - 全量测试（AI 禁止使用，仅用于 CI）
  - ✅ `npx vitest run <file>` - 单文件测试（AI 推荐使用）
  - ✅ `npx vitest run packages/cli/src/**/*.test.ts` - 按目录测试
  - `npm run test:ci` - CI 模式（含覆盖率）
  - `npm run test:scripts` - 脚本测试
- **AI 测试策略**:
  - 只测试你修改的文件及其对应的 test 文件
  - 示例：修改了 `useCompletion.ts` → 运行 `npx vitest run packages/cli/src/ui/hooks/useCompletion.test.ts`
  - 避免运行全量测试以节省开发时间和系统资源

### 用户偏好
- ❌ 尽量不生成 .md 文件（除非用于 AI 任务记忆，且用完必须删除）
- ❌ 尽量不使用 sequentialthinking 工具

### 项目关键文件
- `EasyCode_Code_Whitepaper.md` - 项目白皮书
- `DEEPV.md` - 本文件（AI记忆文件）
- `docs/index.md` - 文档总索引
- Easy Code 项目目录命名约定（极易搞错，务必记住）：全局配置目录是 `~/.easycode-user/`（用户家目录下），项目级配置目录是 `<projectRoot>/.easycode/`（项目根目录下）。两个目录名前缀不同是为了规避命名冲突，绝不能混用：项目里出现 `.easycode-user` 是错误，全局出现 `.easycode` 也是错误。`PROJECT_DIR_PREFIX = '.easycode'` 定义在 `packages/core/src/utils/paths.ts`。例如飞书凭证只走全局，固定写入 `~/.easycode-user/feishu-credentials.json`，不接受 projectRoot 参数。
- 用户要求交流时：1) 不使用浮夸的赞美和认同；2) 保持独立思辨能力，对用户的说法进行批判性判断，不盲从（用户说的不一定都对）；3) 用词严谨专业，不使用网络用语。
- 始终使用中文进行交流。
- 在 Easy Code 项目中提交代码时，不要自动提升 package.json 版本号。只有当用户明确要求提升版本号时才提升，否则保持版本号不变。
- hwjcode 发版推 tag 时禁止用 git push --tags 批量推送。GitHub Actions 限制：一次 push 超过 3 个 tag 不会创建任何事件，会导致 CI/CD 不触发。正确做法：先 git push origin master 推分支，再 git push origin <tag> 单独推目标 tag。
- hwjcode 项目的发版规则：只有"PR 合并到 master"会自动 bump patch 版本号并打 tag 触发 release.yml 发版到 npm；直接 `git push origin master`（不经过 PR 合并）不会触发自动发版。如果直接 push 后想发版，需要手动 bump 版本号 + 打 `v*.*.*` tag 并推送，tag 会触发 release.yml 自动构建并发布到 npm 和 GitHub Release。

## Easy Code Added Memories
- DeepV Code → Easy Code 品牌改名时，MCP OAuth 相关的 "Gemini" 标识符必须保留不改——因为对外需以 Gemini 身份才能被第三方 OAuth 服务授权识别（对方系统只认 Gemini）。品牌改名只针对用户可见的文案提示，不动这类对外身份标识符。

## DeepV Code Added Memories
- 本仓库是上游 Easy Code 项目的个人 fork，不走上游 CI 发版流程。版本号与上游 release tag 完全一致（同步脚本 `scripts/sync-upstream.sh` 会自动对齐），不存在「版本号必须严格低于 tag」的约束。
- 演示了工具调用能力，用户要求尽可能多地展示可用工具
- 独立 GitLab仓库: `https://gitlab.liebaopay.com/huangweijian/DeepVcodeClient`（项目ID: 9774），可用 GitLab API 创建/合并 MR。上游仓库: `https://gitlab.liebaopay.com/ai_native/DeepVCode/DeepVcodeClient`。开发规范见 `.llm-wiki/wiki/development-workflow.md`，同步脚本见 `scripts/sync-upstream.sh`。Token 等敏感信息见 `.secrets` 文件。
- hwjcode 已发布到 npmjs.org，包名 hwjcode，CLI 命令名 hwjcode，bin 指向 bundle/easycode.js（内部文件名未改），自更新常量 SELF_UPDATE_PACKAGE='hwjcode', SELF_UPDATE_RELAUNCH_COMMAND='hwjcode'。安装命令：npm i -g hwjcode。npm 账号 hwj123weijian。
- DeepV Code fork 的 npm 版本号独立领先于上游 tag。sync-upstream.sh 版本号对齐策略为"取本地版本和上游 tag 的较大值，只升不降"（sort -V | tail -1），不会因上游 tag 较低而降版本。每次上游同步后需要手动升 patch 版本号并 npm publish 发版。
- npm 发布 token 见 `.secrets` 文件。npm 账号 hwj123weijian。

## Easy Code Added Memories (upstream)
- 本项目曾叫 DeepV Code，现已品牌升级为 Easy Code。记忆文件仍沿用 `DEEPV.md` 文件名，主要是为了对存量用户兼容，不要改名。
- Easy Code 发版 tag 版本号对齐规则：CLI 和 VSCode 的 release tag 版本号必须对齐（如 cli-release-v1.1.15 和 vscode-release-v1.1.15），package.json 中的版本号必须严格低于 tag 版本号。
