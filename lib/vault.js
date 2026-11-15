/**
 * dsh-getnote — 本地笔记库（host 侧文件层）
 *
 * 这是插件的**本体**：一个普通目录里的普通 Markdown 文件。没有数据库、没有索引
 * 缓存文件、没有私有格式。用户可以随时用 Obsidian / VS Code / 记事本打开、
 * 编辑、移动、删除这些文件，本插件下次扫描就会看到——插件不拥有数据，只读它。
 *
 * 所有对外路径都用 POSIX 分隔符（`a/b/c.md`）的**相对库根**形式，跨平台一致；
 * 落地读写前统一过 resolveInside() 做包含性校验，防止 `../` 逃逸出库根。
 */
import { readdir, readFile, writeFile, rename, mkdir, stat, rm, realpath, copyFile } from 'node:fs/promises'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'

const NOTE_EXT = '.md'
const MAX_READ = 2 * 1024 * 1024        // 单篇读取上限 2MB
const MAX_WRITE = 2 * 1024 * 1024       // 单篇写入上限 2MB
const MAX_SCAN = 8000                   // 扫描文件数上限（防病态目录）
const MAX_DEPTH = 8
// 扫描时一律跳过的目录。
// `.conflicts` 是本插件自己的冲突留档：里面的文件带着**同一份 note_id**（是从云端
// 版本复制出来的），如果参与扫描，buildIndex 建的 note_id → 路径 索引就可能指向
// 冲突副本，于是下一轮同步会把云端正文写进留档文件、而不是写进正本。这里排除掉，
// 顺带也让面板的目录树和笔记列表不再把「.conflicts」当成一个正常目录显示。
// `asset` 是笔记的附件目录（录音 mp3、转写 md、图片）。它里面的 `_transcript.md`
// 看起来也是一篇 markdown，于是会被当成独立笔记混进列表——用户点「收到录音卡的
// 首次录音感言」，打开的是那份转写而不是笔记本身，非常迷惑。附件由 listAssets
// 单独读取（它直接读目录，不经过这里），所以排除掉不影响播放。
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.obsidian', '.trash', '.conflicts', '.dsh', '$RECYCLE.BIN', '__MACOSX',
  '.DS_Store', '.venv', 'asset',
])

/** 相对路径转 POSIX 形式（Windows 上反斜杠统一成 /）。 */
export function toPosix(p) {
  return p.split(sep).join('/')
}

/** 库内相对路径钳制：拒绝绝对路径与 `..` 逃逸，返回归一化后的 POSIX 相对路径。 */
export function normalizeRel(input) {
  if (typeof input !== 'string') return ''
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '')
  const normalized = posix.normalize(raw)
  if (normalized === '.' || normalized === './') return ''
  if (normalized.startsWith('../') || normalized === '..') {
    throw Object.assign(new Error('path escapes vault root'), { status: 400 })
  }
  return normalized
}

/**
 * 把库内相对路径解析成绝对路径，并确认结果仍在库根内。
 * 注意：库根本身必须已经 realpath 过（调用方保证），否则符号链接会绕出去。
 */
export function resolveInside(root, rel, { create = false } = {}) {
  const normalized = normalizeRel(rel)
  const abs = normalized === '' ? resolve(root) : resolve(root, normalized.split('/').join(sep))
  const relCheck = relative(resolve(root), abs)
  if (relCheck.startsWith('..') || (relCheck !== '' && resolve(root, relCheck) !== abs)) {
    throw Object.assign(new Error('path escapes vault root'), { status: 400 })
  }
  return { abs, rel: normalized, create }
}

// ── frontmatter ──────────────────────────────────────────────────────────────

/**
 * 解析 YAML frontmatter 的**有限子集**（本项目归档文件里实际用到的写法）：
 * `key: value`、`key: [a, b]`、缩进续行、引号包裹的字符串。
 *
 * 刻意不引第三方 YAML 库：只要认识自己写出去的那几种形状，外加容忍用户手改，
 * 解析失败就当作没有 frontmatter——正文永远优先，绝不因为头部格式问题拒绝打开。
 */
