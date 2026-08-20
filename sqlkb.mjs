/**
 * dsh-sqlkb — SQL 知识注册表（渐进式披露）插件。
 *
 * 核心编码行为（由代码控制，不依赖模型判断）：
 * 1. 会话每轮 prompt 组装时（system-prompt/assemble 瀑布内）注入一个紧凑「描述层」
 *    section：每表/每示例一行（名称/类型/用途/执行方式/引擎/标签/文件路径），
 *    绝不含字段明细与 SQL 正文。
 * 2. 提供工具：sqlkb_search（关键词检索描述层，返回紧凑命中行）、
 *    sqlkb_get（按 id 读取单个明细文件返回完整内容）、
 *    sqlkb_validate（按编写规范校验知识目录，支持持续新增/修改表与示例）。
 * 3. 数据源为 front-matter + 正文的 markdown 文件；默认目录 ~/.agents/sqlkb，
 *    可在安装配置中通过 dataDir 覆盖（见项目 README）。
 *
 * 注：监听器注册发生在 apply 的同步阶段；异步读盘与任何异常都包在 try/catch 内，
 * 组装阶段不会抛错中断 prompt。section 每次组装按缓存 TTL 刷新。
 */
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'yh-sqlkb'

/** 依赖 services：systemPrompt（事件、section）、tools（工具注册）。本插件不 publish 任何 service。 */
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = {
  dataDir: join(homedir(), '.agents', 'sqlkb'),
  sectionName: 'yh-sqlkb-registry',
  sectionOrder: 60,
  maxSectionChars: 6000,
  maxGetChars: 40000,
  cacheTtlMs: 30000,
}

/** 知识目录种子说明（目录不存在时自动写入，仅创建骨架，不含任何业务数据）。 */
const SEED_README = `# sqlkb 知识目录

sqlkb 插件按需读取本目录的 markdown 文件（front-matter + 正文）。

## 结构
- tables/<表名>.md      每表一个文件：属性 + 全量字段清单 + 补充
- examples/<示例名>.md  每示例一个文件：用途 + SQL + 说明

## 表文件 front-matter（必填 5 项）
\`\`\`yaml
---
name: <表名>            # 唯一标识，如 dm.dm_sale_setl_dly_sum_1d（与文件名一致）
type: <类型>            # 事实表/维表/临时表等
purpose: <一句话用途>    # 描述层展示
exec: <执行方式>        # 如何执行 SQL，如 skill:yh-bigdata（yh_bigdata CLI）
engines: impala, hive  # 支持引擎，逗号分隔
tags: 销售, 汇总        # 检索标签，逗号分隔
related: <同构库>       # 可选
---
\`\`\`

## 示例文件 front-matter
\`\`\`yaml
---
name: <示例名>           # 与文件名一致
purpose: <一句话用途>
tables: <用到的表清单>   # 逗号分隔，必填
tags: <检索标签>
---
\`\`\`

## 编写规范（sqlkb_validate 会校验）
- 新增表/示例：按上面模板新建文件即可，描述层下个缓存窗口自动包含，无需改插件
- 口径红线：每个示例「口径」段写明各指标唯一来源表/字段、禁止用什么替代
- 正文细节只进各自文件；描述层只含 front-matter 元数据
`

function listVal(v) {
  if (v === undefined || v === null || v === '') return []
  return String(v).split(/\s*,\s*/).filter(Boolean)
}

function parseFM(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return { meta: {}, body: text }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { meta: {}, body: text }
  const meta = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i])
    if (m) meta[m[1]] = m[2].trim()
  }
  return { meta, body: lines.slice(end + 1).join('\n') }
}

/** 确保知识目录骨架存在；首次使用自动写种子 README（不覆盖已有文件）。 */
async function ensureDir(dataDir) {
  let created = false
  const names = [dataDir, join(dataDir, 'tables'), join(dataDir, 'examples')]
  for (const dir of names) {
    try { await mkdir(dir, { recursive: true }) } catch { /* 已存在 */ }
  }
  const readmePath = join(dataDir, 'README.md')
  try {
    await stat(readmePath)
  } catch {
    try { await writeFile(readmePath, SEED_README, 'utf8'); created = true } catch { /* 只读环境忽略 */ }
  }
  return created
}

