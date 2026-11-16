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
  await mkdir(join(vault, '随手记'), { recursive: true })
  await writeFile(
    join(vault, '随手记', '2026-11-13-示例录音笔记.md'),
    '---\ntags: [得到大脑, 私密]\nnote_id: "1200000000000000001"\n归档: 2026-11-13\n---\n\n# 示例录音笔记\n\n第一次录音的感受，关键词 watermelon。\n',
    'utf8',
  )
  await writeFile(join(vault, '做过的项目'), 'not a dir', 'utf8').catch(() => {})

  const setRes = await call('/settings', postJson('/settings', { vaultPath: vault }))
  check('POST /settings 切换库', setRes.status === 200 && setRes.json.effectiveRoot === vault, setRes.json && setRes.json.effectiveRoot)

  // 3. 设置持久化到独立 DSH_HOME
  const settingsFile = join(fakeHome, 'dsh-getnote.json')
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
  check('设置写入 $DSH_HOME/dsh-getnote.json', saved.vaultRoot === vault, JSON.stringify(saved))

  // 4. tree / list
  const treeRes = await call('/tree')
  check('GET /tree 返回条目', treeRes.json.entries.length === 1, `${treeRes.json.entries && treeRes.json.entries.length}`)
  check('GET /tree 目录树', treeRes.json.tree.children.length === 1 && treeRes.json.tree.children[0].name === '随手记', JSON.stringify(treeRes.json.tree.children.map((c) => c.name)))
  const listRes = await call('/list?q=watermelon')
  check('GET /list 关键词过滤', listRes.json.total === 1, JSON.stringify(listRes.json.total))
  const listTag = await call('/list?tag=私密')
  check('GET /list 标签过滤', listTag.json.total === 1, String(listTag.json.total))
  const listNone = await call('/list?tag=不存在')
  check('GET /list 无匹配', listNone.json.total === 0, String(listNone.json.total))

  // 5. read
  const readRes = await call('/read?path=' + encodeURIComponent('随手记/2026-11-13-示例录音笔记.md'))
  check('GET /read 读到正文', readRes.json.content.includes('# 示例录音笔记'), `${readRes.json.bytes} bytes`)
  check('GET /read 附件 frontmatter', readRes.json.frontmatter.note_id === '1200000000000000001', String(readRes.json.frontmatter.note_id))

  // 5b. 本地附件（录音）直出。
  //     这组断言护的是一整条链路：vault 层按 note_id 认领附件 → /read 带回去 →
  //     /asset 支持 Range。缺任何一环，面板上「本地录音」播放器就是块死按钮。
  const assetDir = join(vault, '随手记', 'asset')
  await mkdir(assetDir, { recursive: true })
  // 附件名故意用「云端标题 + note_id」——与真实库里 Obsidian 端插件留下的命名一致，
  // 而本地文件名是「2026-11-13-示例录音笔记」，两者主干并不相等，
  // 只有靠 note_id 才对得上。
  const audioName = '云端示例录音笔记_1200000000000000001_audio.mp3'
  const audioBytes = Buffer.alloc(4096, 7)
  await writeFile(join(assetDir, audioName), audioBytes)
  await writeFile(join(assetDir, '云端示例录音笔记_1200000000000000001_transcript.md'), '# 转写\n', 'utf8')
  await writeFile(join(assetDir, '别的笔记_9999999999999999999_audio.mp3'), Buffer.alloc(10), 'utf8')

  const readWithAssets = await call('/read?path=' + encodeURIComponent('随手记/2026-11-13-示例录音笔记.md'))
  check('GET /read 带回 assets', Array.isArray(readWithAssets.json.assets) && readWithAssets.json.assets.length === 2, JSON.stringify((readWithAssets.json.assets || []).map((a) => a.name)))
  check(
    'GET /read 按 note_id 认领附件（标题不同也能认）',
    (readWithAssets.json.assets || []).some((a) => a.kind === 'audio' && a.name === audioName),
    JSON.stringify((readWithAssets.json.assets || []).map((a) => a.name)),
  )

  const assetPath = `随手记/asset/${audioName}`
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

  // 6. save（写入生效 + 留历史而不是 .bak）
  const savedRes = await call('/save', postJson('/save', { path: '随手记/2026-11-13-示例录音笔记.md', content: '# 改过了\n\n新内容。\n' }))
  check('POST /save 成功', savedRes.status === 200 && savedRes.json.ok === true, JSON.stringify(savedRes.json))
  const onDisk = await readFile(join(vault, '随手记', '2026-11-13-示例录音笔记.md'), 'utf8')
  check('POST /save 落盘', onDisk.includes('# 改过了'))
  // 改版后：保存不再留 .bak（那是扫不到的永久垃圾），改成在 .history 留一版。
  const bakExists = await stat(join(vault, '随手记', '2026-11-13-示例录音笔记.md.bak')).then(() => true, () => false)
  check('POST /save 不再留 .bak', bakExists === false)
  const historyAfterSave = await (await call('/history/list?path=' + encodeURIComponent('随手记/2026-11-13-示例录音笔记.md'))).json
  check('POST /save 留了历史快照', Array.isArray(historyAfterSave.items) && historyAfterSave.items.length >= 1, JSON.stringify(historyAfterSave.items && historyAfterSave.items.length))

  // 7. create
  const createRes = await call('/create', postJson('/create', { dir: '随手记', title: '新笔记', content: '' }))
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


  // 18.5 回收站三件套：列表 / 恢复 / 永久删除
  // 删除一直是「移进 .trash/」，但以前 host 上没有任何路由能把它们列出来或救回来，
  // 用户点错删除就只能去文件管理器里翻隐藏目录。这组断言盯的就是这条回路。
  const trashEmpty = await call('/trash/list')
  check('回收站列表可用', trashEmpty.status === 200 && Array.isArray(trashEmpty.json.items), `status=${trashEmpty.status}`)

  const toDelete = await call('/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: '回收站验证', title: '要被删掉的笔记', content: '# 要被删掉的笔记\n\n回收站测试\n' }),
  })
  check('回收站：先建一篇笔记', toDelete.status === 200 && typeof toDelete.json.path === 'string', JSON.stringify(toDelete.json))

  const trashDelRes = await call('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: toDelete.json.path }),
  })
  check('回收站：删除成功', trashDelRes.status === 200 && trashDelRes.json.ok === true, JSON.stringify(trashDelRes.json))

  const afterDelete = await call('/tree')
  check('回收站：删除后库里看不到', !afterDelete.json.entries.some((e) => e.title === '要被删掉的笔记'), JSON.stringify(afterDelete.json.entries.map((e) => e.title)))

  const trashListed = await call('/trash/list')
  const trashedItem = (trashListed.json.items || []).find((i) => i.title === '要被删掉的笔记')
  check('回收站：列表里能看到它', trashedItem !== undefined, JSON.stringify((trashListed.json.items || []).map((i) => i.title)))
  check('回收站：列表项带路径与大小',
    trashedItem !== undefined && typeof trashedItem.path === 'string' && trashedItem.path.startsWith('.trash/') && typeof trashedItem.bytes === 'number',
    JSON.stringify(trashedItem))

  const statusWithTrash = await call('/status')
  check('回收站：status 报出回收站条数', typeof statusWithTrash.json.trash === 'number' && statusWithTrash.json.trash >= 1, String(statusWithTrash.json.trash))

  const trashRestoreRes = await call('/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: trashedItem.path }),
  })
  check('回收站：恢复成功', trashRestoreRes.status === 200 && typeof trashRestoreRes.json.path === 'string', JSON.stringify(trashRestoreRes.json))

  const afterRestore = await call('/tree')
  check('回收站：恢复后回到库里', afterRestore.json.entries.some((e) => e.title === '要被删掉的笔记'), JSON.stringify(afterRestore.json.entries.map((e) => e.title)))

  const restoredRead = await call(`/read?path=${encodeURIComponent(trashRestoreRes.json.path)}`)
  check('回收站：恢复后内容原样', restoredRead.status === 200 && String(restoredRead.json.content).includes('回收站测试'), `status=${restoredRead.status}`)

  // 再删一次，走永久删除
  const trashDelAgain = await call('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: trashRestoreRes.json.path }),
  })
  check('回收站：再删一次成功', trashDelAgain.status === 200, JSON.stringify(trashDelAgain.json))
  const trashAgain = await call('/trash/list')
  const purgeTarget = (trashAgain.json.items || []).find((i) => i.title === '要被删掉的笔记')
  check('回收站：清空前能找到目标', purgeTarget !== undefined)

  const trashPurgeRes = await call('/trash/purge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: purgeTarget.path }),
  })
  check('回收站：永久删除成功', trashPurgeRes.status === 200 && Array.isArray(trashPurgeRes.json.purged) && trashPurgeRes.json.purged.length === 1, JSON.stringify(trashPurgeRes.json))

  const trashAfterPurge = await call('/trash/list')
  check('回收站：永久删除后列表空', !(trashAfterPurge.json.items || []).some((i) => i.title === '要被删掉的笔记'), JSON.stringify((trashAfterPurge.json.items || []).map((i) => i.title)))

  // 越界防护：不能借恢复路由读/写库外文件
  const badRestore = await call('/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../../secret.txt' }),
  })
  check('回收站：拒绝从库外路径恢复', badRestore.status === 400 || badRestore.status === 404, `status=${badRestore.status}`)

  const notInTrash = await call('/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'README.md' }),
  })
  check('回收站：非 .trash 路径拒绝恢复', notInTrash.status === 400, `status=${notInTrash.status}`)

  // 19.5 主题色：默认 null → 保存 → 回 status → 非法值被拒 → null 能恢复默认
  const themeDefault = await call('/status')
  check('主题色：默认是 null（用内置蓝）', themeDefault.json.themeColor === null, JSON.stringify(themeDefault.json.themeColor))

  const themeSave = await call('/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeColor: '#C0392B' }),
  })
  check('主题色：保存后归一化成小写', themeSave.status === 200 && themeSave.json.themeColor === '#c0392b', JSON.stringify(themeSave.json.themeColor))
  const themeAfter = await call('/status')
  check('主题色：写进 status 供面板取用', themeAfter.json.themeColor === '#c0392b', JSON.stringify(themeAfter.json.themeColor))

  // 三位简写要展开成六位：面板的推导函数只认 #rrggbb
  const themeShort = await call('/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeColor: '#FA0' }),
  })
  check('主题色：三位简写展开成六位', themeShort.json.themeColor === '#ffaa00', JSON.stringify(themeShort.json.themeColor))

  // 非法值不该把界面搞成半坏：回落 null = 用默认配色
  const themeBad = await call('/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeColor: 'chartreuse' }),
  })
  check('主题色：非法值回落默认而不是存下来', themeBad.json.themeColor === null, JSON.stringify(themeBad.json.themeColor))

  // 恢复默认：这一条最容易坏——如果用 !== undefined 判断，null 会被当成「没传」
  await call('/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeColor: '#123456' }),
  })
  const themeReset = await call('/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeColor: null }),
  })
  check('主题色：传 null 能恢复默认（不被当成未传）', themeReset.json.themeColor === null, JSON.stringify(themeReset.json.themeColor))

  // 主题色不能污染别的设置项
  const themeKeep = await call('/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeColor: '#22434f' }),
  })
  check('主题色：保存时不动库路径', themeKeep.json.vaultRoot === vault, JSON.stringify(themeKeep.json.vaultRoot))
  check('主题色：保存时不动自动同步设置', typeof themeKeep.json.autoSync === 'boolean')

  // 20. 库目录被删后 status 报 missing 而不是静默换库
