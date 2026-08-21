# dsh-sqlkb 项目规范

> SQL 知识注册表（渐进式披露）插件：会话开始只注入表/示例描述层，明细按需经工具读取。
> 仓库结构：插件源码（sqlkb.mjs）+ bundle 补丁（cordis.patch.yml）+ 用户文档（README.md）+ 本规范（AGENTS.md）。

## 能力定位

- **插件职责**：host 进程内的宿主层插件（web profile bundle）。每轮 prompt 组装注入精简描述层 section（声明知识库存在与工具用法，**不铺开全部表/示例清单**，并在【硬要求】中强制第一步先 `sqlkb_list`）；提供 `sqlkb_list` / `sqlkb_search` / `sqlkb_get` / `sqlkb_validate` / `sqlkb_pending` / `sqlkb_create` / `sqlkb_update` 共七个工具（list/search/get 支持坑点；create/update 支持 kind=table/example/pitfall）。**不 publish 任何 service**，仅消费 `systemPrompt` / `tools`。
- **坑点机制**：坑点存 `pitfalls/<坑名>.md`（front-matter 必填 name/type/tables/tags，related_examples/severity 可选）。**方式1 自动暴露**：`sqlkb_search` 命中表/示例、`sqlkb_get` 读表/示例时，按坑点 `tables`/`related_examples` 自动附上相关坑点。**沉淀**：执行 SQL 出错/踩坑后用 `sqlkb_create(kind=pitfall, tables=相关表)` 直接记录（**无需 user_approved**，纯追加经验），避免重复踩坑。改坑点逻辑时保持此语义并同步 README/描述层。
- **创建/更新规范**：`sqlkb_create`（新增表/示例/坑点）与 `sqlkb_update`（更新已有）均须遵循 front-matter 规范（表必填 name/type/purpose/exec/engines/tags、示例必填 name/purpose/tables/tags、坑点必填 name/type/tables/tags）、正文语义正确。**表/示例写入必须 user_approved: true（用户明确同意）**；坑点记录/修订允许自行执行。`sqlkb_update` 只更新传入字段、省略则保留原值，删到缺必填字段会被拦截；条目不存在时改用 create。
- **搜索语义（sqlkb_search）**：表匹配范围 = 元数据（name/type/purpose/exec/related/engines/tags）+ **正文字段名与字段注释**（业务指标词如「销售额」也能命中含 `restore_sales_amt` 字段的表）；支持词元拆分（「销售总额 销售额」不要求整串）与量词后缀兜底（「销售总额」→「销售」）；命中按强/弱分级（强匹配标 ★ 排前）。示例只搜元数据不搜正文。改搜索逻辑时保持此语义，并同步更新 README 工具表说明。
- **待补池机制**：`sqlkb_search` 未命中会**自动附上全量清单**（让 agent 一步到位看到资源）；`sqlkb_search`/`sqlkb_get` 未命中均自动留痕到进程内存待补池（按 agent 会话隔离、不写任何文件、重启即清空），描述层提示模型任务收尾时经用户同意后用 `sqlkb_create` 补录。涉及用户知识数据的写入（`tables/`/`examples/`）必须在用户明确同意后执行（`user_approved: true` 门控）。
- **表和示例都要看**：定好目标表后，**示例与表结构不是二选一**——描述层强制先 `sqlkb_get` 读相关【示例】（口径红线/SQL，优先复用）再读【表】字段清单，两者都读完才写 SQL。改描述层/工具说明时保持此约束。
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