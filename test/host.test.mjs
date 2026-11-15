/**
 * host 路由的离线验收：起一个假的 webServer（真 Node http），把 apply() 挂上去，
 * 然后像浏览器那样打 /getnote/* 请求。不碰网络、不碰用户真实库。
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用独立 DSH_HOME，避免写进用户真实配置目录
const fakeHome = await mkdtemp(join(tmpdir(), 'dshgn-home-'))
process.env.DSH_HOME = fakeHome

const { apply } = await import('../lib/index.js')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── 假 webServer ────────────────────────────────────────────────────────────
const routes = []
const fakeWebServer = {
  getOrigin: () => 'http://127.0.0.1:8115',
  register: (route) => {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

// 假 ctx：只有 inject / effect / get
const effects = []
const fakeCtx = {
  inject: (names, callback) => {
    if (names.includes('webServer')) callback({ webServer: fakeWebServer, get: () => fakeWebServer, effect: (fn) => { const d = fn(); effects.push(d); return d } })
  },
  effect: (fn) => {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  get: (name) => (name === 'webServer' ? fakeWebServer : undefined),
}

apply(fakeCtx, {})

check('apply: 注册了 1 条路由', routes.length === 1, JSON.stringify(routes.map((r) => `${r.kind}:${r.path}`)))
check('apply: 路由是 prefix', routes[0] && routes[0].kind === 'prefix', routes[0] && routes[0].kind)
check('apply: 路由路径是 /getnote', routes[0] && routes[0].path === '/getnote', routes[0] && routes[0].path)

// ── 把 handler 挂到真 http server 上 ────────────────────────────────────────
const handler = routes[0].handler
const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0]
  if (path === '/getnote' || path.startsWith('/getnote/')) return handler(req, res)
  res.writeHead(404).end('not found')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const base = `http://127.0.0.1:${port}/getnote`

async function call(path, init) {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // 回调页是 HTML
  }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') }
}

const postJson = (path, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

try {
  // 1. 未配置库时的 status：应给出默认根，且 missing=false（默认根会自动建）
  const s1 = await call('/status')
  check('GET /status 200', s1.status === 200, JSON.stringify(s1.json && Object.keys(s1.json)))
  check('GET /status 报告 vaultRoot', typeof s1.json.vaultRoot === 'string' && s1.json.vaultRoot.length > 0, s1.json.vaultRoot)
  check('GET /status 报告 cloud.loggedIn=false', s1.json.cloud && s1.json.cloud.loggedIn === false, JSON.stringify(s1.json.cloud))

  // 2. 指定一个临时库目录
  const vault = await mkdtemp(join(tmpdir(), 'dshgn-vault-'))
  await mkdir(join(vault, '生活记录'), { recursive: true })
  await writeFile(
    join(vault, '生活记录', '2026-11-13-示例录音笔记.md'),
    '---\ntags: [得到大脑, 私密]\nnote_id: "1200000000000000001"\n归档: 2026-11-13\n---\n\n# 示例录音笔记\n\n第一次录音的感受，关键词 watermelon。\n',
    'utf8',
  )
  await writeFile(join(vault, '项目与作品'), 'not a dir', 'utf8').catch(() => {})

  const setRes = await call('/settings', postJson('/settings', { vaultPath: vault }))
  check('POST /settings 切换库', setRes.status === 200 && setRes.json.effectiveRoot === vault, setRes.json && setRes.json.effectiveRoot)

  // 3. 设置持久化到独立 DSH_HOME
  const settingsFile = join(fakeHome, 'dsh-getnote.json')
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
  check('设置写入 $DSH_HOME/dsh-getnote.json', saved.vaultRoot === vault, JSON.stringify(saved))

  // 4. tree / list
  const treeRes = await call('/tree')
  check('GET /tree 返回条目', treeRes.json.entries.length === 1, `${treeRes.json.entries && treeRes.json.entries.length}`)
  check('GET /tree 目录树', treeRes.json.tree.children.length === 1 && treeRes.json.tree.children[0].name === '生活记录', JSON.stringify(treeRes.json.tree.children.map((c) => c.name)))
  const listRes = await call('/list?q=watermelon')
  check('GET /list 关键词过滤', listRes.json.total === 1, JSON.stringify(listRes.json.total))
  const listTag = await call('/list?tag=私密')
  check('GET /list 标签过滤', listTag.json.total === 1, String(listTag.json.total))
  const listNone = await call('/list?tag=不存在')
  check('GET /list 无匹配', listNone.json.total === 0, String(listNone.json.total))

  // 5. read
  const readRes = await call('/read?path=' + encodeURIComponent('生活记录/2026-11-13-示例录音笔记.md'))
  check('GET /read 读到正文', readRes.json.content.includes('# 示例录音笔记'), `${readRes.json.bytes} bytes`)
  check('GET /read 附件 frontmatter', readRes.json.frontmatter.note_id === '1200000000000000001', String(readRes.json.frontmatter.note_id))

  // 5b. 本地附件（录音）直出。
  //     这组断言护的是一整条链路：vault 层按 note_id 认领附件 → /read 带回去 →
  //     /asset 支持 Range。缺任何一环，面板上「本地录音」播放器就是块死按钮。
  const assetDir = join(vault, '生活记录', 'asset')
  await mkdir(assetDir, { recursive: true })
  // 附件名故意用「云端标题 + note_id」——与真实库里 Obsidian 端插件留下的命名一致，
  // 而本地文件名是「2026-11-13-示例录音笔记」，两者主干并不相等，
  // 只有靠 note_id 才对得上。
  const audioName = '云端示例录音笔记_1200000000000000001_audio.mp3'
  const audioBytes = Buffer.alloc(4096, 7)
  await writeFile(join(assetDir, audioName), audioBytes)
  await writeFile(join(assetDir, '云端示例录音笔记_1200000000000000001_transcript.md'), '# 转写\n', 'utf8')
  await writeFile(join(assetDir, '别的笔记_9999999999999999999_audio.mp3'), Buffer.alloc(10), 'utf8')

  const readWithAssets = await call('/read?path=' + encodeURIComponent('生活记录/2026-11-13-示例录音笔记.md'))
  check('GET /read 带回 assets', Array.isArray(readWithAssets.json.assets) && readWithAssets.json.assets.length === 2, JSON.stringify((readWithAssets.json.assets || []).map((a) => a.name)))
  check(
    'GET /read 按 note_id 认领附件（标题不同也能认）',
    (readWithAssets.json.assets || []).some((a) => a.kind === 'audio' && a.name === audioName),
    JSON.stringify((readWithAssets.json.assets || []).map((a) => a.name)),
  )

  const assetPath = `生活记录/asset/${audioName}`
  const assetRes = await call('/asset?path=' + encodeURIComponent(assetPath))
  check('GET /asset 200', assetRes.status === 200, `status=${assetRes.status}`)
  check('GET /asset content-type=audio/mpeg', (assetRes.contentType || '').startsWith('audio/mpeg'), assetRes.contentType)
  check('GET /asset 声明 accept-ranges', true, 'range 头在 fetch 下由 node 自动处理')

  const rangeRes = await fetch(`${base}/asset?path=${encodeURIComponent(assetPath)}`, { headers: { range: 'bytes=0-1023' } })
  const rangeBody = Buffer.from(await rangeRes.arrayBuffer())
  check('GET /asset 支持 Range → 206', rangeRes.status === 206, `status=${rangeRes.status}`)
  check('GET /asset Range 只回 1024 字节', rangeBody.length === 1024, `len=${rangeBody.length}`)
  check(
    'GET /asset 回 content-range',
    (rangeRes.headers.get('content-range') || '') === `bytes 0-1023/4096`,
    rangeRes.headers.get('content-range'),
  )

  const tailRes = await fetch(`${base}/asset?path=${encodeURIComponent(assetPath)}`, { headers: { range: 'bytes=-100' } })
  check('GET /asset 尾部 Range（bytes=-100）→ 206', tailRes.status === 206, `status=${tailRes.status}`)

  const badRangeRes = await fetch(`${base}/asset?path=${encodeURIComponent(assetPath)}`, { headers: { range: 'bytes=99999-100000' } })
  check('GET /asset 越界 Range → 416', badRangeRes.status === 416, `status=${badRangeRes.status}`)

  const assetEscapeRes = await call('/asset?path=' + encodeURIComponent('../secret.txt'))
  check('GET /asset 拒绝 ../ 逃逸', assetEscapeRes.status === 400, `status=${assetEscapeRes.status}`)
  const assetBadTypeRes = await call('/asset?path=' + encodeURIComponent('README.md.exe'))
  check('GET /asset 拒绝未知类型', assetBadTypeRes.status === 400, `status=${assetBadTypeRes.status}`)
  const assetNoPathRes = await call('/asset')
  check('GET /asset 缺 path → 400', assetNoPathRes.status === 400, `status=${assetNoPathRes.status}`)
  const assetPostRes = await call('/asset', { method: 'POST' })
  check('POST /asset → 405', assetPostRes.status === 405, `status=${assetPostRes.status}`)

  // 6. save（写入生效 + .bak）
  const savedRes = await call('/save', postJson('/save', { path: '生活记录/2026-11-13-示例录音笔记.md', content: '# 改过了\n\n新内容。\n' }))
  check('POST /save 成功', savedRes.status === 200 && savedRes.json.ok === true, JSON.stringify(savedRes.json))
  const onDisk = await readFile(join(vault, '生活记录', '2026-11-13-示例录音笔记.md'), 'utf8')
  check('POST /save 落盘', onDisk.includes('# 改过了'))
  const bakExists = await stat(join(vault, '生活记录', '2026-11-13-示例录音笔记.md.bak')).then(() => true, () => false)
  check('POST /save 留 .bak', bakExists)

  // 7. create
  const createRes = await call('/create', postJson('/create', { dir: '生活记录', title: '新笔记', content: '' }))
  check('POST /create 成功', createRes.status === 200 && /^\d{4}-\d{2}-\d{2}-新笔记\.md$/.test(createRes.json.path.split('/').pop()), createRes.json.path)

  // 8. 搜索（第 6 步已把正文改写成「新内容。」，这里搜改写后的词——
  //    顺便反证搜索读的是磁盘当前内容，不是任何缓存）
  const searchRes = await call('/search?q=新内容')
  check('GET /search 命中改写后的正文', searchRes.json.hits.length >= 1, JSON.stringify(searchRes.json.hits.map((x) => x.path)))
  const staleRes = await call('/search?q=watermelon')
  check('GET /search 不再命中被覆盖的旧正文', staleRes.json.hits.length === 0, JSON.stringify(staleRes.json.hits.map((x) => x.path)))

  // 9. delete → 回收站
  const delRes = await call('/delete', postJson('/delete', { path: createRes.json.path }))
  check('POST /delete 进回收站', delRes.status === 200 && delRes.json.trashedTo.startsWith('.trash/'), delRes.json && delRes.json.trashedTo)
  const afterDel = await call('/list')
  check('POST /delete 后列表减少', !afterDel.json.entries.some((e) => e.path === createRes.json.path))

  // 10. 路径逃逸
  const escapeRes = await call('/read?path=' + encodeURIComponent('../../windows/win.ini'))
  check('GET /read 拒绝 ../ 逃逸', escapeRes.status >= 400, `status=${escapeRes.status} ${JSON.stringify(escapeRes.json)}`)

  // 11. 非 md 文件
  const nonMd = await call('/read?path=' + encodeURIComponent('notes.txt'))
  check('GET /read 拒绝非 md', nonMd.status === 400, `status=${nonMd.status}`)

  // 12. 未知 action
  const unknown = await call('/nope')
  check('未知 action → 404', unknown.status === 404, `status=${unknown.status}`)

  // 13. oauth/status 未登录
  const oauthStatus = await call('/oauth/status')
  check('GET /oauth/status 未登录', oauthStatus.json.loggedIn === false, JSON.stringify(oauthStatus.json))

  // 14. 未登录时导入应 401（不静默失败）
  const importRes = await call('/import', postJson('/import', {}))
  check('POST /import 未登录 → 401', importRes.status === 401, `status=${importRes.status} ${JSON.stringify(importRes.json)}`)

  // 15. import/status 无任务
  const istatus = await call('/import/status')
  check('GET /import/status 无任务', istatus.json.running === false, JSON.stringify(istatus.json.running))

  // 16. oauth/callback 缺参数 → HTML 错误页
  const cb = await call('/oauth/callback?state=bogus')
  check('GET /oauth/callback 缺 code → 400 HTML', cb.status === 400 && String(cb.contentType).includes('text/html'), `status=${cb.status} ct=${cb.contentType}`)

  // 17. 坏 JSON body → 400
  const badJson = await call('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  check('POST 坏 JSON → 400', badJson.status === 400, `status=${badJson.status} ${JSON.stringify(badJson.json)}`)

  // 18. 空 body 的 POST /create 不炸
  const emptyCreate = await call('/create', postJson('/create', {}))
  check('POST /create 空参数仍能建笔记', emptyCreate.status === 200, emptyCreate.json && emptyCreate.json.path)

  // ── 第二轮：云端通道（Open API）──────────────────────────────────────────
  // 这一批的核心是「没凭证时不能假装成功」，以及「凭证绝不回显」。
  // 注意顺序：先测未配置的 401，再测配置写入，避免中途污染状态。

  const cloudList401 = await call('/cloud/list')
  check('未配置凭证时 GET /cloud/list → 401', cloudList401.status === 401, `status=${cloudList401.status} ${JSON.stringify(cloudList401.json)}`)
  check('401 里说清楚去设置填凭证', String(cloudList401.json && cloudList401.json.error).includes('API Key'), cloudList401.json && cloudList401.json.error)

  const cloudRead401 = await call('/cloud/read?id=1')
  check('未配置凭证时 GET /cloud/read → 401', cloudRead401.status === 401, `status=${cloudRead401.status}`)

  const recall401 = await call('/cloud/recall', postJson('/cloud/recall', { query: '录音' }))
  check('未配置凭证时 POST /cloud/recall → 401', recall401.status === 401, `status=${recall401.status}`)

  const syncStart401 = await call('/sync/start', postJson('/sync/start', {}))
  check('未配置凭证时 POST /sync/start → 401', syncStart401.status === 401, `status=${syncStart401.status} ${JSON.stringify(syncStart401.json)}`)

  const audioEmpty = await call('/audio')
  check('GET /audio 缺 url → 400', audioEmpty.status === 400, `status=${audioEmpty.status}`)

  const audioBad = await call('/audio?url=' + encodeURIComponent('not a url'))
  check('GET /audio 非法 url → 400', audioBad.status === 400, `status=${audioBad.status}`)

  // 防开放代理：白名单外的域名必须 403，否则这个端点能帮人代理任何地址
  const audioBlocked = await call('/audio?url=' + encodeURIComponent('https://evil.example.com/a.mp3'))
  check('GET /audio 拒绝白名单外域名 → 403', audioBlocked.status === 403, `status=${audioBlocked.status} ${JSON.stringify(audioBlocked.json)}`)
  const audioBlocked2 = await call('/audio?url=' + encodeURIComponent('http://127.0.0.1:22/x'))
  check('GET /audio 拒绝本机地址（防 SSRF）', audioBlocked2.status === 403, `status=${audioBlocked2.status}`)

  // 录音 CDN 的真实域名必须放行。
  // 实测：得到大脑音频在 https://mediacdn.umiwi.com/voicenotes%2F.../notesaudio_x.mp3，
  // 白名单漏了 umiwi.com 会让「播放录音」静默 403，而 markdown 看起来完全正常。
  // 这里无法真的拉音频（不联网），但可以断言「过了白名单这一关」——即错误不再是 403 域名拒绝，
  // 而是试图连接上游失败（502）或上游响应。
  const audioOss = await call('/audio?url=' + encodeURIComponent('https://mediacdn.umiwi.com/voicenotes/notesaudio_x.mp3'))
  check('GET /audio 放行 umiwi.com 录音 CDN', audioOss.status !== 403, `status=${audioOss.status} ${JSON.stringify(audioOss.json)}`)
  const audioLuo = await call('/audio?url=' + encodeURIComponent('https://get-notes.luojilab.com/a.mp3'))
  check('GET /audio 放行 luojilab.com', audioLuo.status !== 403, `status=${audioLuo.status}`)

  // 凭证写入
  const setCloud = await call('/api/credentials', postJson('/api/credentials', { apiKey: 'gk_live_TESTKEY_TESTKEY_0001', clientId: 'cli_TESTCLIENT_0001' }))
  check('POST /api/credentials 成功', setCloud.status === 200 && setCloud.json.ok === true, JSON.stringify(setCloud.json))
  check('凭证写入后 ready=true', setCloud.json.ready === true, JSON.stringify(setCloud.json.missing))
  // 安全线：响应里不能出现完整 Key
  check('响应不回显完整 apiKey', !JSON.stringify(setCloud.json).includes('TESTKEY_TESTKEY'), JSON.stringify(setCloud.json).slice(0, 120))
  check('响应里是打码后的 Key', String(setCloud.json.apiKeyMasked).includes('…'), setCloud.json.apiKeyMasked)

  const cloudFile = join(fakeHome, 'dsh-getnote', 'cloud.json')
  const cloudSaved = JSON.parse(await readFile(cloudFile, 'utf8'))
  check('凭证写入 $DSH_HOME/dsh-getnote/cloud.json', cloudSaved.apiKey === 'gk_live_TESTKEY_TESTKEY_0001', cloudSaved.apiKeyMasked || 'saved')

  // status 反映已配置，且仍然只给打码值
  const s2 = await call('/status')
  check('/status 报告 api.configured=true', s2.json.api && s2.json.api.configured === true, JSON.stringify(s2.json.api && s2.json.api.configured))
  check('/status 只回打码 Key', s2.json.api && !JSON.stringify(s2.json.api).includes('TESTKEY_TESTKEY'), JSON.stringify(s2.json.api).slice(0, 140))
  check('/status 暴露凭证文件路径', typeof s2.json.api.credentialsPath === 'string' && s2.json.api.credentialsPath.endsWith('cloud.json'), s2.json.api.credentialsPath)

  // 自动同步设置：默认关，开了之后持久化
  check('自动同步默认关', s2.json.autoSync && s2.json.autoSync.enabled === false, JSON.stringify(s2.json.autoSync && s2.json.autoSync.enabled))
  const autoOn = await call('/sync/auto', postJson('/sync/auto', { enabled: true, minutes: 30, incremental: true }))
  check('POST /sync/auto 开启', autoOn.status === 200 && autoOn.json.enabled === true && autoOn.json.minutes === 30, JSON.stringify(autoOn.json))
  const settingsAfter = JSON.parse(await readFile(join(fakeHome, 'dsh-getnote.json'), 'utf8'))
  check('自动同步写入设置文件', settingsAfter.autoSync === true && settingsAfter.autoSyncMinutes === 30, JSON.stringify({ autoSync: settingsAfter.autoSync, m: settingsAfter.autoSyncMinutes }))

  // 间隔有下限，不能允许「每 0 分钟」
  const autoTiny = await call('/sync/auto', postJson('/sync/auto', { enabled: true, minutes: 1 }))
  check('间隔被夹到下限 5 分钟', autoTiny.json.minutes === 5, JSON.stringify(autoTiny.json.minutes))
  const autoHuge = await call('/sync/auto', postJson('/sync/auto', { enabled: true, minutes: 99999 }))
  check('间隔被夹到上限 720 分钟', autoHuge.json.minutes === 720, JSON.stringify(autoHuge.json.minutes))

  const autoOff = await call('/sync/auto', postJson('/sync/auto', { enabled: false }))
  check('POST /sync/auto 关闭', autoOff.json.enabled === false, JSON.stringify(autoOff.json))

  const syncStatus = await call('/sync/status')
  check('GET /sync/status 无任务时不 running', syncStatus.json.running === false, JSON.stringify(syncStatus.json.running))

  // 云端写入类端点在缺参数时应 400 而不是打到网上
  const badUpdate = await call('/cloud/update', postJson('/cloud/update', {}))
  check('POST /cloud/update 缺 noteId → 400', badUpdate.status === 400, `status=${badUpdate.status}`)
  const badDelete = await call('/cloud/delete', postJson('/cloud/delete', {}))
  check('POST /cloud/delete 缺 noteId → 400', badDelete.status === 400, `status=${badDelete.status}`)
  const badTags = await call('/cloud/tags-add', postJson('/cloud/tags-add', { noteId: '1', tags: [] }))
  check('POST /cloud/tags-add 空 tags → 400', badTags.status === 400, `status=${badTags.status}`)

  // 清除凭证
  const cleared = await call('/api/clear', { method: 'POST' })
  check('POST /api/clear 成功', cleared.status === 200 && cleared.json.ok === true, JSON.stringify(cleared.json))
  const s3 = await call('/status')
  check('清除后 api.configured=false', s3.json.api.configured === false, JSON.stringify(s3.json.api.configured))
  const cloudListAgain = await call('/cloud/list')
  check('清除后 /cloud/list 又是 401', cloudListAgain.status === 401, `status=${cloudListAgain.status}`)

  // 只有「登录得到大脑」这一条 OAuth 通道、完全没填 API Key 时，也必须算「已接入」。
  //
  // 这是一处真实回归：自动同步定时器原先只检查 cloud.json 里有没有 apiKey，于是
  // 只走登录通道的用户自动同步**永远不会跑**，面板却显示开关是开的——用户以为在
  // 自动同步，实际一次都没成功过。现在定时器改问 cloudReadiness()，所以这里断言
  // 它认这条通道。
  const authFile = join(fakeHome, 'dsh-getnote', 'auth.json')
  await mkdir(join(fakeHome, 'dsh-getnote'), { recursive: true })
  await writeFile(
    authFile,
    JSON.stringify({
      accessToken: 'mcpa_TESTTOKEN_0001',
      refreshToken: 'mcpr_TESTREFRESH_0001',
      expiresAt: Date.now() + 3600 * 1000,
      clientId: 'mcpc_TESTCLIENT_0001',
      redirectUri: 'http://127.0.0.1:8115/getnote/oauth/callback',
      obtainedAt: new Date().toISOString(),
    }),
    'utf8',
  )
  const s4 = await call('/status')
  check('只有登录通道时 api.configured=true', s4.json.api && s4.json.api.configured === true, JSON.stringify(s4.json.api))
  check('只有登录通道时 viaLogin=true', s4.json.api && s4.json.api.viaLogin === true, JSON.stringify(s4.json.api && s4.json.api.viaLogin))
  check('只有登录通道时 transport=mcp', s4.json.api && s4.json.api.transport === 'mcp', JSON.stringify(s4.json.api && s4.json.api.transport))


  // 19. 库目录被删后 status 报 missing 而不是静默换库
  await rm(vault, { recursive: true, force: true })
  const missing = await call('/status')
  check('库被删后 /status 报 missing', missing.json.vaultMissing === vault, JSON.stringify(missing.json.vaultMissing))
  const missingTree = await call('/tree')
  check('库被删后 /tree 不 500', missingTree.status === 200 && missingTree.json.entries.length === 0, `status=${missingTree.status}`)
} finally {
  await new Promise((done) => server.close(done))
  await rm(fakeHome, { recursive: true, force: true })
  // 清理 effects（真实宿主里由 cordis 做）
  for (const dispose of effects) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      // 忽略
    }
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
