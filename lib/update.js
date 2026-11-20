/**
 * dsh-getnote — 应用内升级
 *
 * 这个插件**没有任何依赖、没有构建步骤**，发布物就是这批 .js 文件本身，
 * 所以「下载新版本 → 覆盖文件 → 重启 DSH」是一条可行且短的路。这里按这个
 * 思路实现，不做 npm 拉包（那要联 registry、要 pnpm 同意、要处理 lockfile）。
 *
 * 三条刻意的安全约束：
 *   1. **链接安装与 git 检出一律拒绝**。开发者会用 `link:` 把 profile 里的包指向
 *      自己的工作目录，这时候「覆盖文件」等于把人家没提交的改动冲掉——这种事不能
 *      靠提示语提醒，得直接拒绝。判据有两条（见 isLinkedInstall）：目录是符号链接，
 *      或目录里有 `.git`。后一条是必需的：Node 的 ESM 解析会先 resolve 符号链接，
 *      从 profile 加载时拿到的 import.meta.url 已经是真实路径，光比 realpath 判不出来。
 *   2. 旧版本先整体备份到 $DSH_HOME 下，升级失败至少能人工拷回去。
 *   3. 只写 tarball 里真实存在的文件，**不删**旧目录里的其他文件。少一个旧文件
 *      最多是垃圾，删错一个文件插件就起不来了。
 */
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, posix, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { homedir } from 'node:os'

/** 发布源索引。format-1，含最新 commit 与 tarball 地址。 */
export const INDEX_URL = 'https://magicbaobaoli.github.io/dsh-getnote/index.json'

/** 我们自己这个包的根目录（lib/update.js 的上一级）。 */
const HERE = dirname(dirname(fileURLToPath(import.meta.url)))

/** 下载上限。整个插件打包也就几百 KB，留 4MB 已经很宽松。 */
const MAX_TARBALL = 4 * 1024 * 1024

/** 备份放在 DSH 配置目录下，跟库目录分开，免得把备份混进用户的笔记里。 */
function backupRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-getnote', 'update-backup')
}