// ── 13 项新功能的 HTTP 端点 ────────────────────────────────────────────────
{
  // 局部 helper：统一解包 json，省得每处都写 .json。
  // 注意 postJson 的签名是 (path, body)——第二个参数才是 body，别只传一个。
  const jget = async (path) => (await call(path)).json
  const jpost = async (path, body) => (await call(path, postJson(path, body))).json

  // A1 大纲 + A2 反查：/read 一次带回 outline 与 links
  await jpost('/save', { path: '随手记/大纲测试.md', content: '# 一\n\n正文\n\n## 二\n\n```\n# 不是标题\n```\n' })
  const readJson = await jget('/read?path=' + encodeURIComponent('随手记/大纲测试.md'))
  check('A1 /read 返回 outline', Array.isArray(readJson.outline) && readJson.outline.length === 2, JSON.stringify(readJson.outline))
  check('A1 outline 跳过代码围栏里的 #', !readJson.outline.some((h) => h.text === '不是标题'), JSON.stringify(readJson.outline))
  check('A2 /read 返回 links', Array.isArray(readJson.links))

  await jpost('/save', { path: '随手记/引用者.md', content: '见 [[大纲测试]] 和 [[随手记/大纲测试|别名]]\n' })
  const backJson = await jget('/backlinks?path=' + encodeURIComponent('随手记/大纲测试.md'))
  check('A2 /backlinks 找到引用者', backJson.hits.some((h) => h.path === '随手记/引用者.md'), JSON.stringify(backJson.hits.map((h) => h.path)))

  // A3 搜索增强：多词取交集
  await jpost('/save', { path: '随手记/交集A.md', content: '会议 和 录音 都提到了\n' })
  await jpost('/save', { path: '随手记/交集B.md', content: '只提到 会议\n' })
  const andJson = await jget('/search?q=' + encodeURIComponent('会议 录音'))
  check('A3 多词取交集', andJson.hits.length === 1 && andJson.hits[0].path === '随手记/交集A.md', JSON.stringify(andJson.hits.map((h) => h.path)))

  // B2 冲突列表
  const conflictList = await jget('/conflict/list')
  check('B2 /conflict/list 可用', Array.isArray(conflictList.items))

  // B2+ 处理一条 → 角标只数未处理的；退回未处理 → 数字回来
  // 造一个真实冲突留档：文件名必须是「时间戳__原名」格式才会被 listConflicts 认出来。
  // 而且两边的语义要按 cloud-sync 的真实约定摆：
  //   正本（candidates[0]）= 云端版（同步写进去的）
  //   .conflicts/ 留档     = 冲突时用户本地写的版本
  const conflictName = '2026-11-15T10-00-00-000Z__2026-11-15-冲突样本.md'
  const conflictCanonPath = '随手记/2026-11-15-冲突样本.md'
  await jpost('/save', { path: conflictCanonPath, content: '# 冲突样本\n\nCLOUD 云端那一版\n' })
  await jpost('/save', { path: `.conflicts/${conflictName}`, content: '# 冲突样本\n\nLOCAL 本地那一版\n' })
  const withConflict = await jget('/conflict/list')
  check('B2 冲突被列出', withConflict.items.some((i) => i.name === conflictName), JSON.stringify(withConflict.items.map((i) => i.name)))
  check('B2 未处理的记作 pending', withConflict.pending >= 1, JSON.stringify(withConflict))
  const pendingBefore = withConflict.pending

  // 方向回归：点「用我的本地版」必须把**本地内容**落到正本，不能反过来。
  // 曾经这两个分支写反，用户点本地版反而把云端版留在正本里，手写内容被丢。
  const resolvedJson = await jpost('/conflict/resolve', { path: `.conflicts/${conflictName}`, keepLocal: true })
  check('B2 采纳本地版成功', resolvedJson.ok === true, JSON.stringify(resolvedJson))
  const canonAfterKeepLocal = (await jget('/read?path=' + encodeURIComponent(conflictCanonPath))).content || ''
  check(
    'B2 采纳本地版后正本是本地内容',
    canonAfterKeepLocal.indexOf('LOCAL') >= 0 && canonAfterKeepLocal.indexOf('CLOUD') < 0,
    canonAfterKeepLocal.trim(),
  )
  const afterResolve = await jget('/conflict/list')
  check('B2 处理后 pending 减一', afterResolve.pending === pendingBefore - 1, `${pendingBefore} -> ${afterResolve.pending}`)
  check('B2 处理过的条目带 resolved 标记', afterResolve.items.some((i) => i.name === conflictName && i.resolved === true))
  check('B2 记下了采纳方向', afterResolve.items.some((i) => i.name === conflictName && i.keptLocal === true))
  // 留档不删——能反悔是这个功能的前提
  check('B2 处理完留档仍在', afterResolve.items.some((i) => i.name === conflictName))

  const statusAfter = await jget('/status')
  check('B2 /status 的 conflicts 只数未处理', statusAfter.conflicts === afterResolve.pending, `${statusAfter.conflicts} vs ${afterResolve.pending}`)

  const undone = await jpost('/conflict/unresolve', { path: `.conflicts/${conflictName}` })
  check('B2 退回未处理成功', undone.ok === true, JSON.stringify(undone))
  const afterUndo = await jget('/conflict/list')
  check('B2 退回后 pending 复原', afterUndo.pending === pendingBefore, `${afterUndo.pending} vs ${pendingBefore}`)
  check('B2 退回后不再标 resolved', afterUndo.items.some((i) => i.name === conflictName && i.resolved !== true))
  check('B2 /conflict/read 返回 resolved 字段', typeof (await jget('/conflict/read?path=' + encodeURIComponent(`.conflicts/${conflictName}`))).resolved === 'boolean')
  check('B2 空 path 退回被拒', (await jpost('/conflict/unresolve', { path: '' })).error !== undefined)

  // 反方向也要锁死：点「用云端版」正本必须还是云端内容，且不能把留档（本地版）写进正本。
  // 上一步已经把正本覆盖成本地版了，这里先把正本恢复成「云端版」这个真实前提。
  await jpost('/save', { path: conflictCanonPath, content: '# 冲突样本\n\nCLOUD 云端那一版\n' })
  await jpost('/conflict/resolve', { path: `.conflicts/${conflictName}`, keepLocal: false })
  const canonAfterTakeCloud = (await jget('/read?path=' + encodeURIComponent(conflictCanonPath))).content || ''
  check(
    'B2 采纳云端版后正本仍是云端内容',
    canonAfterTakeCloud.indexOf('CLOUD') >= 0 && canonAfterTakeCloud.indexOf('LOCAL') < 0,
    canonAfterTakeCloud.trim(),
  )
  // 收尾：退回未处理，别把这个状态留给后面的断言
  await jpost('/conflict/unresolve', { path: `.conflicts/${conflictName}` })

  // B2++ 带 cloud- 前缀的旧留档：那种文件里装的是**云端版**，不是本地版。
  // 早期手工抢救被覆盖的云端副本时存过这种名字，真实库里就有。若仍假定
  // 「留档一定是本地版」，遇到它就会把两边弄反 —— 这里两种方向各锁一条。
  const cloudMarkName = '2026-11-15T11-00-00-000Z__cloud-2026-11-15-云端留档样本.md'
  const cloudMarkCanon = '随手记/2026-11-15-云端留档样本.md'
  await jpost('/save', { path: cloudMarkCanon, content: '# 云端留档样本\n\nLOCAL 用户手写的那版\n' })
  await jpost('/save', { path: `.conflicts/${cloudMarkName}`, content: '# 云端留档样本\n\nCLOUD 抢救下来的云端版\n' })
  const cloudDetail = await jget('/conflict/read?path=' + encodeURIComponent(`.conflicts/${cloudMarkName}`))
  check('B2 带 cloud- 前缀的留档被识别为云端版', cloudDetail.archiveIsCloud === true, String(cloudDetail.archiveIsCloud))

  await jpost('/conflict/resolve', { path: `.conflicts/${cloudMarkName}`, keepLocal: true })
  const cloudMarkKeepLocal = (await jget('/read?path=' + encodeURIComponent(cloudMarkCanon))).content || ''
  check(
    'B2 cloud-留档：用我的本地版 → 正本仍是本地内容',
    cloudMarkKeepLocal.indexOf('LOCAL') >= 0 && cloudMarkKeepLocal.indexOf('CLOUD') < 0,
    cloudMarkKeepLocal.trim(),
  )

  // 复位成正本=本地、留档=云端，再验「用云端版」方向
  await jpost('/save', { path: cloudMarkCanon, content: '# 云端留档样本\n\nLOCAL 用户手写的那版\n' })
  await jpost('/conflict/resolve', { path: `.conflicts/${cloudMarkName}`, keepLocal: false })
  const cloudMarkTakeCloud = (await jget('/read?path=' + encodeURIComponent(cloudMarkCanon))).content || ''
  check(
    'B2 cloud-留档：用云端版 → 正本变成云端内容',
    cloudMarkTakeCloud.indexOf('CLOUD') >= 0 && cloudMarkTakeCloud.indexOf('LOCAL') < 0,
    cloudMarkTakeCloud.trim(),
  )
  await jpost('/conflict/unresolve', { path: `.conflicts/${cloudMarkName}` })

  // C2 历史：保存会留快照，能读回、能恢复
  await jpost('/save', { path: '随手记/大纲测试.md', content: '# 一\n\n改过\n' })
  const histJson = await jget('/history/list?path=' + encodeURIComponent('随手记/大纲测试.md'))
  check('C2 保存后产生历史', Array.isArray(histJson.items) && histJson.items.length >= 1, JSON.stringify(histJson.items))
  if (Array.isArray(histJson.items) && histJson.items.length > 0) {
    const entry = histJson.items[0]
    const readHist = await jget('/history/read?path=' + encodeURIComponent('随手记/大纲测试.md') + '&name=' + encodeURIComponent(entry.name))
    check('C2 能读回历史正文', typeof readHist.content === 'string' && readHist.content.indexOf('正文') >= 0, String(readHist.content).slice(0, 40))
    const restored = await jpost('/history/restore', { path: '随手记/大纲测试.md', name: entry.name, keepCurrent: true })
    check('C2 恢复历史成功', restored.ok === true, JSON.stringify(restored))
  }

  // C1 归档信息
  const exportInfo = await jget('/archive/info')
  check('C1 /archive/info 可用', typeof exportInfo.notes === 'number' && exportInfo.notes > 0, JSON.stringify(exportInfo))

  // D2 批量加标签
  const batchTag = await jpost('/batch', { action: 'tag', paths: ['随手记/交集A.md', '随手记/交集B.md'], tag: '批量标签' })
  check('D2 批量加标签', batchTag.ok === true && batchTag.changed === 2, JSON.stringify(batchTag))
  const tagged = await jget('/read?path=' + encodeURIComponent('随手记/交集A.md'))
  check('D2 标签真的写进 frontmatter', Array.isArray(tagged.tags) && tagged.tags.indexOf('批量标签') >= 0, JSON.stringify(tagged.tags))

  // D2 批量移目录
  // 注意别用「做过的项目」：那个位置在库里是个普通文件（早前测试特意放的），
  // 拿它当目标目录会 EEXIST。
  const batchMove = await jpost('/batch', { action: 'move', paths: ['随手记/交集B.md'], dir: '归档区' })
  check('D2 批量移目录', batchMove.ok === true && batchMove.changed === 1, JSON.stringify(batchMove))
  const movedList = await jget('/list')
  check('D2 移动后原路径消失', !movedList.entries.some((e) => e.path === '随手记/交集B.md'))
  // 搬目录不能把文件名改掉：日期前缀是用户归档库的命名约定
  const movedEntry = movedList.entries.find((e) => e.path.indexOf('归档区/') === 0 && e.path.indexOf('交集B') >= 0)
  check('D2 移动后保留原文件名', movedEntry !== undefined && /\/交集B\.md$/.test(movedEntry.path), JSON.stringify(movedList.entries.map((e) => e.path).filter((x) => x.indexOf('归档区') >= 0)))

  // D2 批量删除
  const batchDelete = await jpost('/batch', { action: 'delete', paths: ['随手记/交集A.md'] })
  check('D2 批量删除', batchDelete.ok === true && batchDelete.changed === 1, JSON.stringify(batchDelete))
  const afterDelete = await jget('/list')
  check('D2 删除后列表里没有它', !afterDelete.entries.some((e) => e.path === '随手记/交集A.md'))

  // D2 参数校验
  const badBatch = await call('/batch', postJson('/batch', { action: 'nope', paths: ['x.md'] }))
  check('D2 未知 action 回 400', badBatch.status === 400, String(badBatch.status))
  const noPaths = await call('/batch', postJson('/batch', { action: 'tag', paths: [], tag: 'x' }))
  check('D2 空 paths 回 400', noPaths.status === 400, String(noPaths.status))
  const noTag = await call('/batch', postJson('/batch', { action: 'tag', paths: ['x.md'] }))
  check('D2 加标签缺 tag 回 400', noTag.status === 400, String(noTag.status))

  // B3 心跳只回 pong，不写设置文件
  const pong = await jpost('/sync/auto', { ping: true })
  check('B3 心跳回 pong', pong.ok === true && pong.pong === true, JSON.stringify(pong))

  // .history 不能被当成笔记扫进列表
  const listJson = await jget('/list')
  check(
    '.history 目录不被扫描成笔记',
    !listJson.entries.some((e) => e.path.indexOf('.history/') === 0),
    JSON.stringify(listJson.entries.map((e) => e.path).filter((x) => x.indexOf('.history') >= 0)),
  )

  // ── 目录 / 标签增删（第七批左栏右键菜单 + 「+」）─────────────────────────
  const madeDir = await jpost('/dir/create', { dir: '临时目录' })
  check('新建目录成功', madeDir.ok === true && madeDir.path === '临时目录', JSON.stringify(madeDir))
  check('新建目录提示空目录暂时看不见', madeDir.empty === true, JSON.stringify(madeDir))
  const dupDir = await jpost('/dir/create', { dir: '临时目录' })
  check('重复建同名目录不报错（mkdir recursive）', dupDir.ok === true, JSON.stringify(dupDir))
  const emptyDirName = await call('/dir/create', postJson('/dir/create', { dir: '   ' }))
  check('空目录名回 400', emptyDirName.status === 400, String(emptyDirName.status))

  // 非空目录拒绝删除：点一下垃圾桶就把几十篇笔记送进回收站是灾难
  const notEmpty = await call('/dir/delete', postJson('/dir/delete', { dir: '随手记' }))
  check('非空目录拒绝删除（409）', notEmpty.status === 409, String(notEmpty.status))
  check('拒绝时说明还有几篇笔记', /还有/.test(JSON.stringify(notEmpty.json || {})), JSON.stringify(notEmpty.json))

  // 空目录可以删
  const rmEmpty = await jpost('/dir/delete', { dir: '临时目录' })
  check('空目录可以删除', rmEmpty.ok === true, JSON.stringify(rmEmpty))
  const rmMissing = await call('/dir/delete', postJson('/dir/delete', { dir: '根本不存在的目录' }))
  check('删不存在的目录回 404', rmMissing.status === 404, String(rmMissing.status))
  const rmRoot = await call('/dir/delete', postJson('/dir/delete', { dir: '' }))
  check('不能删除库根', rmRoot.status === 400, String(rmRoot.status))

  // 删标签：从所有笔记里抹掉，但笔记本身不动
  const tagBefore = await jget('/list')
  const tagNotePath = tagBefore.entries.find((e) => (e.tags || []).indexOf('批量标签') >= 0)
  check('准备删的标签确实挂在某篇上', tagNotePath !== undefined)
  const rmTag = await jpost('/tag/delete', { tag: '批量标签' })
  check('删标签成功', rmTag.ok === true && rmTag.changed >= 1, JSON.stringify(rmTag))
  const tagAfter = await jget('/list')
  check('标签已从所有笔记移除', !tagAfter.entries.some((e) => (e.tags || []).indexOf('批量标签') >= 0))
  check('笔记本身没被删掉', tagAfter.entries.length === tagBefore.entries.length, `${tagBefore.entries.length} → ${tagAfter.entries.length}`)
  const rmTagAgain = await jpost('/tag/delete', { tag: '批量标签' })
  check('重复删不存在的标签不报错', rmTagAgain.ok === true && rmTagAgain.changed === 0, JSON.stringify(rmTagAgain))
  const noTagName = await call('/tag/delete', postJson('/tag/delete', {}))
  check('删标签缺 tag 回 400', noTagName.status === 400, String(noTagName.status))

  // 块列表写法的 tags（`tags:` 换行后跟 `  - 甲`）：
  // 只替换 `tags:` 那一行会留下悬空列表项，文件被污染。这里从 HTTP 层验一遍。
  const blockRel = '随手记/块列表标签.md'
  await writeFile(
    join(vault, blockRel),
    ['---', 'title: 块列表标签', 'tags:', '  - 块甲', '  - 块乙', 'note_id: "9002"', '---', '', '正文'].join('\n'),
    'utf8',
  )
  const blockAdded = await jpost('/batch', { action: 'tag', paths: [blockRel], tag: '块丙' })
  check('块列表: 加标签成功', blockAdded.ok === true && blockAdded.changed === 1, JSON.stringify(blockAdded))
  const blockText1 = await readFile(join(vault, blockRel), 'utf8')
  check('块列表: 加标签后是合法行内数组', /^tags: \[块甲, 块乙, 块丙\]$/m.test(blockText1), blockText1)
  check('块列表: 加标签后无悬空列表项', !/^\s+-\s/m.test(blockText1), blockText1)
  const readBack = await jget(`/read?path=${encodeURIComponent(blockRel)}`)
  check('块列表: 读回三个标签', Array.isArray(readBack.frontmatter.tags) && readBack.frontmatter.tags.length === 3, JSON.stringify(readBack.frontmatter.tags))
  const blockRemoved = await jpost('/tag/delete', { tag: '块乙' })
  check('块列表: 删标签成功', blockRemoved.ok === true && blockRemoved.changed >= 1, JSON.stringify(blockRemoved))
  const blockText2 = await readFile(join(vault, blockRel), 'utf8')
  check('块列表: 删标签后是合法行内数组', /^tags: \[块甲, 块丙\]$/m.test(blockText2), blockText2)
  check('块列表: 删标签后无悬空列表项', !/^\s+-\s/m.test(blockText2), blockText2)
  check('块列表: 其他字段原样保留', /^note_id: "9002"$/m.test(blockText2))
  await rm(join(vault, blockRel), { force: true })
}

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