export function parseFrontmatter(text) {
  const src = typeof text === 'string' ? text : ''
  if (!src.startsWith('---')) return { data: {}, body: src, raw: null }
  const lines = src.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return { data: {}, body: src, raw: null }
  const raw = lines.slice(1, end).join('\n')
  const data = {}
  let lastKey = null
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indented = /^\s+\S/.test(line)
    if (indented && lastKey) {
      // 列表续行：`- item` 或纯文本续行
      const item = line.trim().replace(/^-\s*/, '')
      data[lastKey] = Array.isArray(data[lastKey]) ? [...data[lastKey], unquote(item)] : [data[lastKey], unquote(item)]
      continue
    }
    const m = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    lastKey = m[1]
    const value = m[2].trim()
    if (value === '') {
      data[lastKey] = []
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[lastKey] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== '')
      continue
    }
    data[lastKey] = unquote(value)
  }
  return { data, body: lines.slice(end + 1).join('\n'), raw }
}

function unquote(s) {
  const t = String(s).trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** 正文里第一个 `# 标题`，或文件名（去掉日期前缀与扩展名）。 */
export function deriveTitle(body, relPath) {
  const m = /^#{1,3}\s+(.+)$/m.exec(body || '')
  if (m) return m[1].trim()
  const base = posix.basename(relPath || '', NOTE_EXT)
  const stripped = base.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  return stripped || base || '未命名'
}

/** 从文件名/正文推出一个日期（用于排序与分组，取不到就 null）。 */
export function deriveDate(relPath, data, statMs) {
  const base = posix.basename(relPath || '', NOTE_EXT)
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(base)
  if (m) return m[1]
  for (const key of ['归档', '日期', 'date', 'created', '创建时间']) {
    const v = data && data[key]
    const s = Array.isArray(v) ? v[0] : v
    const dm = typeof s === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(s.trim()) : null
    if (dm) return dm[1]
  }
  if (statMs) {
    const d = new Date(statMs)
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
  }
  return null
}

/** 正文摘录：压掉空行与 Markdown 噪声，取前面一段做列表副标题。 */
export function excerptOf(body, limit = 140) {
  const text = String(body || '')
    .replace(/^---[\s\S]*?\n---\s*\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text
}

// ── 扫描 ─────────────────────────────────────────────────────────────────────

/**
 * 扫描整库，返回扁平条目数组。
 *
 * 一次性读每个文件的头部（frontmatter + 前 2400 字符）来算标题/标签/日期/摘录，
 * 不建任何持久索引：笔记数量在几千级以内时够快，而且永远不会出现「索引和文件
 * 不一致」这种最让人焦虑的问题——文件就是唯一真相。
 */
export async function scanVault(root) {
  const entries = []
  const errors = []
  let truncated = false

  async function walk(dir, relDir, depth) {
    if (depth > MAX_DEPTH || truncated) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      errors.push({ path: relDir || '.', message: String(error && error.message ? error.message : error) })
      return
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_SCAN) {
        truncated = true
        return
      }
      const name = dirent.name
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue
        await walk(join(dir, name), relDir === '' ? name : `${relDir}/${name}`, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      if (extname(name).toLowerCase() !== NOTE_EXT) continue
      const rel = relDir === '' ? name : `${relDir}/${name}`
      const abs = join(dir, name)
      try {
        const st = await stat(abs)
        if (st.size > MAX_READ) {
          errors.push({ path: rel, message: `文件超过 ${Math.round(MAX_READ / 1024 / 1024)}MB，已跳过` })
          continue
        }
        const text = await readFile(abs, 'utf8')
        const { data, body } = parseFrontmatter(text)
        entries.push({
          path: rel,
          name,
          dir: relDir,
          title: deriveTitle(body, rel),
          date: deriveDate(rel, data, st.mtimeMs),
          tags: Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [],
          noteId: data.note_id ? String(data.note_id) : null,
          noteUrl: data.note_url ? String(data.note_url) : null,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          excerpt: excerptOf(body),
        })
      } catch (error) {
        errors.push({ path: rel, message: String(error && error.message ? error.message : error) })
      }
    }
  }

  await walk(root, '', 0)
  entries.sort((a, b) => {
    const da = a.date || ''
    const db = b.date || ''
    if (da !== db) return db.localeCompare(da)
    return b.mtimeMs - a.mtimeMs
  })
  return { entries, errors, truncated }
}

/** 由扁平条目建目录树（只含真正有笔记的目录，空目录不显示）。 */
export function buildTree(entries) {
  const root = { name: '', path: '', kind: 'dir', children: [], count: 0 }
  const dirMap = new Map([['', root]])
  for (const entry of entries) {
    const segments = entry.path.split('/').slice(0, -1)
    let cursor = root
    let acc = ''
    for (const segment of segments) {
      acc = acc === '' ? segment : `${acc}/${segment}`
      let node = dirMap.get(acc)
      if (!node) {
        node = { name: segment, path: acc, kind: 'dir', children: [], count: 0 }
        dirMap.set(acc, node)
        cursor.children.push(node)
      }
      cursor = node
    }
    cursor.children.push({ name: entry.name, path: entry.path, kind: 'file', entry })
  }
  // 统计每个目录（含子孙）的笔记数，并把目录排前面、同类按名称排
  const countAll = (node) => {
    let n = 0
    for (const child of node.children) {
      if (child.kind === 'file') n += 1
      else n += countAll(child)
    }
    node.count = n
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      if (a.kind === 'dir') return a.name.localeCompare(b.name, 'zh')
      const da = (a.entry && a.entry.date) || ''
      const db = (b.entry && b.entry.date) || ''
      if (da !== db) return db.localeCompare(da)
      return a.name.localeCompare(b.name, 'zh')
    })
    return n
  }
  countAll(root)
  return root
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