export async function readOwnPackage() {
  const raw = await readFile(join(HERE, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw)
  return { name: pkg.name || 'dsh-getnote', version: String(pkg.version || '0.0.0'), root: HERE }
}

/** 判断安装是不是符号链接。是的话拒绝升级（见文件头第 1 条）。 */
async function isLinkedInstall(root) {
  try {
    const real = await realpath(root)
    // Windows 上路径大小写不敏感，比较前统一小写。
    if (real.replace(/\\/g, '/').toLowerCase() !== root.replace(/\\/g, '/').toLowerCase()) return true
    // 第二条判据：目录里有 .git，说明这是一份工作目录而不是装好的包。
    // Node 的 ESM 解析会先 resolve 符号链接，所以「从 profile 的 node_modules 加载」
    // 时 import.meta.url 拿到的已经是真实路径，上面那条永远相等、判不出来；
    // 而「带 .git」精确描述了要防的东西——一份能被你自己的提交覆盖、
    // 但不该被下载包覆盖的目录。发布包（codeload 的 tar.gz）里从来不含 .git。
    const gitEntry = await stat(join(real, '.git')).catch(() => null)
    return gitEntry !== null
  } catch {
    return false
  }
}

/**
 * 版本比较。只比数字段，不认 `-rc.1` 这类预发布标签之后的差值——
 * 这个插件的版本一直是干净的 x.y.z，加复杂规则反而容易比错。
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => {
        const n = parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })
  const left = parse(a)
  const right = parse(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const l = left[i] || 0
    const r = right[i] || 0
    if (l > r) return 1
    if (l < r) return -1
  }
  return 0
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' })
  if (!res.ok) throw Object.assign(new Error(`发布源返回 HTTP ${res.status}`), { status: 502 })
  return res.text()
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw Object.assign(new Error(`下载返回 HTTP ${res.status}`), { status: 502 })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_TARBALL) throw Object.assign(new Error('下载包超过大小上限'), { status: 502 })
  return buf
}

/**
 * 读发布源，判断有没有新版。
 *
 * 索引有两种可能形状：单插件索引（我们自己的 index.json，`plugins[0].version`
 * 与 `commit`）和更早的顶层 `version`。两种都认，免得换了格式这个功能就废了。
 */
export async function checkForUpdate(indexUrl = INDEX_URL) {
  const own = await readOwnPackage()
  let parsed
  try {
    parsed = JSON.parse(await fetchText(indexUrl))
  } catch (err) {
    // 断网/被墙是常见情况，不能报成「升级失败」，那样用户会以为插件坏了。
    const offline = Object.assign(new Error('连不上发布源'), { status: 503, offline: true })
    offline.cause = err
    throw offline
  }

  const plugin = Array.isArray(parsed.plugins) && parsed.plugins.length > 0 ? parsed.plugins[0] : parsed

  // 索引有三种可能形状，全都要认：
  //   1. 我们自己 build-index.mjs 生成的：plugins[0].versions[]，每条带
  //      {version, source:{type:'git', url, commit}}；
  //   2. 老的扁平写法：plugins[0].version + plugins[0].commit；
  //   3. 更早的顶层 version。
  // 只认一种的后果是「索引能装、升级却说没版本号」，而且看起来像插件坏了。
  const versions = Array.isArray(plugin.versions) ? plugin.versions : []
  const newest = versions
    .filter((v) => v !== null && typeof v === 'object' && String(v.version || '').trim() !== '')
    // 按版本号排序而不是按数组顺序：发布顺序和语义版本不一定同步。
    .reduce((best, item) => (best === null || compareVersions(String(item.version), String(best.version)) > 0 ? item : best), null)

  const latest = String(
    newest !== null ? newest.version : plugin.version !== undefined ? plugin.version : parsed.version !== undefined ? parsed.version : '',
  ).trim()
  if (latest === '') throw Object.assign(new Error('发布源里没有版本号'), { status: 502 })

  const source = newest !== null && newest.source !== null && typeof newest.source === 'object' ? newest.source : null
  const commit = String(
    source !== null && source.commit !== undefined
      ? source.commit
      : plugin.commit !== undefined
        ? plugin.commit
        : parsed.commit !== undefined
          ? parsed.commit
          : '',
  ).trim()
  // repository 在索引里可能是字符串，也可能是 { url } 对象。直接 String() 对象会得到
  // 字面量 "[object Object]"，之前界面上就这么显示过。取 url 再兜底。
  const repoUrl = (value) => {
    if (typeof value === 'string') return value.trim()
    if (value !== null && typeof value === 'object' && typeof value.url === 'string') return value.url.trim()
    return ''
  }
  const repo =
    repoUrl(parsed.repository) ||
    repoUrl(plugin.repository) ||
    repoUrl(source !== null ? source.url : null) ||
    'https://github.com/magicbaobaoli/dsh-getnote'

  // codeload 的地址要用 "owner/repo"，从仓库地址里抠出来而不是写死自己的名字：
  // 这个函数本来就接受自定义 indexUrl，写死会让 fork 之后升级指向原作者仓库。
  const slug = (() => {
    const match = /github\.com[/:]+([^/]+)\/([^/#?]+)/.exec(repo)
    if (match === null) return 'magicbaobaoli/dsh-getnote'
    return `${match[1]}/${match[2].replace(/\.git$/, '')}`
  })()

  // 用 codeload 的 commit 归档而不是 release 资产：索引里一定有 commit，
  // 而 release 资产的 URL 万一改了名，这里的升级就整条断掉。
  const tarball = commit !== '' ? `https://codeload.github.com/${slug}/tar.gz/${commit}` : ''
  return {
    current: own.version,
    latest,
    commit,
    repo,
    tarball,
    available: compareVersions(latest, own.version) > 0,
  }
}
/**
 * 解析 tar（ustar）。只认普通文件与目录，其他类型（符号链接/硬链接）一律跳过——
 * 我们不希望一个下载下来的包在插件目录里放出一个指向别处的链接。
 */
export function extractTar(buffer) {
  const files = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    // 全零块 = 归档结束
    if (header.every((byte) => byte === 0)) break
    const readString = (start, length) => {
      const slice = header.subarray(start, start + length)
      const end = slice.indexOf(0)
      return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
    }
    const name = readString(0, 100)
    const sizeText = readString(124, 12).trim()
    const size = sizeText === '' ? 0 : parseInt(sizeText, 8)
    const typeflag = String.fromCharCode(header[156] || 48)
    const prefix = readString(345, 155)
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const dataStart = offset + 512
    const dataEnd = dataStart + (Number.isFinite(size) ? size : 0)
    if (dataEnd > buffer.length) break
    if (fullName !== '') {
      files.push({ name: fullName, size, type: typeflag, data: buffer.subarray(dataStart, dataEnd) })
    }
    // 每个条目按 512 对齐，末尾两个空块不参与计算
    offset = dataStart + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512
  }
  return files
}

/**
 * 下载并原地升级。
 *
 * 流程：检查 → 拒绝符号链接安装 → 备份当前目录 → 解包写到临时目录 →
 * 逐个覆盖 → 回报「需要重启」。任何一步抛错都不会留下半个新版本在跑，
 * 因为真正的覆盖发生在最后一步，且每写一个文件前先确认它的路径落在包目录内。
 */
export async function applyUpdate(indexUrl = INDEX_URL) {
  const own = await readOwnPackage()

  if (await isLinkedInstall(own.root)) {
    throw Object.assign(
      new Error('这个插件是从工作目录加载的（链接安装或 git 检出），就地覆盖会冲掉你没提交的改动，已拒绝。请改用常规安装，或在工作目录里自己 pull。'),
      { status: 409 },
    )
  }

  const info = await checkForUpdate(indexUrl)
  if (!info.available) {
    return { ok: true, changed: false, current: own.version, latest: info.latest, restartRequired: false }
  }
  if (info.tarball === '') throw Object.assign(new Error('发布源里没有 commit，无法下载'), { status: 502 })

  const raw = await fetchBuffer(info.tarball)
  let files
  try {
    files = extractTar(gunzipSync(raw))
  } catch (err) {
    throw Object.assign(new Error(`下载包解压失败：${err && err.message ? err.message : String(err)}`), { status: 502 })
  }

  // 归档里通常带一层 `<repo>-<sha>/` 前缀，剥掉它才能对上包内路径。
  const firstDir = files.length > 0 ? files[0].name.split('/')[0] : ''
  const stripPrefix = firstDir !== '' && files.every((f) => f.name.startsWith(`${firstDir}/`)) ? `${firstDir}/` : ''

  const usable = files
    .filter((f) => f.type === '0' || f.type === '')
    .map((f) => ({ rel: f.name.slice(stripPrefix.length), data: f.data }))
    // 只写发布包该有的东西：不许越出包目录，也不动 node_modules 之类的残留
    .filter((f) => f.rel !== '' && !f.rel.startsWith('/') && !f.rel.includes('..') && !f.rel.includes('node_modules/'))
    // 校验门槛：一个真正的发布包里必须有 package.json 与 lib/index.js。
    // 少了任何一个都说明下载到的是错误页面（GitHub 出错时返回的 HTML），
    // 这种情况下继续写会把插件覆盖成废的。
  if (!usable.some((f) => f.rel === 'package.json') || !usable.some((f) => f.rel === 'lib/index.js' || f.rel === 'lib\\index.js')) {
    throw Object.assign(new Error('下载包内容不完整（缺 package.json 或 lib/index.js），已中止'), { status: 502 })
  }

  // 备份：把当前包目录整棵复制到 $DSH_HOME/dsh-getnote/update-backup/<版本>-<时间戳>/
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(backupRoot(), `${own.version}-${stamp}`)
  await mkdir(backupDir, { recursive: true })
  let backedUp = 0
  const walk = async (dir, relBase) => {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const rel = relBase === '' ? item.name : `${relBase}/${item.name}`
      if (item.isDirectory()) {
        await walk(join(dir, item.name), rel)
        continue
      }
      if (!item.isFile()) continue
      const dest = join(backupDir, rel.split('/').join(sep))
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(join(dir, item.name), dest)
      backedUp += 1
    }
  }
  try {
    await walk(own.root, '')
  } catch (err) {
    throw Object.assign(new Error(`备份当前版本失败，已中止升级：${err && err.message ? err.message : String(err)}`), { status: 500 })
  }

  // 逐个覆盖。写之前再确认一次目标路径落在包目录内。
  const rootPrefix = own.root.replace(/\\/g, '/').toLowerCase()
  let written = 0
  for (const file of usable) {
    const rel = posix.normalize(file.rel)
    const dest = join(own.root, rel.split('/').join(sep))
    const destNorm = dest.replace(/\\/g, '/').toLowerCase()
    if (!destNorm.startsWith(rootPrefix)) continue
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.data)
    written += 1
  }

  const after = await readOwnPackage()
  return {
    ok: true,
    changed: true,
    from: own.version,
    to: after.version,
    files: written,
    backedUp,
    backupPath: backupDir,
    restartRequired: true,
  }
}
