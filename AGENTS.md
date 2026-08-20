# dsh-sqlkb 项目规范

> SQL 知识注册表（渐进式披露）插件：会话开始只注入表/示例描述层，明细按需经工具读取。
> 仓库结构：插件源码（sqlkb.mjs）+ bundle 补丁（cordis.patch.yml）+ 用户文档（README.md）+ 本规范（AGENTS.md）。

## 能力定位

- **插件职责**：host 进程内的宿主层插件（web profile bundle）。每轮 prompt 组装注入紧凑描述层 section；提供 `sqlkb_search` / `sqlkb_get` / `sqlkb_validate` 三个工具。**不 publish 任何 service**，仅消费 `systemPrompt` / `tools`。
- **知识数据**：业务表结构/示例属用户私有内容，**一律不进本仓库、不随 npm 包分发**。数据默认放 `~/.agents/sqlkb`（可配置 `dataDir` 覆盖），由用户自行维护。

## 目录结构

```
sqlkb/
├── sqlkb.mjs          # 插件主入口（exports name/inject/apply），Node ESM
├── cordis.patch.yml   # bundle 补丁：插入 yh-sqlkb 行（name 指向包名）
├── package.json       # npm 包声明（dsh.bundle.patch 指向补丁）
├── README.md          # 用户文档：安装/配置/工具/知识目录规范
├── AGENTS.md          # 本文件
├── LICENSE            # MIT
└── .gitignore
```

## 开发与修改

- **改插件行为**：编辑 `sqlkb.mjs`，保持导出形态 `export const name / inject / apply`；工具定义输出 schema 遵循 `{ type: 'object', additionalProperties: false, properties, required }` 形态（DSH 宿主 schema DSL）；`parameters` 根开放（不写 additionalProperties）。
- **事件注入安全规则**：描述层注入只能走 `system-prompt/assemble` 瀑布事件（apply 同步注册监听器）；**禁止在异步回调里调用 `ctx.systemPrompt.section()`**（上下文失效会崩掉整个 web 进程——历史教训，见前序迭代）。
- **知识目录规范**：改动知识规范时，同步更新 `sqlkb.mjs` 内 `SEED_README` 与 `README.md`「知识目录规范」两处，保持一致。
- **路径默认值**：`DEFAULTS.dataDir` 用 `os.homedir()` 计算（`~/.agents/sqlkb`），不得硬编码绝对路径；用户覆盖走 profile 补丁 config。
- **本地验证**：`node --check sqlkb.mjs` 语法；`dsh --profile web --dump-config | grep yh-sqlkb` 确认组合树包含补丁行。

## 发布流程

1. 确认无未提交改动；`npm version patch`（或手动改 version）
2. 检查 npm 包内容：`npm pack --dry-run`（`files` 白名单：sqlkb.mjs / cordis.patch.yml / README.md / AGENTS.md / LICENSE）
3. 发布：`npm publish --access public`
4. 打 GitHub tag：`git tag v<version> && git push origin v<version>`（GitHub 由 `gh repo create sidleo/dsh-sqlkb --public --source . --push` 建仓）
5. 使用方安装：`dsh plugin --profile web add @sidleo3/dsh-sqlkb`，重启 `dsh web`

## 多工具指令文件约定（与永辉项目一致）

- `AGENTS.md` 为唯一内容来源；同目录 `CLAUDE.md`、`CODEBUDDY.md` 用相对路径软链接指向它（`ln -s AGENTS.md CLAUDE.md`），保证 git 可移植。

## 行为约束

- 直接执行，不预先检查；改动前先读仓库现有结构与历史提交，遵循「外科手术式修改」。
- 涉及用户知识数据（`~/.agents/sqlkb`）的操作：改表/示例内容前先与用户确认；只读检索可自行执行。