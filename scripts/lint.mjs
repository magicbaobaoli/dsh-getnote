#!/usr/bin/env node
/**
 * 零依赖的静态检查。
 *
 * 为什么不装 ESLint：这个插件本体是**零依赖零构建**的（装插件不该顺带拉一堆
 * 开发依赖）。但「零依赖」不等于「不检查」——下面这几类问题在历史上都真的
 * 发生过，而且都只有跑起来才发现：
 *
 *   1. 语法错（改补丁时括号少配一个，`node --check` 立刻能抓）
 *   2. lib/client.js 被 `window.__ModuleLoader__.load({factory})` 包着，
 *      直接 `node --check` 会报错，所以必须抽出工厂体单独检查——这条最容易被忘
 *   3. Python 桥脚本语法错（`async` 当变量名那次，`SyntaxError: invalid syntax`）
 *   4. 三本 LEX 字典键不一致（漏一个键，某语言下界面就露出原始 key）
 *   5. 行尾混入 CRLF（会把整份文件的 diff 变成上万行，测试里的 `\n` 正则也全部失效）
 *   6. 行尾空白（看起来没影响，但会让 `git diff` 噪音变大、合并时互相踩）
 *
 * 用法：node scripts/lint.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const problems = []

function fail(file, message) {
  problems.push(`${relative(root, file)}: ${message}`)
}

function listFiles(dir, predicate) {
  const out = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === '__pycache__' || name.startsWith('.')) continue
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (predicate(full)) out.push(full)
    }
  }
  walk(dir)
  return out
}

// ── 1. 所有 lib/*.js 都能被 Node 解析 ──────────────────────────────────────
for (const file of listFiles(join(root, 'lib'), (name) => name.endsWith('.js') && !name.endsWith('client.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) fail(file, `语法错：${(result.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`)
}

// ── 2. client.js：抽出工厂体再检查 ────────────────────────────────────────
{
  const file = join(root, 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf('factory: (require) => {')
  if (start === -1) {
    fail(file, '找不到 factory: (require) => {，检查脚本需要同步更新')
  } else {
    const bodyStart = start + 'factory: (require) => {'.length
    const tail = source.lastIndexOf('return module.exports')
    if (tail === -1 || tail < bodyStart) {
      fail(file, '找不到 return module.exports，检查脚本需要同步更新')
    } else {
      const body = `const __check = (require) => {${source.slice(bodyStart, tail)}}`
      const result = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], {
        input: body,
        encoding: 'utf8',
      })
      // node --check 不支持 stdin + --input-type 的组合时，退回写临时文件
      if (result.status !== 0 && /Cannot use import|ERR_INPUT_TYPE|not supported/i.test(result.stderr || '')) {
        const tmp = join(root, '.lint-client-check.mjs')
        const { writeFileSync, rmSync } = await import('node:fs')
        writeFileSync(tmp, body, 'utf8')
        const retry = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
        rmSync(tmp, { force: true })
        if (retry.status !== 0) fail(file, `语法错：${(retry.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`)
      } else if (result.status !== 0) {
        fail(file, `语法错：${(result.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`)
      }
    }
  }
}

// ── 3. Python 桥脚本语法 ─────────────────────────────────────────────────
const pyFiles = listFiles(join(root, 'lib'), (name) => name.endsWith('.py'))
if (pyFiles.length > 0) {
  const probe = spawnSync('python', ['-c', 'print(1)'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const pyArgs = (file) => [
      '-c',
      'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())',
      file,
    ]
    for (const file of pyFiles) {
      let result = spawnSync('python', pyArgs(file), { encoding: 'utf8' })
      // status === null 表示进程根本没起来（被安全软件拦、句柄耗尽等），
      // 这时 stderr 是空的，不能当成语法错报出去。重试一次，仍失败就如实说。
      if (result.status === null) result = spawnSync('python', pyArgs(file), { encoding: 'utf8' })
      if (result.status === null) {
        fail(file, `python 没能启动，跳过语法检查：${(result.error && result.error.message) || 'unknown'}`)
        continue
      }
      if (result.status !== 0) {
        const detail = (result.stderr || '').trim().split('\n').slice(-3).join(' ')
        fail(file, `Python 语法错：${detail || '（python 没输出错误信息）'}`)
      }
    }
  }
  // 没装 Python 就跳过——这些脚本本来就是可选功能，不能因此让 lint 失败
}

// ── 4. 三本 LEX 字典键必须一致 ───────────────────────────────────────────
// 结构是单个 const LEX = { zh: {...}, en: {...}, nl: {...} }。
// 漏一个键的后果是：切到那个语言后界面直接露出原始 key（比如 settings.templateAdd）。
{
  const file = join(root, 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  const lexAt = source.indexOf('const LEX = {')
  if (lexAt === -1) {
    fail(file, '找不到 const LEX = {')
  } else {
    const rest = source.slice(lexAt)
    // 三块的起止：zh 从 'zh: {' 到 'en: {', en 到 'nl: {', nl 到 LEX 对象闭合
    const zhAt = rest.indexOf('zh: {')
    const enAt = rest.indexOf('en: {')
    const nlAt = rest.indexOf('nl: {')
    const endAt = rest.indexOf('\n    }\n', nlAt)
    if (zhAt === -1 || enAt === -1 || nlAt === -1 || endAt === -1) {
      fail(file, 'LEX 三块（zh/en/nl）定位失败，检查脚本需要同步更新')
    } else {
      const keysOf = (chunk) => new Set([...chunk.matchAll(/'([a-zA-Z][\w.]*)':/g)].map((m) => m[1]))
      const zh = keysOf(rest.slice(zhAt, enAt))
      const en = keysOf(rest.slice(enAt, nlAt))
      const nl = keysOf(rest.slice(nlAt, endAt))
      if (zh.size < 100) fail(file, `LEX zh 只解析出 ${zh.size} 个键，解析可能失效`)
      for (const key of zh) {
        if (!en.has(key)) fail(file, `LEX 缺 en 译文：${key}`)
        if (!nl.has(key)) fail(file, `LEX 缺 nl 译文：${key}`)
      }
      for (const key of en) if (!zh.has(key)) fail(file, `LEX 缺 zh 译文：${key}`)
      for (const key of nl) if (!zh.has(key)) fail(file, `LEX 缺 zh 译文：${key}`)
    }
  }
}

// ── 5. 行尾与空白 ────────────────────────────────────────────────────────
const textFiles = [
  ...listFiles(join(root, 'lib'), (name) => /\.(js|py|json|md|yml)$/.test(name)),
  ...listFiles(join(root, 'test'), (name) => name.endsWith('.mjs')),
  ...listFiles(join(root, 'scripts'), (name) => name.endsWith('.mjs')),
  ...listFiles(join(root, 'locale'), (name) => name.endsWith('.json')),
  join(root, 'package.json'),
  join(root, 'README.md'),
  join(root, 'CHANGELOG.md'),
  join(root, 'cordis.patch.yml'),
].filter((file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
})

for (const file of textFiles) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('\r\n')) {
    const count = (source.match(/\r\n/g) || []).length
    fail(file, `混入 CRLF（${count} 行）——会把 diff 变成整文件重写，测试里的 \\n 正则也会失效`)
    continue
  }
  const lines = source.split('\n')
  const trailing = lines.findIndex((line) => /[ \t]+$/.test(line))
  if (trailing !== -1) fail(file, `第 ${trailing + 1} 行有行尾空白`)
  if (!source.endsWith('\n')) fail(file, '文件末尾缺少换行')
}

// 粗粒度版本比较：只认 x.y.z 三段数字，够用来判断「索引超前或落后」。
function compareVersion(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

// ── 6. 版本号与 index.json 一致（如果仓库里有）────────────────────────────
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const indexPath = join(root, 'index.json')
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    const version = index && index.plugins && index.plugins[0] && index.plugins[0].versions
      ? index.plugins[0].versions[0].version
      : null
    if (typeof version === 'string' && version !== pkg.version) {
      // 索引落后是发版中途的正常状态：流程是「改 package.json → 提交源码 →
      // 重建索引 → 提交索引」，CI 里 lint 跑在 build-index 之前，那一刻索引
      // 必然还是上一版。这里只提醒不失败，否则每次发版都得人工忽略一次警告，
      // 这项检查就等于没有。
      // 真正危险的是反方向：索引比包新，说明源码没跟上索引，发出去用户装到的
      // 是索引承诺的版本而仓库里根本没有那段代码。
      const cmp = compareVersion(version, pkg.version)
      if (cmp > 0) {
        fail(indexPath, `索引里的版本 ${version} 比 package.json 的 ${pkg.version} 还新（索引超前于源码，用户会装到不存在的版本）`)
      } else {
        console.log(`提醒：index.json 还是 ${version}，package.json 已是 ${pkg.version}（发版时重建索引即可）`)
      }
    }
  } catch {
    // 没有 index.json 或读不出来都跳过：它只在发版时才有
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.log(`发现 ${problems.length} 个问题：\n`)
  for (const line of problems) console.log(`  ${line}`)
  process.exit(1)
}
console.log(`LINT_OK（${textFiles.length} 个文件，${pyFiles.length} 个 Python 脚本）`)