async function readAll(dataDir) {
  await ensureDir(dataDir)
  const out = { tables: [], examples: [] }
  for (const sub of ['tables', 'examples']) {
    let names = []
    try { names = await readdir(join(dataDir, sub)) } catch { continue }
    for (const nm of names) {
      if (!nm.endsWith('.md')) continue
      let text
      try { text = await readFile(join(dataDir, sub, nm), 'utf8') } catch { continue }
      const { meta, body } = parseFM(text)
      if (!meta.name) continue
      out[sub].push({ meta, body, file: `${sub}/${nm}` })
    }
  }
  return out
}

function tableLine(t) {
  const m = t.meta
  const parts = [
    `- ${m.name}｜${m.type || ''}｜${m.purpose || ''}`,
    `exec:${m.exec || '?'}`,
    `engines:${listVal(m.engines).join(',') || '?'}`,
    `tags:${listVal(m.tags).join(',')}`,
  ]
  if (m.related) parts.push(`related:${m.related}`)
  parts.push(`file:${t.file}`)
  return parts.join('｜')
}

function exampleLine(e) {
  const m = e.meta
  return `- ${m.name}｜${m.purpose || ''}｜tables:${listVal(m.tables).join(',')}｜tags:${listVal(m.tags).join(',')}｜file:${e.file}`
}

async function buildSection(dataDir, maxSectionChars) {
  const data = await readAll(dataDir)
  data.tables.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  data.examples.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  const lines = [
    '## SQL 知识注册表（描述层）',
    `> 数据源：${dataDir}。此处只含描述；字段明细/SQL 正文用 sqlkb_get 按需获取，勿整体读取明细文件。`,
    '',
    '执行通道：见知识目录 README（表/示例 front-matter 的 exec/engines 字段声明）。',
    '',
    `表目录（${data.tables.length}）：`,
    ...data.tables.map(tableLine),
    '',
    `示例目录（${data.examples.length}）：`,
    ...data.examples.map(exampleLine),
  ]
  let text = lines.join('\n')
  if (text.length > maxSectionChars) text = text.slice(0, maxSectionChars) + '\n…（描述层超限截断，请用 sqlkb_search 检索）'
  return text
}