export async function readNote(root, rel) {
  const { abs, rel: normalized } = resolveInside(root, rel)
  if (!normalized.toLowerCase().endsWith(NOTE_EXT)) {
    throw Object.assign(new Error('只能读取 .md 文件'), { status: 400 })
  }
  const st = await stat(abs)
  if (!st.isFile()) throw Object.assign(new Error('不是文件'), { status: 400 })
  if (st.size > MAX_READ) throw Object.assign(new Error('文件过大'), { status: 413 })
  const content = await readFile(abs, 'utf8')
  const { data, body } = parseFrontmatter(content)
  return {
    path: normalized,
    content,
    body,
    frontmatter: data,
    title: deriveTitle(body, normalized),
    tags: Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [],
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    readOnly: false,
  }
}

/**
 * 找一篇笔记自己的附件（录音 mp3 / 转写 md / 图片）。
 *
 * 约定是 `<笔记所在目录>/asset/<笔记文件名主干>_<note_id>_audio.mp3` 这种形状——
 * 这是 Obsidian 端插件留下的命名，合并两套体系时原样搬进来的，所以不能改。
 * 除了「主干 + note_id」精确匹配，还认「只带 note_id」的形式，因为 note_id 是唯一键，
 * 用户手动改名后主干会变但 note_id 不变。
 *
 * 找不到就返回空数组：大多数笔记本来就没有附件，这不是错误。
 */
