#!/usr/bin/env node
/**
 * 用法：
 *   node scripts/build-index.mjs --repo https://github.com/<user>/dsh-getnote
 *   node scripts/build-index.mjs --repo <url> --commit <40位SHA>
 *
 * `--commit` 用于「远端提交与本地提交不是同一个」的场景：比如用 Git Data API
 * 逐个 blob 拼出来的提交，SHA 与本地 git 历史完全不同。此时索引必须指向**远端
 * 那个** SHA，否则装的时候 GitHub 上找不到这个 commit，报错还很难懂。
 *
 * 会做三件事：
 *   1. 从 package.json 读 name / version / engines.dsh，保证索引里声明的
 *      engines.dsh 与包本身一致（不一致 DSH 会在安装时拒绝）；
 *   2. 从 git 读当前 HEAD 的 40 位 commit SHA —— git 源必须钉死到具体 commit，
 *      否则 DSH 拒绝（不允许指向浮动分支）；
 *   3. 写 index.json（含 icon 的外链路径、分类与排序键）。
 *
 * 之所以不手写 index.json：commit SHA、publishTimestamp 这些每次发版都得变，
 * 手改必漏，漏了的表现是「索引能加载但装不上」，排查起来很费劲。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= process.argv.length) return fallback
  return process.argv[index + 1]
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    throw new Error('读不到 git commit —— 先在仓库根目录完成一次提交（索引里的 git 源必须钉到具体 commit）')
  }
}

const repo = arg('repo').replace(/\.git$/, '').replace(/\/$/, '')
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo)) {
  throw new Error(`--repo 要是 https://github.com/<user>/<repo> 形式，收到：${repo || '(空)'}`)
}
const [, , , repoUser, repoName] = repo.split('/')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// --commit 优先：用 Git Data API 推上去的提交与本地 git 历史没有共同 SHA，
// 这时索引必须写远端那个 SHA，否则用户装的时候 GitHub 上找不到这个 commit。
const commitArg = arg('commit')
if (commitArg !== '' && !/^[0-9a-f]{40}$/.test(commitArg)) {
  throw new Error(`--commit 要是 40 位十六进制 SHA，收到：${commitArg}`)
}
const commit = commitArg !== '' ? commitArg : gitCommit()
const dshRange = pkg.engines?.dsh
if (!dshRange) {
  // 没有 engines.dsh 时 DSH 会退化成检查 @deepseek-ai/dsh* peer 依赖，
  // 本包不依赖那些包，检查会失败，所以这里直接拦住而不是生成一份装不上的索引。
  throw new Error('package.json 缺 engines.dsh —— 生成出来的索引会在安装阶段被拒绝')
}

const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))

const index = {
  format: 1,
  title: { en: `DSH plugins by ${repoUser}`, zh: 'DSH 插件' },
  plugins: [
    {
      name: pkg.name,
      title: { en: en.meta.title, zh: zh.meta.title },
      description: { en: en.meta.description, zh: zh.meta.description },
      // 相对路径按索引 URL 解析：index.json 与 icon.svg 都放在仓库根，
      // GitHub Pages 上于是解析成 https://<user>.github.io/<repo>/icon.svg
      icon: 'icon.svg',
      // 这些字段从 --repo 推导，不读 package.json：仓库地址还是占位符时，
      // 索引里出现 __GITHUB_USER__ 这种字符串会让市场页显示一个点不开的链接。
      author: repoUser,
      homepage: `${repo}#readme`,
      repository: { url: repo },
      metadata: {
        category: 'notes',
        labels: [
          { en: 'Notes', zh: '笔记' },
          { en: 'Local-first', zh: '本地优先' },
          { en: 'Markdown', zh: 'Markdown' },
        ],
      },
      versions: [
        {
          version: pkg.version,
          // Unix 秒，不是毫秒 —— 写成毫秒 DSH 会当成几万年后的时间。
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: repo, commit },
          engines: { dsh: dshRange },
        },
      ],
    },
  ],
  metadata: {
    categories: {
      notes: { title: { en: 'Notes & knowledge', zh: '笔记与知识库' } },
    },
  },
}

const out = join(root, 'index.json')
writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8')

// 生成后自检：这几条是最常见的「索引能加载但装不上」原因。
const problems = []
if (!Array.isArray(index.plugins) || index.plugins.length === 0) problems.push('plugins 为空')
for (const plugin of index.plugins) {
  if (!/^[\w@/.-]+$/.test(plugin.name)) problems.push(`name 不合法：${plugin.name}`)
  for (const version of plugin.versions) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version.version)) problems.push(`version 不是精确 SemVer：${version.version}`)
    if (!/^[0-9a-f]{40}$/.test(version.source.commit)) problems.push('commit 不是 40 位 SHA')
    if (version.publishTimestamp > 1e11) problems.push('publishTimestamp 像是毫秒，应为秒')
  }
}
if (problems.length > 0) {
  console.error('索引自检失败：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

// icon 必须在包内，否则 DSH 拒绝整份索引。
if (!existsSync(join(root, 'icon.svg'))) {
  console.error('警告：仓库根没有 icon.svg，索引里的 icon 会 404')
}

console.log(`已写入 ${out}`)
console.log(`  插件   ${pkg.name}@${pkg.version}`)
console.log(`  commit ${commit}`)
console.log(`  索引URL（推上 GitHub Pages 后） https://${repo.split('/')[3]}.github.io/${repo.split('/')[4]}/index.json`)
