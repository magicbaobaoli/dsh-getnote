/**
 * 离线性验收：不碰网络，只把本地库这一层（vault/settings）跑通。
 * 用临时目录，不污染用户真实库。
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanVault,
  buildTree,
  readNote,
  writeNote,
  createNote,
  trashNote,
  searchNotes,
  parseFrontmatter,
  vaultStats,
  listDirs,
  listAssets,
} from '../lib/vault.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'dshgn-test-'))
try {
  // 1. frontmatter 解析（用户已有归档库的真实形状）
  const sample = `---
tags: [得到大脑, 录音卡, 私密]
note_id: "1200000000000000001"
note_url: https://www.biji.com/note/1200000000000000001
知识库: 生活记录
归档: 2026-11-13
---

# 示例录音笔记

正文第一段。
`
  const fm = parseFrontmatter(sample)
  check('frontmatter: tags 数组', JSON.stringify(fm.data.tags) === JSON.stringify(['得到大脑', '录音卡', '私密']), JSON.stringify(fm.data.tags))
  check('frontmatter: note_id 引号剥除', fm.data.note_id === '1200000000000000001', String(fm.data.note_id))
  check('frontmatter: 中文键', fm.data['知识库'] === '生活记录', String(fm.data['知识库']))
  check('frontmatter: 正文剥离', fm.body.trim().startsWith('# 示例录音笔记'), JSON.stringify(fm.body.slice(0, 20)))

  // 2. 写入 + 扫描
  await mkdir(join(root, '生活记录'), { recursive: true })
  await writeFile(join(root, '生活记录', '2026-11-13-示例录音笔记.md'), sample, 'utf8')
  await mkdir(join(root, '项目与作品'), { recursive: true })
  await writeFile(join(root, '项目与作品', '2026-10-01-某个项目.md'), '# 某个项目\n\n项目正文，含关键词 kumquat。\n', 'utf8')

  const scan = await scanVault(root)
  check('scanVault: 找到 2 篇', scan.entries.length === 2, `${scan.entries.length}`)
  const entry = scan.entries.find((e) => e.path.includes('示例录音笔记'))
  check('scanVault: 标题来自 # 标题', entry && entry.title === '示例录音笔记', entry && entry.title)
  check('scanVault: 日期来自文件名', entry && entry.date === '2026-11-13', entry && entry.date)
  check('scanVault: noteId 提取', entry && entry.noteId === '1200000000000000001', entry && entry.noteId)
  check('scanVault: tags', entry && entry.tags.length === 3, entry && JSON.stringify(entry.tags))

  // 3. 树
  const tree = buildTree(scan.entries)
  check('buildTree: 2 个顶层目录', tree.children.filter((c) => c.kind === 'dir').length === 2, String(tree.children.length))
  check('buildTree: 计数', tree.count === 2, String(tree.count))

  // 4. 读
  const note = await readNote(root, '生活记录/2026-11-13-示例录音笔记.md')
  check('readNote: 内容完整', note.content.includes('# 示例录音笔记'), `${note.bytes} bytes`)
  check('readNote: frontmatter 附加', note.frontmatter['归档'] === '2026-11-13', String(note.frontmatter['归档']))

  // 5. 路径逃逸必须被拒
  let escaped = false
  try {
    await readNote(root, '../../etc/passwd')
  } catch {
    escaped = true
  }
  check('readNote: 拒绝 ../ 逃逸', escaped)

  // 6. 写（保留 .bak）
  await writeNote(root, '生活记录/2026-11-13-示例录音笔记.md', sample.replace('正文第一段。', '改过的正文。'))
  const bak = await readFile(join(root, '生活记录', '2026-11-13-示例录音笔记.md.bak'), 'utf8')
  check('writeNote: 留 .bak', bak.includes('正文第一段。'), `${bak.length} chars`)
  const after = await readNote(root, '生活记录/2026-11-13-示例录音笔记.md')
  check('writeNote: 新内容生效', after.content.includes('改过的正文。'))

  // 7. 新建：同名不覆盖
  const created1 = await createNote(root, { dir: '项目与作品', title: '同名测试', content: '# 一\n' })
  const created2 = await createNote(root, { dir: '项目与作品', title: '同名测试', content: '# 二\n' })
  check('createNote: 首篇命名带日期', /^\d{4}-\d{2}-\d{2}-同名测试\.md$/.test(created1.path.split('/').pop()), created1.path)
  check('createNote: 冲突追加 -2', created2.path.includes('-2.md'), created2.path)
  const one = await readNote(root, created1.path)
  check('createNote: 原文件未被覆盖', one.content.includes('# 一'))

  // 8. 回收站
  const trashed = await trashNote(root, created2.path)
  check('trashNote: 进 .trash', trashed.trashedTo.startsWith('.trash/'), trashed.trashedTo)
  const scan2 = await scanVault(root)
  check('trashNote: 扫描不再计入', !scan2.entries.some((e) => e.path === created2.path))

  // 9. 搜索
  const found = await searchNotes(root, 'kumquat')
  check('searchNotes: 命中正文', found.hits.length === 1 && found.hits[0].matches.length === 1, JSON.stringify(found.hits.map((x) => x.path)))
  const foundTitle = await searchNotes(root, '同名')
  check('searchNotes: 命中标题', foundTitle.hits.some((x) => x.titleHit === true))

  // 10. 统计与目录
  const stats = await vaultStats(root, scan2.entries)
  check('vaultStats: 计数/体积', stats.notes === scan2.entries.length && stats.bytes > 0, JSON.stringify(stats))
  const dirs = listDirs(scan2.entries)
  check('listDirs: 含根与两个目录', dirs.includes('') && dirs.includes('生活记录') && dirs.includes('项目与作品'), JSON.stringify(dirs))

  // 11. 中文与非法字符文件名
  const weird = await createNote(root, { dir: '', title: 'a/b:c*d?e"f<g>h|i', content: 'x' })
  check('createNote: 清洗非法字符', !/[\\/:*?"<>|]/.test(weird.path), weird.path)

  // 12. 附件归属：录音 mp3 / 转写 md 要能被对应的笔记认领。
  //     真实库里的命名是 Obsidian 端插件留下的「<云端标题>_<note_id>_audio.mp3」，
  //     而本地文件名是「YYYY-MM-DD-<本地标题>」，两边标题实测并不相同，所以
  //     只靠文件名主干是认不出来的，必须靠 note_id。
  const assetDir = join(root, '生活记录', 'asset')
  await mkdir(assetDir, { recursive: true })
  await writeFile(join(assetDir, '云端标题_1200000000000000001_audio.mp3'), Buffer.alloc(64, 1))
  await writeFile(join(assetDir, '云端标题_1200000000000000001_transcript.md'), '# 转写\n', 'utf8')
  await writeFile(join(assetDir, '别的笔记_9999999999999999999_audio.mp3'), Buffer.alloc(8, 2))
  await writeFile(join(assetDir, '云端标题_1200000000000000001_audio.mp3.bak'), Buffer.alloc(8, 3))

  const assetsById = await listAssets(root, '生活记录/2026-11-13-本地标题.md', '1200000000000000001')
  check('listAssets: 靠 note_id 认领附件', assetsById.length === 2, JSON.stringify(assetsById.map((a) => a.name)))
  check(
    'listAssets: 分出 audio / transcript',
    assetsById.some((a) => a.kind === 'audio') && assetsById.some((a) => a.kind === 'transcript'),
    JSON.stringify(assetsById.map((a) => a.kind)),
  )
  check('listAssets: 跳过 .bak', !assetsById.some((a) => a.name.endsWith('.bak')), JSON.stringify(assetsById.map((a) => a.name)))
  check('listAssets: 不认领别人的附件', !assetsById.some((a) => a.name.includes('9999999999999999999')), JSON.stringify(assetsById.map((a) => a.name)))

  const assetsByStem = await listAssets(root, '生活记录/2026-11-13-云端标题.md', '')
  check('listAssets: 没有 note_id 时靠去日期前缀的主干认领', assetsByStem.length === 2, JSON.stringify(assetsByStem.map((a) => a.name)))

  const noAssets = await listAssets(root, '生活记录/2026-11-13-毫无关系的笔记.md', '')
  check('listAssets: 没附件时返回空数组而不是抛错', Array.isArray(noAssets) && noAssets.length === 0, JSON.stringify(noAssets))

  const noDir = await listAssets(root, '项目与作品/2026-11-13-没有 asset 目录.md', '')
  check('listAssets: 没有 asset 目录时返回空数组', Array.isArray(noDir) && noDir.length === 0, JSON.stringify(noDir))
} finally {
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