export async function listAssets(root, rel, noteId = '') {
  const { abs, rel: normalized } = resolveInside(root, rel)
  const dir = posix.dirname(normalized)
  const stem = posix.basename(normalized, NOTE_EXT)
  const assetRel = dir === '.' || dir === '' ? 'asset' : `${dir}/asset`
  const assetAbs = resolveInside(root, assetRel).abs
  let names
  try {
    names = await readdir(assetAbs)
  } catch {
    return []
  }
  // 归属判断，三条路任一命中即算这篇的附件：
  //   1. 文件名以笔记主干开头；
  //   2. 以去掉 `YYYY-MM-DD-` 日期前缀的标题开头（本插件写笔记会加日期前缀，
  //      而附件名是 Obsidian 端插件按「标题_note_id_audio.mp3」生成的）；
  //   3. 文件名里含这篇笔记的 note_id —— 标题被用户改过时（实测就有：本地标题
  //      与云端标题并不相同）前两条都对不上，只有 note_id 是稳的。
  const candidates = []
  if (stem !== '') candidates.push(stem)
  const undated = stem.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  if (undated !== '' && undated !== stem) candidates.push(undated)
  const id = String(noteId || '').trim()
  const out = []
  for (const name of names) {
    if (name.endsWith('.bak')) continue
    const lower = name.toLowerCase()
    const isAudio = /\.(mp3|ogg|m4a|wav|aac|flac)$/.test(lower)
    const isTranscript = lower.endsWith('.md')
    const isImage = /\.(png|jpe?g|gif|webp)$/.test(lower)
    if (!isAudio && !isTranscript && !isImage) continue
    const owned = candidates.some((prefix) => name.startsWith(prefix)) || (id !== '' && name.includes(id))
    if (!owned) continue
    const relPath = `${assetRel}/${name}`
    try {
      const st = await stat(resolveInside(root, relPath).abs)
      if (!st.isFile()) continue
      out.push({
        name,
        path: relPath,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        kind: isAudio ? 'audio' : isTranscript ? 'transcript' : 'image',
      })
    } catch {
      // 读到一半被删：跳过
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return out
}

/**
 * 保存笔记：内容整篇覆盖（面板是全量编辑，不走行级 diff）。
 *
 * `options.backup` 默认 true。同步镜像云端内容时要传 false：那时本地文件本来就
 * 没被用户动过（指纹一致），留 .bak 只会让库里堆满看不见的副本；而用户在面板里
 * 手动改完保存时必须留，否则一次误操作就找不回来了。
 */
export async function writeNote(root, rel, content, options = {}) {
  const backup = options.backup !== false
  const { abs, rel: normalized } = resolveInside(root, rel)
  if (!normalized.toLowerCase().endsWith(NOTE_EXT)) {
    throw Object.assign(new Error('只能写入 .md 文件'), { status: 400 })
  }
  if (typeof content !== 'string') throw Object.assign(new Error('content 必须是字符串'), { status: 400 })
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE) {
    throw Object.assign(new Error('内容超过 2MB 上限'), { status: 413 })
  }
  await mkdir(dirname(abs), { recursive: true })
  if (backup) {
    // 原文件存在时保留一份 .bak（一次就够，避免用户误覆盖后无法回退）
    try {
      await copyFile(abs, `${abs}.bak`)
    } catch {
      // 新文件：没有可备份的内容
    }
  }
  const tmp = `${abs}.${process.pid}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, abs)
  const st = await stat(abs)
  return { path: normalized, bytes: st.size, mtimeMs: st.mtimeMs }
}

/** 文件名清洗：去掉 Windows 非法字符、压缩空白、限长；保留中文。 */
export function safeFilename(title, fallback = '未命名') {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
  return cleaned === '' ? fallback : cleaned
}

/**
 * 新建笔记。默认文件名 `YYYY-MM-DD-<标题>.md`，与用户已有归档库的命名约定一致
 * （这样本插件建的笔记和他手写的归档混在同一个目录里也不会显得突兀）。
 */
export async function createNote(root, { dir = '', title = '', content = '', date, withDatePrefix = true } = {}) {
  const safeDir = normalizeRel(dir)
  const pad = (n) => String(n).padStart(2, '0')
  const now = new Date()
  const day = date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const baseName = safeFilename(title)
  const fileName = `${withDatePrefix ? `${day}-` : ''}${baseName}${NOTE_EXT}`
  const rel = safeDir === '' ? fileName : `${safeDir}/${fileName}`

  // 同名冲突：追加 -2 / -3，绝不覆盖用户已有笔记
  let candidate = rel
  let counter = 2
  for (;;) {
    const { abs } = resolveInside(root, candidate)
    try {
      await stat(abs)
      const stem = candidate.slice(0, -NOTE_EXT.length)
      candidate = `${stem}-${counter}${NOTE_EXT}`
      counter += 1
      if (counter > 99) throw Object.assign(new Error('同名笔记过多'), { status: 409 })
    } catch (error) {
      if (error && error.status === 409) throw error
      break
    }
  }

  const body = content !== '' ? content : `# ${baseName}\n\n`
  await writeNote(root, candidate, body)
  return { path: candidate }
}

/** 删除笔记：移进库内 `.trash/`（可恢复），不真删。 */
export async function trashNote(root, rel) {
  const { abs, rel: normalized } = resolveInside(root, rel)
  if (normalized === '') throw Object.assign(new Error('不能删除库根'), { status: 400 })
  const trashDir = join(root, '.trash')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(trashDir, `${stamp}__${basename(abs)}`)
  await mkdir(trashDir, { recursive: true })
  await rename(abs, target)
  return { path: normalized, trashedTo: toPosix(relative(root, target)) }
}

// ── 搜索 ─────────────────────────────────────────────────────────────────────

/**
 * 全库全文搜索（大小写不敏感的子串匹配，逐行给上下文）。
 *
 * 为什么不用正则/分词：这是给自己笔记用的，用户输入的往往就是一个词、一个人名。
 * 把输入当纯文本处理，避免 `(`、`[` 之类符号把搜索搞崩是最重要的。
 */
export async function searchNotes(root, query, { limit = 60, perFile = 3 } = {}) {
  const q = String(query || '').trim()
  if (q === '') return { query: q, hits: [], scanned: 0, truncated: false }
  const needle = q.toLowerCase()
  const hits = []
  let scanned = 0
  let truncated = false

  async function walk(dir, relDir, depth) {
    if (depth > MAX_DEPTH || truncated) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (hits.length >= limit) {
        truncated = true
        return
      }
      const name = dirent.name
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(name) || name === '.trash') continue
        await walk(join(dir, name), relDir === '' ? name : `${relDir}/${name}`, depth + 1)
        continue
      }
      if (!dirent.isFile() || extname(name).toLowerCase() !== NOTE_EXT) continue
      const rel = relDir === '' ? name : `${relDir}/${name}`
      scanned += 1
      let text
      try {
        text = await readFile(join(dir, name), 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      const matches = []
      const titleHit = name.toLowerCase().includes(needle)
      for (let i = 0; i < lines.length && matches.length < perFile; i += 1) {
        const idx = lines[i].toLowerCase().indexOf(needle)
        if (idx < 0) continue
        matches.push({
          line: i + 1,
          text: lines[i].trim().slice(0, 240),
        })
      }
      if (matches.length === 0 && !titleHit) continue
      const { data, body } = parseFrontmatter(text)
      hits.push({
        path: rel,
        title: deriveTitle(body, rel),
        date: deriveDate(rel, data, null),
        matches,
        titleHit,
      })
    }
  }

  await walk(root, '', 0)
  return { query: q, hits, scanned, truncated }
}

/** 库统计：面板顶部显示「几篇笔记 / 几个目录 / 多大」。 */
export async function vaultStats(root, entries) {
  let bytes = 0
  const dirs = new Set()
  for (const entry of entries) {
    bytes += entry.bytes || 0
    const d = posix.dirname(entry.path)
    if (d !== '.' && d !== '') dirs.add(d)
  }
  return { notes: entries.length, dirs: dirs.size, bytes }
}

/** 库内目录列表（用于新建笔记时的目标目录下拉）。 */
export function listDirs(entries) {
  const dirs = new Set([''])
  for (const entry of entries) {
    const segments = entry.path.split('/').slice(0, -1)
    let acc = ''
    for (const segment of segments) {
      acc = acc === '' ? segment : `${acc}/${segment}`
      dirs.add(acc)
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b, 'zh'))
}

export { NOTE_EXT, MAX_READ, MAX_WRITE }
