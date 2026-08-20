# dsh-sqlkb — SQL 知识注册表插件（渐进式披露）

为 DeepSeek Harness（DSH）设计的 SQL 知识管理插件，解决「表结构缓存/常用 SQL 文件越滚越大、无法精准检索、占用上下文」三大痛点。

**核心思路（与 skill 的渐进式披露同构，但由插件代码确定性控制）：**

| 时机 | 行为 | 由谁控制 |
|------|------|---------|
| 会话每一轮 prompt 组装 | 注入紧凑「描述层」section：每表/每示例一行（名称/类型/用途/执行方式/引擎/标签/文件路径），**绝不含字段明细与 SQL 正文** | 插件代码（确定性，不读整文档） |
| 需要明细时 | 模型调用 `sqlkb_search` 检索 → `sqlkb_get` 读取**单个**明细文件返回 | 插件代码（精确、有界、按需） |
| 新增/修改知识后 | `sqlkb_validate` 校验规范性 | 插件代码 |

**安装于宿主层（web profile）**：挂在 profile bundle 层，**任意 preset / 任意模式 / 任意会话共享**，无需选择专用模式。

## 安装

```bash
dsh plugin --profile web add @sidleo3/dsh-sqlkb
```

本地开发安装（源码目录）：

```bash
dsh plugin --profile web add link:/path/to/this/checkout
```

> 修改 profile 组合后需**重启 `dsh web`** 生效。

## 配置（数据目录）

- **默认数据目录**：`~/.agents/sqlkb`（首次使用自动创建 `tables/`、`examples/` 骨架与种子 README）
- 插件不包含任何业务知识内容；知识文件由你自行维护在数据目录（或修改为任意路径）

**自定义路径**：在 profile 的 `cordis.patch.yml` 中 id 定向覆盖（后写者胜，需写全 config 键）：

```yaml
- id: yh-sqlkb
  config:
    dataDir: /absolute/path/to/sqlkb
    sectionName: yh-sqlkb-registry
    sectionOrder: 60
    maxSectionChars: 6000
```

## 工具

| 工具 | 用途 |
|------|------|
| `sqlkb_search { query, kind? }` | 关键词检索表/示例（名称/用途/标签/引擎/相关表），返回紧凑命中行 |
| `sqlkb_get { id }` | 按表名或示例名读取**单个**明细文件，返回完整内容（字段清单或 SQL 正文） |
| `sqlkb_validate { }` | 按规范校验整个知识目录（front-matter 完整性、命名一致性、重复、空正文） |

## 知识目录规范（tables / examples）

数据目录结构：

```
~/.agents/sqlkb/
├── README.md            # 种子说明（自动生成，含规范）
├── tables/<表名>.md     # 每表一个文件
└── examples/<示例名>.md # 每示例一个文件
```

**表文件 front-matter（必填）**：

```yaml
---
name: dm.dm_sale_setl_dly_sum_1d   # 与文件名一致，唯一
type: 事实表（销售汇总日）           # 事实表/维表/临时表等
purpose: 日常销售查询首选            # 一句话用途（描述层展示）
exec: skill:yh-bigdata             # 如何执行 SQL（CLI/程序/skill 名）
engines: impala, hive              # 支持的 SQL 引擎，逗号分隔
tags: 销售, 汇总, 日报              # 检索标签
related: dws.dws_sale_setl_dly_sum_1d  # 可选：同构/关联表
---
[正文：属性表 + 全量字段清单 + 补充]
```

**示例文件 front-matter**：

```yaml
---
name: 客单价查询          # 与文件名一致
purpose: 计算品类客单价 = 销售额 / 客流
tables: dm.dm_sale_setl_dly_sum_1d, dws.dws_sale_mld_sales_custflow_1d  # 用到的表，必填
tags: 客单价, 销售
---
[正文：用途 + 口径 + SQL + 说明 + 来源]
```

**口径红线约定（写入每个示例的「口径」段）**：各指标的**唯一来源表/字段**、禁止用什么替代（如「销售额唯一来源 dm 表，禁用客流表自带销售额字段」），让模型读到即按口径执行、不做单表简化。

## 维护

- **新增表**：新建 `tables/<表>.md`（front-matter 五要素 + 正文）→ 下个描述层缓存窗口自动出现，无需改插件
- **新增示例**：新建 `examples/<示例>.md`（`tables` 字段必填）→ 自动收录
- **修改**：直接编辑对应文件，`sqlkb_validate` 校验合规
- **红线**：描述层永远只含 front-matter 元数据；字段明细/SQL 正文只进各自文件

## 设计说明

- 描述层注入走 `system-prompt/assemble` 瀑布（注册同步、异常不外抛，绝不影响 prompt 组装），与 DSH 官方 tool-bootstrap 同机制
- 插件不 publish 任何 service，纯消费 `systemPrompt`/`tools`，可安全挂载于宿主层
- 知识数据是纯 markdown（front-matter + 正文），工具无关，任何编码代理（pi/Claude Code 等）可直接按文件路径读取

## 许可

MIT