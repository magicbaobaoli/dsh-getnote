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
  listTrash,
  restoreNote,
  purgeTrash,
  parseTrashName,
  removeTag,
  readTags,
  rewriteTags,
  normalizeTags,
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
知识库: 随手记
归档: 2026-11-13
---

# 示例录音笔记

正文第一段。
`
  const fm = parseFrontmatter(sample)
  check('frontmatter: tags 数组', JSON.stringify(fm.data.tags) === JSON.stringify(['得到大脑', '录音卡', '私密']), JSON.stringify(fm.data.tags))
  check('frontmatter: note_id 引号剥除', fm.data.note_id === '1200000000000000001', String(fm.data.note_id))
  check('frontmatter: 中文键', fm.data['知识库'] === '随手记', String(fm.data['知识库']))
  check('frontmatter: 正文剥离', fm.body.trim().startsWith('# 示例录音笔记'), JSON.stringify(fm.body.slice(0, 20)))

  // 2. 写入 + 扫描
  await mkdir(join(root, '随手记'), { recursive: true })
  await writeFile(join(root, '随手记', '2026-11-13-示例录音笔记.md'), sample, 'utf8')
  await mkdir(join(root, '做过的项目'), { recursive: true })
  await writeFile(join(root, '做过的项目', '2026-10-01-某个项目.md'), '# 某个项目\n\n项目正文，含关键词 kumquat。\n', 'utf8')

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
  const note = await readNote(root, '随手记/2026-11-13-示例录音笔记.md')
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
  await writeNote(root, '随手记/2026-11-13-示例录音笔记.md', sample.replace('正文第一段。', '改过的正文。'))
  const bak = await readFile(join(root, '随手记', '2026-11-13-示例录音笔记.md.bak'), 'utf8')
  check('writeNote: 留 .bak', bak.includes('正文第一段。'), `${bak.length} chars`)
  const after = await readNote(root, '随手记/2026-11-13-示例录音笔记.md')
  check('writeNote: 新内容生效', after.content.includes('改过的正文。'))

  // 7. 新建：同名不覆盖
  const created1 = await createNote(root, { dir: '做过的项目', title: '同名测试', content: '# 一\n' })
  const created2 = await createNote(root, { dir: '做过的项目', title: '同名测试', content: '# 二\n' })
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
  check('listDirs: 含根与两个目录', dirs.includes('') && dirs.includes('随手记') && dirs.includes('做过的项目'), JSON.stringify(dirs))

  // 11. 中文与非法字符文件名
  const weird = await createNote(root, { dir: '', title: 'a/b:c*d?e"f<g>h|i', content: 'x' })
  check('createNote: 清洗非法字符', !/[\\/:*?"<>|]/.test(weird.path), weird.path)

  // 12. 附件归属：录音 mp3 / 转写 md 要能被对应的笔记认领。
  //     真实库里的命名是 Obsidian 端插件留下的「<云端标题>_<note_id>_audio.mp3」，
  //     而本地文件名是「YYYY-MM-DD-<本地标题>」，两边标题实测并不相同，所以
  //     只靠文件名主干是认不出来的，必须靠 note_id。
  const assetDir = join(root, '随手记', 'asset')
  await mkdir(assetDir, { recursive: true })
  await writeFile(join(assetDir, '云端标题_1200000000000000001_audio.mp3'), Buffer.alloc(64, 1))
  await writeFile(join(assetDir, '云端标题_1200000000000000001_transcript.md'), '# 转写\n', 'utf8')
  await writeFile(join(assetDir, '别的笔记_9999999999999999999_audio.mp3'), Buffer.alloc(8, 2))
  await writeFile(join(assetDir, '云端标题_1200000000000000001_audio.mp3.bak'), Buffer.alloc(8, 3))

  const assetsById = await listAssets(root, '随手记/2026-11-13-本地标题.md', '1200000000000000001')
  check('listAssets: 靠 note_id 认领附件', assetsById.length === 2, JSON.stringify(assetsById.map((a) => a.name)))
  check(
    'listAssets: 分出 audio / transcript',
    assetsById.some((a) => a.kind === 'audio') && assetsById.some((a) => a.kind === 'transcript'),
    JSON.stringify(assetsById.map((a) => a.kind)),
  )
  check('listAssets: 跳过 .bak', !assetsById.some((a) => a.name.endsWith('.bak')), JSON.stringify(assetsById.map((a) => a.name)))
  check('listAssets: 不认领别人的附件', !assetsById.some((a) => a.name.includes('9999999999999999999')), JSON.stringify(assetsById.map((a) => a.name)))

  const assetsByStem = await listAssets(root, '随手记/2026-11-13-云端标题.md', '')
  check('listAssets: 没有 note_id 时靠去日期前缀的主干认领', assetsByStem.length === 2, JSON.stringify(assetsByStem.map((a) => a.name)))

  const noAssets = await listAssets(root, '随手记/2026-11-13-毫无关系的笔记.md', '')
  check('listAssets: 没附件时返回空数组而不是抛错', Array.isArray(noAssets) && noAssets.length === 0, JSON.stringify(noAssets))

  const noDir = await listAssets(root, '做过的项目/2026-11-13-没有 asset 目录.md', '')
  check('listAssets: 没有 asset 目录时返回空数组', Array.isArray(noDir) && noDir.length === 0, JSON.stringify(noDir))

  // ── 回收站 ────────────────────────────────────────────────────────────────
  // 以前删除只进不出：面板上没有任何入口能看见 .trash、更没法恢复。下面这组
  // 断言盯的就是「删错了还能救回来」这条底线。
  const trashParsed = parseTrashName('2026-11-15T03-04-05-678Z__随手记·旧笔记.md')
  check('parseTrashName: 拆出原名', trashParsed !== null && trashParsed.originalName === '随手记·旧笔记.md', JSON.stringify(trashParsed))
  check('parseTrashName: 拆出删除时间', trashParsed !== null && /^2026-11-15T03:04:05\.678Z$/.test(trashParsed.trashedAt), JSON.stringify(trashParsed))
  // 非约定格式不抛错、也不假装知道删除时间：trashedAt 给 null，originalName 保留原名。
  const trashOdd = parseTrashName('随便一个名字.md')
  check('parseTrashName: 非约定格式不炸且时间未知',
    trashOdd !== null && trashOdd.trashedAt === null && trashOdd.originalName === '随便一个名字.md',
    JSON.stringify(trashOdd))

  // 注意：`createNote` 传了 content 时标题由正文里的一级标题推出，所以这里让正文
  // 自己带 `# 待删的笔记`，否则标题会变成第一个小标题。
  await createNote(root, { dir: '做过的项目', title: '待删的笔记', content: '# 待删的笔记\n\n删掉我\n' })
  const beforeTrash = await scanVault(root)
  const trashedRel = beforeTrash.entries.find((e) => e.title === '待删的笔记')
  check('回收站: 先有一条笔记可删', trashedRel !== undefined, JSON.stringify(beforeTrash.entries.map((e) => e.title)))

  const trashResult = await trashNote(root, trashedRel.path)
  check('回收站: 删除返回目标路径', trashResult !== null && typeof trashResult.trashedTo === 'string' && trashResult.trashedTo.startsWith('.trash/'), JSON.stringify(trashResult))

  const afterTrash = await scanVault(root)
  check('回收站: 删掉的笔记不再出现在库里', !afterTrash.entries.some((e) => e.title === '待删的笔记'))

  const trashList = await listTrash(root)
  check('回收站: listTrash 能看到它', trashList.some((i) => i.title === '待删的笔记'), JSON.stringify(trashList.map((i) => i.title)))
  check('回收站: listTrash 带上原始文件名', trashList.some((i) => typeof i.originalName === 'string' && i.originalName.length > 0))
  check('回收站: listTrash 带上大小与时间',
    trashList.every((i) => typeof i.bytes === 'number' && typeof i.trashedAt === 'string'))

  const target = trashList.find((i) => i.title === '待删的笔记')
  const restored = await restoreNote(root, target.path, '')
  check('回收站: 恢复返回落点路径', typeof restored.path === 'string' && restored.path.length > 0, JSON.stringify(restored))
  const restoredText = await readFile(join(root, restored.path), 'utf8')
  check('回收站: 恢复后内容原样', restoredText.includes('删掉我'), restoredText.slice(0, 60))
  check('回收站: 恢复后不在回收站里了', !(await listTrash(root)).some((i) => i.title === '待删的笔记'))

  // 恢复不能覆盖同名文件——为了救一个文件而毁掉另一个说不通。
  await createNote(root, { dir: '做过的项目', title: '撞名测试', content: '# 撞名测试\n\nA 版本\n' })
  const toTrash2 = (await scanVault(root)).entries.find((e) => e.title === '撞名测试')
  const trashed2 = await trashNote(root, toTrash2.path)
  const parsed2 = parseTrashName(trashed2.trashedTo.split('/').pop())
  // 再放一个同名文件占位（和恢复目标同一目录，这样才能真的撞上）
  const occupiedRel = `做过的项目/${parsed2.originalName}`
  await writeFile(join(root, '做过的项目', parsed2.originalName), 'B 版本\n', 'utf8')
  const item2 = (await listTrash(root)).find((i) => i.originalName === parsed2.originalName)
  const restored2 = await restoreNote(root, item2.path, occupiedRel)
  check('回收站: 撞名时改名而不是覆盖', restored2.path !== occupiedRel, restored2.path)
  check('回收站: 撞名时占位文件没被改', (await readFile(join(root, occupiedRel), 'utf8')) === 'B 版本\n')

  // 永久删除
  const trashListBefore = await listTrash(root)
  check('回收站: 清空前有东西', trashListBefore.length > 0, String(trashListBefore.length))
  const purged = await purgeTrash(root, trashListBefore[0].path)
  check('回收站: purgeTrash 单个返回已删列表', Array.isArray(purged.purged) && purged.purged.length === 1, JSON.stringify(purged))
  check('回收站: 单个清除后少一条', (await listTrash(root)).length === trashListBefore.length - 1)

  const purgeAllResult = await purgeTrash(root)
  check('回收站: purgeTrash 清空全部', Array.isArray(purgeAllResult.purged) && purgeAllResult.purged.length === trashListBefore.length - 1, JSON.stringify(purgeAllResult))
  check('回收站: 清空后为空', (await listTrash(root)).length === 0)

  // 标签改写：块列表写法必须整段换掉，不能留悬空 `- 甲` 残渣
  // （这是真 bug：只替换 `tags:` 那一行的话，下面的列表项会原地留下，
  //  文件变成「新标签 + 一堆孤儿列表项」，下次解析把它们当垃圾）
  const readTagsFile = async (rel) => readTags(await readFile(join(root, rel), 'utf8'))
  const blockRel = '标签测试/块列表.md'
  await mkdir(join(root, '标签测试'), { recursive: true })
  await writeFile(join(root, blockRel), ['---', 'title: 块列表', 'tags:', '  - 甲', '  - 乙', '  - 丙', 'note_id: "9001"', '---', '', '正文'].join('\n'), 'utf8')
  check('标签: readTags 认块列表写法', JSON.stringify(await readTagsFile(blockRel)) === JSON.stringify(['甲', '乙', '丙']))
  await removeTag(root, '乙', [{ path: blockRel, tags: ['甲', '乙', '丙'] }])
  const blockAfter = await readFile(join(root, blockRel), 'utf8')
  check('标签: 块列表删除后剩两个', JSON.stringify(await readTagsFile(blockRel)) === JSON.stringify(['甲', '丙']), blockAfter)
  check('标签: 块列表删除后没有悬空列表项', !/^\s+-\s/m.test(blockAfter), blockAfter)
  check('标签: 块列表删除后其他字段没动', /^note_id: "9001"$/m.test(blockAfter) && /^title: 块列表$/m.test(blockAfter))

  const inlineRel = '标签测试/行内.md'
  await writeFile(join(root, inlineRel), ['---', 'title: 行内', 'tags: [甲, 乙]', '---', '', '正文'].join('\n'), 'utf8')
  await removeTag(root, '乙', [{ path: inlineRel, tags: ['甲', '乙'] }])
  check('标签: 行内写法删除只留一个', JSON.stringify(await readTagsFile(inlineRel)) === JSON.stringify(['甲']))

  await removeTag(root, '甲', [{ path: inlineRel, tags: ['甲'] }])
  check('标签: 删到空写成空数组', /^tags: \[\]$/m.test(await readFile(join(root, inlineRel), 'utf8')))

  // 加标签：块列表新增要转成合法的行内数组，且不能残留旧块列表
  const addRel = '标签测试/加标签.md'
  await writeFile(join(root, addRel), ['---', 'title: 加标签', 'tags:', '  - 旧', '---', '', '正文'].join('\n'), 'utf8')
  const added = rewriteTags(await readFile(join(root, addRel), 'utf8'), ['旧', '新'])
  check('标签: rewriteTags 块列表新增合并成行内', /^tags: \[旧, 新\]$/m.test(added), added)
  check('标签: rewriteTags 新增后无残渣', !/^\s+-\s/m.test(added), added)

  // 无 frontmatter / 无 tags 字段也要能正确落盘
  const bareRel = '标签测试/无frontmatter.md'
  await writeFile(join(root, bareRel), '只有正文\n', 'utf8')
  const bareOut = rewriteTags(await readFile(join(root, bareRel), 'utf8'), ['新标签'])
  check('标签: 无 frontmatter 自动包一层', /^---\ntags: \[新标签\]\n---\n/.test(bareOut), bareOut)
  const noTagsOut = rewriteTags(['---', 'title: 无tags', '---', '', '正文'].join('\n'), ['x'])
  check('标签: 无 tags 字段插到末尾且保留原字段', /title: 无tags\n tags: \[x\]|title: 无tags\ntags: \[x\]/.test(noTagsOut), noTagsOut)

  // 单值标签写法 `tags: 甲`（合法 YAML，不是数组）必须能被认出来，
  // 否则 `tag:甲` 搜不到那篇——用户明明看着标签在那儿却搜不出来。
  check('标签: normalizeTags 单值转数组', JSON.stringify(normalizeTags('独苗')) === JSON.stringify(['独苗']))
  check('标签: normalizeTags 数组原样', JSON.stringify(normalizeTags(['甲', '乙'])) === JSON.stringify(['甲', '乙']))
  check('标签: normalizeTags 空值回空数组', normalizeTags(undefined).length === 0 && normalizeTags('').length === 0 && normalizeTags([]).length === 0)
  const singleRel = '标签测试/单值标签.md'
  await writeFile(join(root, singleRel), ['---', 'tags: 独苗', '---', '', '正文里有 关键词'].join('\n'), 'utf8')
  const singleScan = await scanVault(root)
  const singleEntry = singleScan.entries.find((e) => e.path === singleRel)
  check('标签: 扫描把单值写法读成数组', Array.isArray(singleEntry.tags) && singleEntry.tags[0] === '独苗', JSON.stringify(singleEntry && singleEntry.tags))
  const singleHits = await searchNotes(root, 'tag:独苗', {})
  check('标签: tag:单值 能搜到', Array.isArray(singleHits.hits) && singleHits.hits.some((h) => h.path === singleRel), JSON.stringify((singleHits.hits || []).map((h) => h.path)))

  // 批量改标签不能每篇留一个 .bak：用户库里会堆出几十个看不见的副本。
  // 给了 snapshot 回调时走 history，一个 .bak 都不该产生。
  const bakDir = '标签测试'
  const bakFilesBefore = (await readdir(join(root, bakDir))).filter((name) => name.endsWith('.bak')).length
  await writeFile(join(root, bakDir, '批量A.md'), ['---', 'tags: [要删的, 保留的]', '---', '', '正文'].join('\n'), 'utf8')
  await writeFile(join(root, bakDir, '批量B.md'), ['---', 'tags: [要删的]', '---', '', '正文'].join('\n'), 'utf8')
  const snaps = []
  const bulk = await removeTag(root, '要删的', [
    { path: `${bakDir}/批量A.md`, tags: ['要删的', '保留的'] },
    { path: `${bakDir}/批量B.md`, tags: ['要删的'] },
  ], { snapshot: async (rel) => { snaps.push(rel) } })
  check('标签: 批量删两篇', bulk.changed === 2, JSON.stringify(bulk))
  check('标签: 批量删会先留历史快照', snaps.length === 2 && snaps.indexOf(`${bakDir}/批量A.md`) >= 0, JSON.stringify(snaps))
  const bakFilesAfter = (await readdir(join(root, bakDir))).filter((name) => name.endsWith('.bak')).length
  check('标签: 走历史就不产生 .bak', bakFilesAfter === bakFilesBefore, `${bakFilesBefore} → ${bakFilesAfter}`)
} finally {
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
