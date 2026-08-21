/**
 * dsh-sqlkb — SQL 知识注册表（渐进式披露）插件。
 *
 * 核心编码行为（由代码控制，不依赖模型判断）：
 * 1. 会话每轮 prompt 组装时（system-prompt/assemble 瀑布内）注入一个紧凑「描述层」
 *    section：每表/每示例一行（名称/类型/用途/执行方式/引擎/标签/文件路径），
 *    绝不含字段明细与 SQL 正文。
 * 2. 提供工具：sqlkb_list（按需列出全量紧凑清单）、sqlkb_search（关键词检索描述层，返回紧凑命中行）、
 *    sqlkb_get（按 id 读取单个明细文件返回完整内容）、
 *    sqlkb_validate（按编写规范校验知识目录，支持持续新增/修改表与示例）、
 *    sqlkb_pending（管理进程内存待补池：未命中自动留痕、按会话隔离、不写任何文件）、
 *    sqlkb_create（经用户明确同意后把条目补录为表/示例知识文件并自动校验）。
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

## 目录结构
- tables/<表名>.md      每表一个文件：属性 + 全量字段清单 + 补充
- examples/<示例名>.md  每示例一个文件：用途 + SQL + 说明
- pitfalls/<坑点名>.md  每坑一个文件：坑描述 + 错误/正确做法，按标签归集

## 使用方式（DSH 会话）
- 插件注入精简描述层：声明知识库存在与工具用法（**不铺开全部清单**，开销恒定、不随知识量增长）
- **硬要求**：做任何 SQL 相关工作第一步必须先 sqlkb_list（列全量清单），再看情况用 sqlkb_search（含字段名/字段注释匹配、词元拆分、量词后缀兜底）缩小范围 → sqlkb_get 读单个明细
- **表和示例都要看**：定好目标表后，先用 sqlkb_get 读相关【示例】（口径红线/SQL），再用 sqlkb_get 读【表】字段清单，两者都读完再写 SQL
- sqlkb_search 未命中会**自动附上全量清单**并留痕到待补池，供继续挑选，不要绕过知识库凭印象写 SQL
- **坑点自动暴露**：检索表/示例时，sqlkb_search 会按坑点的 tables/related_examples 标签自动附上相关坑点；执行 SQL 前留意是否有坑

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

## 坑点文件 front-matter
\`\`\`yaml
---
name: <坑点名>          # 如 stat_flag 不匹配导致客流错
type: <坑类型>          # 口径/字段/连接/引擎/性能/权限/其他
tables: <相关表>        # 逗号分隔，必填（检索时据此关联）
related_examples: <相关示例>  # 可选
tags: <检索标签>
severity: <严重度>       # 高/中/低，可选
---
\`\`\`

## 编写规范（sqlkb_validate 会校验）
- 新增表/示例/坑点：按上面模板新建文件即可，描述层下个缓存窗口自动包含，无需改插件
- 口径红线：每个示例「口径」段写明各指标唯一来源表/字段、禁止用什么替代
- 坑点正文：写明坑描述、错误示例、正确做法、来源；tables 必须填（检索依赖它关联）
- 正文细节只进各自文件；描述层只含 front-matter 元数据

## 待补池（未命中自动留痕）
- 检索/读取未命中时自动记入当前会话的进程内存待补池（不写入本目录、不写任何文件，重启即清空）
- 任务收尾时用 sqlkb_pending list 查看，经用户同意后 sqlkb_create 补录为表/示例知识（写入 tables/ 或 examples/）
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

/** 各 kind 的目录子名 + 必填 front-matter 字段。 */
const KIND_SPEC = {
  table: { sub: 'tables', required: ['name', 'type', 'purpose', 'exec', 'engines', 'tags'] },
  example: { sub: 'examples', required: ['name', 'purpose', 'tables', 'tags'] },
  pitfall: { sub: 'pitfalls', required: ['name', 'type', 'tables', 'tags'] },
}