/** 按编写规范校验知识目录，返回问题清单（支持持续新增/修改表、示例）。 */
async function validate(dataDir) {
  const issues = []
  const data = await readAll(dataDir)
  const seen = new Set()
  for (const sub of ['tables', 'examples']) {
    const isTable = sub === 'tables'
    const required = isTable ? ['name', 'type', 'purpose', 'exec', 'engines', 'tags'] : ['name', 'purpose', 'tables', 'tags']
    const items = data[sub]
    for (const it of items) {
      const nm = it.file.replace(/^.*\//, '').replace(/\.md$/, '')
      if (it.meta.name !== nm) issues.push(`${it.file}: front-matter name「${it.meta.name}」与文件名「${nm}」不一致`)
      if (seen.has(it.meta.name)) issues.push(`${it.file}: name「${it.meta.name}」重复`)
      seen.add(it.meta.name)
      for (const key of required) {
        if (it.meta[key] === undefined || it.meta[key] === '') issues.push(`${it.file}: 缺少必填字段 ${key}`)
      }
      if (!isTable && !listVal(it.meta.tables).length) issues.push(`${it.file}: 示例必须声明用到的表 tables`)
      if (isTable && !listVal(it.meta.engines).length) issues.push(`${it.file}: 表必须声明支持引擎 engines`)
      if (!it.body.trim()) issues.push(`${it.file}: 正文为空`)
    }
  }
  let text
  if (!data.tables.length && !data.examples.length) {
    text = `知识目录为空：${dataDir}（骨架已自动创建，按目录内 README.md 规范添加表/示例）`
  } else if (issues.length) {
    text = `校验发现 ${issues.length} 个问题：\n` + issues.map((s) => `- ${s}`).join('\n')
  } else {
    text = `校验通过：${data.tables.length} 张表 + ${data.examples.length} 个示例，全部符合规范`
  }
  return text
}

export function apply(ctx, config) {
  const dataDir = String(config?.dataDir || DEFAULTS.dataDir)
  const sectionName = String(config?.sectionName || DEFAULTS.sectionName)
  const sectionOrder = Number.isFinite(config?.sectionOrder) ? config.sectionOrder : DEFAULTS.sectionOrder
  const maxSectionChars = Number.isFinite(config?.maxSectionChars) ? config.maxSectionChars : DEFAULTS.maxSectionChars
  const maxGetChars = Number.isFinite(config?.maxGetChars) ? config.maxGetChars : DEFAULTS.maxGetChars
  const cacheTtlMs = Number.isFinite(config?.cacheTtlMs) ? config.cacheTtlMs : DEFAULTS.cacheTtlMs

  // 确保知识目录存在（首次自动建骨架 + 种子 README）
  ensureDir(dataDir).catch(() => {})

  let cached = null
  let cachedAt = 0
  async function getSectionText() {
    const now = Date.now()
    if (cached !== null && now - cachedAt < cacheTtlMs) return cached
    cached = await buildSection(dataDir, maxSectionChars)
    cachedAt = Date.now()
    return cached
  }

  // 会话级事件监听：每轮 prompt 组装时注入描述层 section。注册是同步的；
  // 异步读盘在瀑布内 await，异常不外抛，绝不影响 prompt 组装。
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    try {
      const text = await getSectionText()
      if (assembly && Array.isArray(assembly.sections)) {
        const existing = assembly.sections.findIndex((s) => s && s.name === sectionName)
        const section = { name: sectionName, text, order: sectionOrder }
        if (existing >= 0) assembly.sections[existing] = section
        else assembly.sections.push(section)
      }
    } catch {
      // 静默降级：组装阶段不因知识库问题中断
    }
    return next()
  })

  const textOut = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }

  ctx.tools.register({
    name: 'sqlkb_search',
    description: [
      '搜索 SQL 知识注册表：匹配表/示例的名称、用途、标签、引擎、相关表。',
      '只返回紧凑描述行（绝不返回完整字段表或 SQL 正文），命中后用 sqlkb_get 按 id 取完整明细。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        kind: { type: 'string', enum: ['table', 'example', 'all'], description: '限定范围（默认 all）' },
      },
      required: ['query'],
    },
    output: textOut,
    async execute(args) {
      const data = await readAll(dataDir)
      const q = String(args.query || '').toLowerCase().trim()
      if (!q) return { text: 'query 不能为空' }
      const kind = args.kind || 'all'
      const out = []
      if (kind === 'all' || kind === 'table') {
        const hits = data.tables.filter((t) => {
          const m = t.meta
          const hay = [m.name, m.type, m.purpose, m.exec, m.related, ...listVal(m.engines), ...listVal(m.tags)].join(' ').toLowerCase()
          return hay.includes(q)
        })
        if (hits.length) {
          out.push(`表（${hits.length} 命中）：`)
          for (const t of hits) out.push(tableLine(t))
          out.push('')
        }
      }
      if (kind === 'all' || kind === 'example') {
        const hits = data.examples.filter((e) => {
          const m = e.meta
          const hay = [m.name, m.purpose, ...listVal(m.tables), ...listVal(m.tags)].join(' ').toLowerCase()
          return hay.includes(q)
        })
        if (hits.length) {
          out.push(`示例（${hits.length} 命中）：`)
          for (const e of hits) out.push(exampleLine(e))
        }
      }
      if (!out.length) return { text: `未命中「${args.query}」。可换关键词或指定 kind=table/example。` }
      return { text: out.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'sqlkb_get',
    description: [
      '读取注册表中单个条目的完整明细：',
      '- 表名（如 dm.dm_sale_setl_dly_sum_1d）→ 返回该表完整字段清单、属性、补充说明；',
      '- 示例名（如 销售多维度汇总查询）→ 返回完整 SQL 与说明。',
      '只读取对应单个文件，命中表名或示例名需与注册表一致。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '表名或示例名' } },
      required: ['id'],
    },
    output: textOut,
    async execute(args) {
      const id = String(args.id || '').trim()
      if (!id) return { text: 'id 不能为空' }
      const data = await readAll(dataDir)
      const item = data.tables.find((x) => x.meta.name === id) || data.examples.find((x) => x.meta.name === id)
      if (!item) return { text: `未找到「${id}」。请先 sqlkb_search 确认精确名称（表名或示例名）。` }
      let content = item.body.trim()
      if (content.length > maxGetChars) content = content.slice(0, maxGetChars) + '\n…（内容超长截断）'
      return { text: content }
    },
  })

  ctx.tools.register({
    name: 'sqlkb_validate',
    description: [
      '按编写规范校验 sqlkb 知识目录（表/示例 front-matter 完整性、命名一致性、重复、空正文）。',
      '新增/修改表或示例后调用，确认符合规范（支持持续维护知识库）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {},
    },
    output: textOut,
    async execute() {
      return { text: await validate(dataDir) }
    },
  })
}