/** 确保知识目录骨架存在；首次使用自动写种子 README（不覆盖已有文件）。 */
async function ensureDir(dataDir) {
  let created = false
  const names = [dataDir, join(dataDir, 'tables'), join(dataDir, 'examples'), join(dataDir, 'pitfalls')]
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
  const out = { tables: [], examples: [], pitfalls: [] }
  for (const sub of ['tables', 'examples', 'pitfalls']) {
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

function pitfallLine(p) {
  const m = p.meta
  return `- ${m.name}｜坑类型:${m.type || ''}｜tables:${listVal(m.tables).join(',')}｜tags:${listVal(m.tags).join(',')}｜severity:${m.severity || '?'}｜file:${p.file}`
}

/** 按坑点的 related_examples / tables 关联坑点：给定当前命中的表名/示例名集合，返回匹配的坑点行。 */
function pitfallsForHits(pitfalls, hitNames) {
  if (!hitNames || !hitNames.size) return []
  const out = []
  for (const p of pitfalls) {
    const relTables = new Set(listVal(p.meta.tables))
    const relExamples = new Set(listVal(p.meta.related_examples))
    const hitArr = [...hitNames]
    if (hitArr.some((n) => relTables.has(n) || relExamples.has(n))) out.push(p)
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
  let text
  if (!data.tables.length && !data.examples.length && !data.pitfalls.length) {
    text = [
      '## SQL 知识注册表（描述层）',
      `> 数据源：${dataDir}。知识库将初次使用时自动创建骨架，当前为空。`,
      '',
      '做 SQL 相关工作（查表结构、写查询、找示例）时：第一步先调用 sqlkb_list 看有哪些可用资源，再决定下一步（表和示例都要看，两者不是二选一）。',
      '- sqlkb_list — 列出全部表/示例/坑点的紧凑清单（硬要求：先调用它）',
      '- sqlkb_search — 按关键词检索表/示例（含业务指标词/字段名/字段注释）',
      '- sqlkb_get — 按表名或示例名读取单个明细文件（字段清单/SQL 正文）',
      '- sqlkb_pending — 管理待补池（未命中自动留痕，收尾时与我确认后补录）',
      '- sqlkb_create — 经我明确同意后新增表/示例知识；也可记录坑点（pitfall）',
    ].join('\n')
    return text
  }
  text = [
    '## SQL 知识注册表（描述层）',
    `> 数据源：${dataDir}。共 ${data.tables.length} 张表、${data.examples.length} 个示例、${data.pitfalls.length} 个坑点。知识库含每张表的字段清单/字段注释与已沉淀的查询示例、踩坑经验。`,
    '> 【硬要求】做任何 SQL 相关工作第一步必须先调用 sqlkb_list 获取全量清单，看清有哪些表/示例/坑点，再决定下一步——不要直接凭印象写 SQL 或直接搜索。',
    '> 【表和示例都要看】定好目标表后，示例与表结构不是二选一：先 sqlkb_get 读相关**示例**（往往沉淀了口径红线/SQL，可复用），再 sqlkb_get 读**表**的字段清单，两者都读完再写 SQL。',
    '> 【坑点自动暴露】执行 SQL 前留意 sqlkb_search/sqlkb_get 结果里是否带「相关坑点」（按表/示例关联），有则先读坑点正文避免重复踩坑。',
    '- 步骤1 sqlkb_list — 必须最先调用：列出全部表/示例/坑点紧凑清单',
    '- 步骤2 sqlkb_search — 用业务指标词/字段名/字段注释缩小范围（含正文字段匹配、自动带相关坑点）',
    '- 步骤3 sqlkb_get — 读取单个明细：先看相关【示例】（口径/SQL），再看【表】（字段清单），读完留意关联坑点',
    '- sqlkb_pending — 待补池：未命中的检索/读取自动留痕（内存、不写文件、重启即清空）',
    '- sqlkb_create — 经用户明确同意后新增表/示例知识（user_approved: true）；也可记录坑点',
    '- sqlkb_update — 经用户明确同意后更新已有表/示例字段/正文；坑点更新可自行修订',
    '创建/更新知识规范：表 front-matter 必填 name/type/purpose/exec/engines/tags（related 可选）＋正文放字段清单；示例必填 name/purpose/tables/tags＋正文放用途/口径/SQL/来源；坑点必填 name/type/tables/tags＋正文放坑描述/错误示例/正确做法。正文字段名要与实际表字段一致、口径写明唯一来源。表/示例写入需 user_approved: true；主动记录踩过的坑（执行出错的教训）用 sqlkb_create(kind=pitfall, tables=相关表) 沉淀，可直接记录。',
  ].join('\n')
  if (text.length > maxSectionChars) text = text.slice(0, maxSectionChars) + '\n…（描述层超限截断）'
  return text
}

// —— 待补池（进程内存，绝不落盘）——
// 未命中的检索/读取自动留痕于此，按会话（agent 对象）隔离。
// 不写任何文件：无残留文件、不会在重启后污染其他会话；随进程退出/会话回收自动清空。
const pendingPools = new WeakMap()
// 会话身份缺失（非标准调用）时的兜底隔离键（仍为进程内内存，不落盘）
const GLOBAL_POOL_KEY = Symbol('sqlkb-global-pending-pool')

function poolFor(agentLike) {
  const key = agentLike && typeof agentLike === 'object' ? agentLike : GLOBAL_POOL_KEY
  let pool = pendingPools.get(key)
  if (!pool) {
    pool = new Map()
    pendingPools.set(key, pool)
  }
  return pool
}

/** 未命中留痕：写入该会话的待补池。keyword+kind 相同则去重（仅刷新时间戳/备注），不重复堆积。 */
function addPending(pool, { keyword, kind = 'unknown', source = 'manual', note = '' }) {
  const kw = String(keyword || '').trim()
  if (!kw) return { ok: false, error: 'keyword 为空' }
  const dedupKey = kw + '\u0000' + kind
  const existing = pool.get(dedupKey)
  const now = Date.now()
  if (existing) {
    existing.ts = now
    if (note) existing.note = note
    return { ok: true, deduped: true, id: existing.id }
  }
  const id = `${pool.size + 1}_${kind}`
  pool.set(dedupKey, { id, keyword: kw, kind, source, note: String(note || ''), ts: now })
  return { ok: true, id }
}

function listPending(pool) {
  return [...pool.values()].sort((a, b) => a.ts - b.ts)
}

function removePending(pool, id) {
  for (const [key, v] of pool) {
    if (v.id === id) {
      pool.delete(key)
      return { ok: true, id }
    }
  }
  return { ok: false, error: `待补条目不存在: ${id}` }
}

/** 按 front-matter 元数据对象序列化为 markdown 文件文本（保留字段顺序：name/purpose 固定在前）。 */
function serializeFM(meta, body) {
  // 逗号分隔的多值字段规范化：逗号后补一个空格，与既有知识库 tags/engines 风格一致
  const norm = (v) => String(v).replace(/\s*,\s*/g, ', ').trim()
  const fields = ['name', 'purpose']
  const lines = ['---']
  for (const f of fields) {
    if (meta[f] !== undefined && meta[f] !== '') lines.push(`${f}: ${norm(meta[f])}`)
  }
  // 其余字段按稳定顺序输出
  const rest = ['type', 'exec', 'engines', 'related', 'tables', 'tags']
  for (const f of rest) {
    if (meta[f] !== undefined && meta[f] !== '') lines.push(`${f}: ${norm(meta[f])}`)
  }
  // 顺序外的未知字段
  for (const k of Object.keys(meta)) {
    if (!fields.includes(k) && !rest.includes(k) && meta[k] !== undefined && meta[k] !== '') {
      lines.push(`${k}: ${String(meta[k]).trim()}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n') + String(body || '').trim() + '\n'
}

/** 读单个表/示例/坑点文件，返回 { meta, body, file }；不存在返回 null。 */
async function readOne(dataDir, kind, name) {
  const spec = KIND_SPEC[kind]
  if (!spec) return null
  const file = join(dataDir, spec.sub, `${name}.md`)
  let text
  try { text = await readFile(file, 'utf8') } catch { return null }
  const { meta, body } = parseFM(text)
  return { meta, body, file: `${spec.sub}/${name}.md` }
}

/** 按编写规范校验知识目录，返回问题清单（支持持续新增/修改表、示例、坑点）。 */
async function validate(dataDir) {
  const issues = []
  const data = await readAll(dataDir)
  const seen = new Set()
  for (const sub of ['tables', 'examples', 'pitfalls']) {
    const isTable = sub === 'tables'
    const spec = KIND_SPEC[isTable ? 'table' : sub === 'examples' ? 'example' : 'pitfall']
    const items = data[sub] || []
    for (const it of items) {
      const nm = it.file.replace(/^.*\//, '').replace(/\.md$/, '')
      if (it.meta.name !== nm) issues.push(`${it.file}: front-matter name「${it.meta.name}」与文件名「${nm}」不一致`)
      if (seen.has(it.meta.name)) issues.push(`${it.file}: name「${it.meta.name}」重复`)
      seen.add(it.meta.name)
      for (const key of spec.required) {
        if (it.meta[key] === undefined || it.meta[key] === '') issues.push(`${it.file}: 缺少必填字段 ${key}`)
      }
      if (sub !== 'tables' && !listVal(it.meta.tables).length) issues.push(`${it.file}: 必须声明相关表 tables`)
      if (isTable && !listVal(it.meta.engines).length) issues.push(`${it.file}: 表必须声明支持引擎 engines`)
      if (!it.body.trim()) issues.push(`${it.file}: 正文为空`)
    }
  }
  let text
  if (!data.tables.length && !data.examples.length && !data.pitfalls.length) {
    text = `知识目录为空：${dataDir}（骨架已自动创建，按目录内 README.md 规范添加表/示例/坑点）`
  } else if (issues.length) {
    text = `校验发现 ${issues.length} 个问题：\n` + issues.map((s) => `- ${s}`).join('\n')
  } else {
    text = `校验通过：${data.tables.length} 张表 + ${data.examples.length} 个示例 + ${data.pitfalls.length} 个坑点，全部符合规范`
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
    name: 'sqlkb_list',
    description: '列出 SQL 知识注册表的全量清单：全部表 + 全部示例 + 全部坑点（名称/类型或用途/执行方式/引擎/标签/文件路径）。【硬要求】做任何 SQL 相关工作，第一步必须先调用本工具获取全量清单，看清有哪些表/示例/坑点后再决定下一步（sqlkb_search 缩小范围 / sqlkb_get 读明细），不要直接凭印象写 SQL 或直接搜索。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['table', 'example', 'pitfall', 'all'], description: '限定范围（默认 all）' },
      },
    },
    output: textOut,
    async execute(args) {
      const data = await readAll(dataDir)
      const lines = []
      const kind = args.kind || 'all'
      if (kind === 'all' || kind === 'table') {
        if (data.tables.length) {
          lines.push(`表（${data.tables.length}）：`)
          for (const t of data.tables) lines.push(tableLine(t))
          lines.push('')
        }
      }
      if (kind === 'all' || kind === 'example') {
        if (data.examples.length) {
          lines.push(`示例（${data.examples.length}）：`)
          for (const e of data.examples) lines.push(exampleLine(e))
          lines.push('')
        }
      }
      if (kind === 'all' || kind === 'pitfall') {
        if (data.pitfalls.length) {
          lines.push(`坑点（${data.pitfalls.length}）：`)
          for (const p of data.pitfalls) lines.push(pitfallLine(p))
        }
      }
      if (!lines.length) return { text: '知识库暂无表/示例/坑点。' }
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'sqlkb_search',
    description: [
      '搜索 SQL 知识注册表：匹配表/示例/坑点的名称、用途、标签、引擎、相关表；表的匹配还包含正文里的字段名与字段注释。',
      '【使用前应先 sqlkb_list 获取全量清单，再用本工具缩小范围】',
      '命中表/示例时会自动附上相关坑点（按坑点的 tables/related_examples 关联）。只返回紧凑描述行，命中后用 sqlkb_get 按 id 取完整明细。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（业务指标词/字段名/字段注释等，如 销售额、客户数、restore_sales_amt、sdt）' },
        kind: { type: 'string', enum: ['table', 'example', 'pitfall', 'all'], description: '限定范围（默认 all）' },
      },
      required: ['query'],
    },
    output: textOut,
    async execute(args, exec) {
      const data = await readAll(dataDir)
      const raw = String(args.query || '').trim()
      if (!raw) return { text: 'query 不能为空' }
      const q = raw.toLowerCase()
      // 拆成词元（按空白分隔），任一词元命中即命中——避免整串匹配漏检（如"销售总额 销售额"）
      const tokens = q.split(/\s+/).filter(Boolean)
      // 常见量词后缀，命中不足时裁剪后再匹配一次（如 销售总额→销售、客户数→客户）
      const QTY_SUFFIX = ['总额', '金额', '总量', '数量', '次数', '个数', '条数', '额度', '金额数']
      // 命中强度：2=强（整串或词元完整命中），1=弱（仅量词裁剪后命中），0=未命中
      const strength = (hay) => {
        const h = String(hay || '').toLowerCase()
        if (h.includes(q)) return 2
        if (tokens.some((t) => t && h.includes(t))) return 2
        let weak = 0
        for (const t of tokens) {
          for (const suf of QTY_SUFFIX) {
            if (t.length > suf.length && t.endsWith(suf)) {
              const stem = t.slice(0, t.length - suf.length)
              if (stem && h.includes(stem)) weak = 1
            }
          }
        }
        return weak
      }
      // 取表/示例的最大命中强度（元数据 + 表正文；示例不搜正文）
      const itemStrength = (item, isTable) => {
        const m = item.meta
        const metaHay = isTable
          ? [m.name, m.type, m.purpose, m.exec, m.related, ...listVal(m.engines), ...listVal(m.tags)].join(' ').toLowerCase()
          : [m.name, m.purpose, ...listVal(m.tables), ...listVal(m.tags)].join(' ').toLowerCase()
        const sMeta = strength(metaHay)
        const sBody = isTable ? strength(String(item.body || '')) : 0
        return Math.max(sMeta, sBody)
      }
      const kind = args.kind || 'all'
      const out = []
      // 收集命中的表名/示例名，用于自动关联坑点
      const hitNames = new Set()
      if (kind === 'all' || kind === 'table') {
        const hits = data.tables
          .map((t) => ({ t, s: itemStrength(t, true) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => (b.s - a.s) || a.t.meta.name.localeCompare(b.t.meta.name))
        if (hits.length) {
          const strong = hits.filter((x) => x.s === 2).length
          out.push(`表（${hits.length} 命中${strong ? `，其中 ${strong} 个强匹配` : ''}）：`)
          for (const { t, s } of hits) { out.push((s === 2 ? '★ ' : '· ') + tableLine(t)); hitNames.add(t.meta.name) }
          out.push('')
        }
      }
      if (kind === 'all' || kind === 'example') {
        const hits = data.examples
          .map((e) => ({ e, s: itemStrength(e, false) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => (b.s - a.s) || a.e.meta.name.localeCompare(b.e.meta.name))
        if (hits.length) {
          out.push(`示例（${hits.length} 命中）：`)
          for (const { e, s } of hits) { out.push((s === 2 ? '★ ' : '· ') + exampleLine(e)); hitNames.add(e.meta.name) }
        }
      }
      if (kind === 'all' || kind === 'pitfall') {
        const hits = data.pitfalls
          .map((p) => ({ p, s: Math.max(strength(pitfallLine(p)), strength(String(p.body || ''))) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => (b.s - a.s) || a.p.meta.name.localeCompare(b.p.meta.name))
        if (hits.length) {
          out.push(`坑点（${hits.length} 命中）：`)
          for (const { p, s } of hits) out.push((s === 2 ? '★ ' : '· ') + pitfallLine(p))
        }
      }
      // 方式1：命中表/示例后，自动附上相关坑点
      if (hitNames.size) {
        const rel = pitfallsForHits(data.pitfalls, hitNames)
        if (rel.length) {
          out.push('', `相关坑点（${rel.length}，执行前必读）：`)
          for (const p of rel) out.push('- ' + pitfallLine(p))
        }
      }
      if (!out.length) {
        // 未命中：自动留痕（内存待补池）+ 自动附上全量清单，让 agent 一步到位看到有哪些表/示例/坑点
        addPending(poolFor(exec?.agent), {
          keyword: raw,
          kind: kind === 'example' ? 'example' : kind === 'table' ? 'table' : 'unknown',
          source: 'search',
        })
        const lines = [`未命中「${raw}」。以下自动附上本知识库全量清单，请从中找出最可能相关的表/示例/坑点，再 sqlkb_get 读取明细确认，不要绕过知识库直接凭印象写 SQL。`]
        if (data.tables.length) {
          lines.push('', `表（${data.tables.length}）：`)
          for (const t of data.tables) lines.push(tableLine(t))
        }
        if (data.examples.length) {
          lines.push('', `示例（${data.examples.length}）：`)
          for (const e of data.examples) lines.push(exampleLine(e))
        }
        if (data.pitfalls.length) {
          lines.push('', `坑点（${data.pitfalls.length}）：`)
          for (const p of data.pitfalls) lines.push(pitfallLine(p))
        }
        return { text: lines.join('\n') }
      }
      return { text: out.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'sqlkb_get',
    description: [
      '读取注册表中单个条目的完整明细：',
      '- 表名（如 dm.dm_sale_setl_dly_sum_1d）→ 返回该表完整字段清单、属性、补充说明；',
      '- 示例名（如 销售多维度汇总查询）→ 返回完整 SQL 与说明。',
      '- 坑点名 → 返回坑描述、错误/正确做法。',
      '读表/示例时会自动附带关联坑点（按 tables/related_examples 匹配）。只读取对应单个文件，命中名称需与注册表一致。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '表名或示例名或坑点名' } },
      required: ['id'],
    },
    output: textOut,
    async execute(args, exec) {
      const id = String(args.id || '').trim()
      if (!id) return { text: 'id 不能为空' }
      const data = await readAll(dataDir)
      const item = data.tables.find((x) => x.meta.name === id) || data.examples.find((x) => x.meta.name === id) || data.pitfalls.find((x) => x.meta.name === id)
      if (!item) {
        // 未找到自动留痕（内存待补池，按会话隔离；不写任何文件）
        addPending(poolFor(exec?.agent), { keyword: id, kind: 'unknown', source: 'get' })
        return { text: `未找到「${id}」。已自动留痕到本会话待补池（sqlkb_pending list 查看），确认后可用 sqlkb_create 补录。` }
      }
      // 若读的是表/示例，自动附带相关坑点（方式1：检索即暴露坑点）
      const isPitfall = data.pitfalls.some((x) => x.meta.name === id)
      let content = item.body.trim()
      const relevant = isPitfall ? [] : pitfallsForHits(data.pitfalls, new Set([id]))
      if (relevant.length) {
        content += '\n\n## 关联坑点（执行前必读）\n' + relevant.map((p) => `- ${pitfallLine(p)}\n  ${String(p.body || '').split('\n')[0] || '(见坑点明细)'}`).join('\n')
      }
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

  ctx.tools.register({
    name: 'sqlkb_pending',
    description: [
      '管理「待补池」（未命中自动留痕的条目队列）。',
      'action=list（默认）列出全部待补条目；action=add 手动记录一条；action=remove 删除指定条目。',
      '补录流程：向用户展示待补条目，征得同意后调用 sqlkb_create（user_approved: true）写入表/示例知识，成功后自动删除对应待补条目。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: '操作（默认 list）' },
        keyword: { type: 'string', description: 'action=add 时的关键词/表名/示例名' },
        kind: { type: 'string', enum: ['table', 'example', 'unknown'], description: 'action=add 时预期类型（默认 unknown）' },
        note: { type: 'string', description: 'action=add 时的备注/上下文' },
        id: { type: 'string', description: 'action=remove 时条目 id（list 返回的 id），如 20260728-000000-table-sale_fact' },
      },
    },
    output: textOut,
    async execute(args, exec) {
      const action = args.action || 'list'
      const pool = poolFor(exec?.agent)
      if (action === 'add') {
        const res = addPending(pool, {
          keyword: args.keyword,
          kind: args.kind || 'unknown',
          source: 'manual',
          note: args.note || '',
        })
        if (!res.ok) return { text: res.error }
        return { text: res.deduped ? `待补池已存在相同条目（keyword+kind 相同），已刷新时间戳：${res.id}` : `已记入待补池：${res.id}` }
      }
      if (action === 'remove') {
        const res = removePending(pool, args.id)
        return { text: res.ok ? `已删除待补条目：${args.id}` : res.error }
      }
      const pending = listPending(pool)
      if (pending.length === 0) {
        return { text: '待补池为空。sqlkb_search/sqlkb_get 未命中时会自动留痕（内存、按会话隔离、不写文件）；也可用 action=add 手动记录。' }
      }
      const lines = [`待补池（本会话 ${pending.length} 条，进程内存、重启即清空）：`, '']
      for (const p of pending) {
        const note = p.note ? `｜备注:${String(p.note).replace(/\s+/g, ' ').slice(0, 120)}` : ''
        lines.push(`- ${p.id}｜${p.kind}｜${p.keyword}｜${new Date(p.ts).toISOString()}｜source:${p.source}${note}`)
      }
      lines.push('', '提示：向用户确认后，用 sqlkb_create（user_approved: true）补录为表/示例知识；不需要的用 action=remove 清理。')
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'sqlkb_create',
    description: [
      '新增知识：表/示例/坑点文件（tables/ examples/ pitfalls/），并自动校验规范。',
      '表：kind=table，必填 name/type/purpose/exec/engines/tags（related 可选），正文放字段清单。',
      '示例：kind=example，必填 name/purpose/tables/tags，正文放用途/SQL/口径/说明。',
      '坑点：kind=pitfall，必填 name/type/tables/tags，正文放坑描述/错误示例/正确做法；记录踩坑经验时用，可不经用户同意（纯追加经验）。',
      '表/示例创建【必须经用户同意】：需 user_approved: true，否则拒绝执行。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['table', 'example', 'pitfall'] },
        name: { type: 'string', description: '表名/示例名/坑点名（与文件名一致）' },
        purpose: { type: 'string', description: '一句话用途（坑点可不填）' },
        type: { type: 'string', description: 'table=事实表/维表等；pitfall=坑类型（口径/字段/连接/引擎/性能/权限/其他）' },
        exec: { type: 'string', description: 'kind=table：执行方式（如 skill:yh-bigdata）' },
        engines: { type: 'string', description: 'kind=table：支持引擎，逗号分隔' },
        tags: { type: 'string', description: '检索标签，逗号分隔' },
        related: { type: 'string', description: 'kind=table：同构/关联表' },
        tables: { type: 'string', description: 'example=用到的表；pitfall=相关表，逗号分隔（检索关联依赖）' },
        related_examples: { type: 'string', description: 'kind=pitfall 可选：相关示例名，逗号分隔' },
        severity: { type: 'string', description: 'kind=pitfall 可选：高/中/低' },
        body: { type: 'string', description: '文件正文（表=字段清单；示例=SQL/口径/说明；坑点=坑描述/错误示例/正确做法）' },
        from_pending: { type: 'string', description: '可选：待补条目 id，成功后自动删除' },
        user_approved: { type: 'boolean', description: '表/示例必填 true；坑点可省略' },
      },
      required: ['kind', 'name'],
    },
    output: textOut,
    async execute(args, exec) {
      const kind = args.kind
      const spec = KIND_SPEC[kind]
      if (!spec) return { text: `未知 kind：${kind}` }
      const isPitfall = kind === 'pitfall'
      // 表/示例需用户同意；坑点允许自行记录
      if (!isPitfall && args.user_approved !== true) {
        return { text: '拒绝执行：创建表/示例前必须先向用户展示拟新增内容并获得明确同意，同意后以 user_approved: true 重新调用。' }
      }
      const name = String(args.name || '').trim()
      if (!/^[\w\u4e00-\u9fa5.\- ]+$/.test(name)) {
        return { text: `名称「${name}」含非法字符（仅允许中文/字母/数字/空格/._-）。` }
      }
      const meta = { name }
      // 通用字段
      for (const k of ['purpose', 'type', 'exec', 'engines', 'tables', 'tags', 'related', 'related_examples', 'severity']) {
        if (args[k] !== undefined && String(args[k]).trim() !== '') meta[k] = String(args[k]).trim()
      }
      const missing = spec.required.filter((k) => k === 'name' ? false : !meta[k] || meta[k] === '')
      if (missing.length) return { text: `kind=${kind} 缺少必填字段：${missing.join(', ')}` }
      const body = String(args.body || '').trim() || '（待补充正文）'
      const file = join(dataDir, spec.sub, `${name}.md`)
      await writeFile(file, serializeFM(meta, body), 'utf8')
      const check = await validate(dataDir)
      let removed = ''
      if (args.from_pending) {
        const r = removePending(poolFor(exec?.agent), args.from_pending)
        if (r.ok) removed = `\n已从本会话待补池删除：${args.from_pending}`
      }
      return { text: `已写入 ${file}${removed}\n\n${check}` }
    },
  })

  ctx.tools.register({
    name: 'sqlkb_update',
    description: [
      '更新知识目录中已有表/示例/坑点文件的字段或正文，并自动校验规范。',
      '表/示例更新【必须经用户同意】：需 user_approved: true，否则拒绝执行；坑点更新可省略 user_approved（纯经验修订）。',
      '参数：kind(table/example/pitfall)、name（待更新条目精确名称）；purpose/type/exec/engines/tags/related/tables/related_examples/severity 只传要改的字段（省略则保持原值）；body 为要替换的正文（省略则保留原正文）。',
      '条目不存在时请改用 sqlkb_create 新增。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['table', 'example', 'pitfall'] },
        name: { type: 'string', description: '待更新条目的精确名称（与文件名一致）' },
        purpose: { type: 'string', description: '一句话用途' },
        type: { type: 'string', description: 'table=事实表/维表等；pitfall=坑类型' },
        exec: { type: 'string', description: 'kind=table：执行方式（如 skill:yh-bigdata）' },
        engines: { type: 'string', description: 'kind=table：支持引擎，逗号分隔' },
        tags: { type: 'string', description: '检索标签，逗号分隔' },
        related: { type: 'string', description: 'kind=table：同构/关联表' },
        tables: { type: 'string', description: 'example=用到的表；pitfall=相关表，逗号分隔' },
        related_examples: { type: 'string', description: 'kind=pitfall：相关示例名，逗号分隔' },
        severity: { type: 'string', description: 'kind=pitfall：高/中/低' },
        body: { type: 'string', description: '替换正文' },
        user_approved: { type: 'boolean', description: '表/示例必填 true；坑点可省略' },
      },
      required: ['kind', 'name'],
    },
    output: textOut,
    async execute(args) {
      const kind = args.kind
      const spec = KIND_SPEC[kind]
      if (!spec) return { text: `未知 kind：${kind}` }
      const isPitfall = kind === 'pitfall'
      // 表/示例需用户同意；坑点允许自行修订
      if (!isPitfall && args.user_approved !== true) {
        return { text: '拒绝执行：更新表/示例前必须先向用户展示拟改动内容并获得明确同意，同意后以 user_approved: true 重新调用。' }
      }
      const name = String(args.name || '').trim()
      if (!name) return { text: 'name 不能为空' }
      const existing = await readOne(dataDir, kind, name)
      if (!existing) {
        return { text: `未找到「${name}」，无法更新。请用 sqlkb_create 新增。` }
      }
      // 合并：传入字段覆盖原值，省略则保留原值；body 单独处理（有则替换）
      const meta = { ...existing.meta }
      for (const key of ['purpose', 'type', 'exec', 'engines', 'related', 'tables', 'tags', 'related_examples', 'severity']) {
        if (args[key] !== undefined) {
          const v = String(args[key]).trim()
          if (v === '') delete meta[key]
          else meta[key] = v
        }
      }
      const nameVal = meta.name || name
      // 校验当前字段是否满足必填（防止更新后缺字段）
      const required = spec.required
      const missing = required.filter((k) => !meta[k] || meta[k] === '')
      if (missing.length) return { text: `更新后缺少必填字段：${missing.join(', ')}。请一并提供或勿删减这些字段。` }
      const body = args.body !== undefined ? String(args.body).trim() : existing.body
      const file = join(dataDir, spec.sub, `${nameVal}.md`)
      await writeFile(file, serializeFM(meta, body), 'utf8')
      const check = await validate(dataDir)
      return { text: `已更新 ${existing.file}\n\n${check}` }
    },
  })
}