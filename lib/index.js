/**
 * dsh-getnote — host 半边
 *
 * 两件事：
 *   1. 挂 `/getnote/*` 路由到 DSH 自带的 webServer，给面板提供本地库的读写 API；
 *   2. 托管可选的云端一次性导入（OAuth 授权 + MCP 拉取），全部在 host 侧完成。
 *
 * 为什么数据不走 typert/remote 而走 HTTP 路由：本地库是纯文件系统操作，一个
 * `prefix` 路由加几个 JSON 端点就够，客户端 `fetch('/getnote/...')` 即可，不需要
 * 额外 peerDependency，也不会有「契约版本错配 → 面板打不开」这类故障面。
 *
 * 安全边界：所有文件路径都相对库根解析，并做包含性校验（见 vault.js
 * resolveInside）。云端凭证只存 $DSH_HOME，绝不回传给浏览器。
 */
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import {
  authPath,
  knownVaultCandidates,
  readAuth,
  readClient,
  clearAuth,
  resolveVaultRoot,
  setVaultRoot,
  settingsPath,
  updateSettings,
  readSettings,
  writeAuth,
  cloudPath,
  readCloud,
  writeCloud,
  clearCloud,
  maskSecret,
  readSyncState,
  writeSyncState,
  syncStatePath,
  normalizeAutoSync,
} from './settings.js'
import {
  buildTree,
  createNote,
  excerptOf,
  listAssets,
  listDirs,
  listTrash,
  parseFrontmatter,
  purgeTrash,
  readNote,
  resolveInside,
  restoreNote,
  scanVault,
  searchNotes,
  trashNote,
  vaultStats,
  writeNote,
} from './vault.js'
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  McpClient,
  refreshToken as refreshAccessToken,
  registerClient,
  revokeToken,
  ISSUER,
} from './biji.js'
import { importAllNotes, probeAccessToken } from './sync.js'
import { createClient as createOpenApiClient, normalizeNote } from './openapi.js'
import { createMcpCloudClient } from './mcp-cloud.js'
import { pushNote as pushLocalNote, runSync, syncSingleNote } from './cloud-sync.js'

export const ROUTE_PREFIX = '/getnote'

/** Pending OAuth 授权（state → { verifier, redirectUri, createdAt }）。进程内即可。 */
const pendingAuthorizations = new Map()

/**
 * 导入任务状态（进程内单例）。同一时刻只允许一个导入在跑：多个并发导入会把
 * 同一个 note_id 写两遍（createNote 会加 -2 后缀，变成重复文件）。
 */
const importState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lines: [],
  result: null,
  error: null,
}
const AUTH_TTL_MS = 15 * 60 * 1000
const MAX_BODY = 2 * 1024 * 1024 + 64 * 1024

/**
 * 自动同步的运行期状态（进程内单例）。
 *
 * 为什么和 importState 分开：import 是「一次性把历史搬过来」，只会跑一次；
 * 自动同步是常驻循环，会跑成百上千次。混在一起会让面板分不清「首次导入中」
 * 和「后台正在同步」。
 */
const syncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
  /** 自动同步的调度句柄：timer 服务返回的 disposer。 */
  timerDispose: null,
  /** 上一轮开跑的时间戳，用于跳过重叠触发。 */
  lastAttemptAt: 0,
}

/** 自动同步的最短间隔保护：任何情况下都不许比这更频繁地打云端。 */
const SYNC_MIN_GAP_MS = 60 * 1000

/** 音频流代理的路径前缀（`/getnote/audio?url=...`）。 */
/**
 * 允许代理的音频域名。
 *
 * umiwi.com 是实测出来的：得到大脑录音的真实 CDN 是
 * `https://mediacdn.umiwi.com/voicenotes%2F.../notesaudio_xxx.mp3?Expires=...&Signature=...`
 * （2026-11 实测直连 200 / audio/mp3）。漏了它，「播放录音」会 403 而 markdown 里
 * 看起来一切正常——这是最容易被漏掉的坑。
 */
const AUDIO_HOST_ALLOWLIST = ['biji.com', 'umiwi.com', 'luojilab.com', 'trytalks.com']

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(html)
}

function readBody(req, cap) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) {
        // 注意：不能 req.destroy()，否则 413 分支到不了客户端
        req.pause()
        rejectBody(Object.assign(new Error('request body too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => rejectBody(error))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
  })
}

async function readJsonBody(req, cap = 256 * 1024) {
  const text = await readBody(req, cap)
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw Object.assign(new Error('body must be valid JSON'), { status: 400 })
  }
}

/** 清理过期的 pending 授权。 */
function sweepPending() {
  const now = Date.now()
  for (const [state, entry] of pendingAuthorizations) {
    if (now - entry.createdAt > AUTH_TTL_MS) pendingAuthorizations.delete(state)
  }
}

/** 把内部异常转成可读响应：带 status 的按 status 回，其余归 500。 */
function fail(res, error) {
  const status = error && typeof error.status === 'number' ? error.status : 500
  const message = error && error.message ? error.message : 'internal error'
  send(res, status, { error: message })
}

/**
 * 有效令牌：过期则自动用 refresh_token 续期并落盘。
 * 续期失败就当作「未登录」，让面板引导用户重新授权（这正是会员到期后的路径）。
 */
async function ensureAccessToken({ allowRefresh = true } = {}) {
  const auth = await readAuth()
  if (!auth) return null
  const stillValid = auth.expiresAt > Date.now() + 60_000
  if (stillValid) return auth.accessToken
  if (!allowRefresh || !auth.refreshToken || !auth.clientId) return null
  try {
    const renewed = await refreshAccessToken({ clientId: auth.clientId, refreshToken: auth.refreshToken })
    const merged = {
      ...auth,
      ...renewed,
      refreshToken: renewed.refreshToken || auth.refreshToken,
      redirectUri: renewed.redirectUri || auth.redirectUri,
    }
    await writeAuth(merged)
    return merged.accessToken
  } catch {
    return null
  }
}

/** 一个已 initialize 的 MCP 客户端，失败时把原因原样抛出。 */
async function openClient() {
  const token = await ensureAccessToken()
  if (!token) {
    throw Object.assign(new Error('尚未登录得到大脑（或授权已过期），先在面板里点「登录并导入」'), { status: 401 })
  }
  const client = new McpClient(token)
  await client.initialize()
  return client
}

/**
 * 打开云端客户端。两条通道，能用的那条优先。
 *
 * 1. **Open API 通道**：用户自己填了 API Key 就用它。对外部使用者来说这是唯一
 *    干净的路（不依赖浏览器回跳），配额也更明确。
 * 2. **OAuth/MCP 通道**：面板里「登录得到大脑」拿到的令牌还在就直接用。这条路
 *    用户已经走过一遍，不需要再去控制台注册应用，装上就能播录音、改笔记、自动
 *    同步。实测它背后是 49 个工具的 MCP 端点，音频地址、逐字稿、章节、待办都在。
 *
 * 两条通道返回**同一组方法名**（见 mcp-cloud.js 顶部注释），所以下面所有 handler
 * 不需要知道当前走的是哪条。
 *
 * **为什么要做失败回落**：填了 Key 不等于 Key 有效——实测把未激活/无权限的 Key
 * 填进去，Open API 会稳定回 401 `unauthorized`，而这时候用户明明还登录着，MCP
 * 通道完全可用。如果因为一个填错的 Key 就让整个「云端」页签全线报错，用户看到
 * 的是「插件坏了」而不是「这个 Key 不对」。所以这里在 Open API 报 401 时自动改用
 * MCP，并把「你的 Key 被拒了」记在 lastKeyError 上，由 /status 显示出来。
 */
async function openCloudClient() {
  const cloud = await readCloud()
  const keyReady = cloud && cloud.apiKey !== '' && cloud.clientId !== ''
  const token = await ensureAccessToken()
  if (keyReady && !openApiRejected) {
    const openapi = createOpenApiClient({ apiKey: cloud.apiKey, clientId: cloud.clientId, grantId: cloud.grantId })
    if (!token) return openapi
    return guardOpenApi(openapi, () => createMcpCloudClient({ accessToken: token }))
  }
  if (token) return createMcpCloudClient({ accessToken: token })
  if (keyReady) {
    // Key 被拒过、又没有 MCP 兜底：仍然返回 Open API，让错误如实抛给用户
    return createOpenApiClient({ apiKey: cloud.apiKey, clientId: cloud.clientId, grantId: cloud.grantId })
  }
  throw Object.assign(
    new Error('还没有接入得到大脑。最省事的是去「同步」页点「登录得到大脑」（一次授权，之后自动同步）；也可以在「设置 → 云端接入」填 API Key 与 Client ID（在 openapi.biji.com 控制台创建）。'),
    { status: 401, reason: 'no_credentials' },
  )
}

/**
 * 给 Open API 客户端套一层「401 就换通道」。
 *
 * 只在**第一次调用**上试错（试到了就记下该用哪条），避免每个请求都先失败一次
 * 白白浪费一个配额和几百毫秒。
 *
 * 这个判断结果缓存在模块级 `openApiRejected` 上，而不是 client 实例上——因为
 * `openCloudClient()` 每个请求都会新建一个客户端，实例级的缓存等于没有缓存。
 */
let lastKeyError = null
/** 记住 Open API 的 Key 被拒这件事，后续请求直接走 MCP，不再先失败一次。 */
let openApiRejected = false

/** 用户改了凭证就要清掉这个记忆，否则换了正确的 Key 还会被旧结论挡住。 */
function resetKeyRejection() {
  openApiRejected = false
  lastKeyError = null
}

function guardOpenApi(openapi, makeFallback) {
  const state = { client: openapi, decided: false, fallbackMade: false }
  const wrap = (name) => async (...args) => {
    if (state.decided) return state.client[name](...args)
    try {
      const result = await state.client[name](...args)
      state.decided = true
      return result
    } catch (error) {
      const denied = error && (error.status === 401 || error.reason === 'invalid_api_key')
      if (!denied) {
        state.decided = true
        throw error
      }
      // 记到模块级：下一个请求就不用再试错了
      openApiRejected = true
      lastKeyError = error.message || 'API Key 被拒绝'
      if (!state.fallbackMade) {
        state.fallbackMade = true
        state.client = makeFallback()
      }
      state.decided = true
      return state.client[name](...args)
    }
  }
  const out = { transport: 'openapi' }
  for (const name of ['listNotes', 'getNote', 'listRecorderNotes', 'getRecorderNote', 'createNote', 'updateNote', 'deleteNote', 'taskProgress', 'addTags', 'deleteTag', 'listTopics', 'createTopic', 'listTopicNotes', 'browseTopic', 'addNotesToTopic', 'removeNotesFromTopic', 'recall', 'recallInTopic', 'createShareLink', 'getTranscript', 'getChapters', 'getTimeline', 'getTodos', 'getAttachments', 'getQuota', 'tool', 'request', 'headers']) {
    if (typeof openapi[name] === 'function') out[name] = wrap(name)
    else if (openapi[name] !== undefined) out[name] = openapi[name]
  }
  return out
}

/**
 * 当前云端通道的「就绪状态」，给 /status 用。
 *
 * 这里**不能**去 initialize MCP（那是网络请求，每刷新一次面板都握手不合适），
 * 所以只报「本地有没有凭证」，真实可用性由 /api/probe 按需验证。
 */
async function cloudReadiness() {
  const cloud = await readCloud()
  const keyReady = cloud && cloud.apiKey !== '' && cloud.clientId !== ''
  const auth = await readAuth()
  const tokenAlive = !!auth && typeof auth.expiresAt === 'number' && auth.expiresAt > Date.now() + 60_000
  const canRefresh = !!auth && !!auth.refreshToken && !!auth.clientId
  const loginReady = tokenAlive || canRefresh
  if (keyReady) {
    const rejected = lastKeyError !== null
    return {
      configured: true,
      // transport = 用户配置的通道；effective = 实际在用的通道。
      // Key 被拒后 guardOpenApi 会静默换到 MCP，面板要能看出这个差别。
      transport: 'openapi',
      effectiveTransport: rejected && loginReady ? 'mcp' : 'openapi',
      apiKeyMasked: maskSecret(cloud.apiKey),
      clientIdMasked: maskSecret(cloud.clientId),
      hasGrantId: cloud.grantId !== '',
      savedAt: cloud.savedAt || null,
      // Key 填了但被服务端拒过：面板要能把这句话显示出来，否则用户只会看到「接入成功」却满屏报错
      keyRejected: rejected,
      keyError: lastKeyError,
      fallbackAvailable: loginReady,
    }
  }
  if (loginReady) {
    return { configured: true, transport: 'mcp', effectiveTransport: 'mcp', apiKeyMasked: null, clientIdMasked: null, hasGrantId: false, savedAt: auth.obtainedAt || null, viaLogin: true, tokenAlive, keyRejected: false, keyError: null, fallbackAvailable: false }
  }
  return { configured: false, transport: null, effectiveTransport: null, apiKeyMasked: null, clientIdMasked: null, hasGrantId: false, savedAt: null, keyRejected: false, keyError: null, fallbackAvailable: false }
}

function createHandler(config) {
  /** 当前生效的库根（每次请求都重新解析：用户可能刚换过目录）。 */
  async function currentRoot() {
    const settings = await readSettings()
    const configured = settings.vaultRoot || config.vaultPath || null
    return { ...(await resolveVaultRoot(configured)), settings }
  }

  async function handleStatus(res) {
    const { root, missing, settings } = await currentRoot()
    let entries = []
    let errors = []
    let truncated = false
    if (!missing) {
      try {
        const scan = await scanVault(root)
        entries = scan.entries
        errors = scan.errors
        truncated = scan.truncated
      } catch (error) {
        errors = [{ path: '.', message: String(error && error.message ? error.message : error) }]
      }
    }
    const stats = await vaultStats(root, entries)
    const auth = await readAuth()
    const syncLog = await readSyncState()
    const readiness = await cloudReadiness()

    // 空库时给出「发现你已有的归档目录」建议，但不擅自切换
    let suggestions = []
    if (entries.length === 0 && !settings.vaultRoot) {
      for (const candidate of knownVaultCandidates()) {
        try {
          const st = await stat(candidate)
          if (!st.isDirectory()) continue
          const scan = await scanVault(candidate)
          if (scan.entries.length > 0) suggestions.push({ path: candidate, notes: scan.entries.length })
        } catch {
          // 候选不存在：跳过
        }
      }
    }

    // 回收站条数：面板要在「笔记」页签上直接显示「回收站 N」，用户才知道有东西可救。
    const trashItems = missing ? [] : await listTrash(root)

    send(res, 200, {
      vaultRoot: root,
      vaultMissing: missing,
      settingsPath: settingsPath(),
      authPath: authPath(),
      notes: stats.notes,
      dirs: stats.dirs,
      bytes: stats.bytes,
      lastSyncAt: settings.lastSyncAt,
      truncated,
      errors,
      suggestions,
      // 云端通道状态：configured 表示「现在点一下就能用」，transport 说明走哪条路
      api: {
        configured: readiness.configured,
        transport: readiness.transport,
        effectiveTransport: readiness.effectiveTransport || readiness.transport,
        viaLogin: readiness.viaLogin === true,
        apiKeyMasked: readiness.apiKeyMasked || '',
        clientIdMasked: readiness.clientIdMasked || '',
        hasGrantId: readiness.hasGrantId === true,
        // 填了 Key 但服务端拒过：一定要报出来，否则用户看到「已接入」却满屏失败
        keyRejected: readiness.keyRejected === true,
        keyError: readiness.keyError || null,
        fallbackAvailable: readiness.fallbackAvailable === true,
        credentialsPath: cloudPath(),
        statePath: syncStatePath(),
        trackedNotes: Object.keys(syncLog.notes).length,
        lastRunAt: syncLog.lastRunAt,
      },
      autoSync: {
        enabled: settings.autoSync,
        minutes: settings.autoSyncMinutes,
        incremental: settings.autoSyncIncremental,
        running: syncState.running,
        startedAt: syncState.startedAt,
        finishedAt: syncState.finishedAt,
        lastError: syncState.lastError,
        lastResult: syncState.lastResult,
      },
      // 旧的 OAuth 通道：保留只是为了兼容历史一次性导入，新功能不用它
      cloud: {
        loggedIn: auth !== null,
        expiresAt: auth ? auth.expiresAt : null,
        expired: auth ? auth.expiresAt <= Date.now() : false,
        issuer: ISSUER,
      },
      // 回收站条数：面板要在「笔记」页签上直接显示「回收站 N」，用户才知道有东西可救。
      trash: trashItems.length,
    })
  }

  async function handleTree(res) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { root, tree: { name: '', path: '', kind: 'dir', children: [], count: 0 }, entries: [] })
    const { entries, errors, truncated } = await scanVault(root)
    send(res, 200, { root, tree: buildTree(entries), entries, dirs: listDirs(entries), errors, truncated })
  }

  async function handleList(res, url) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { entries: [], total: 0 })
    const { entries } = await scanVault(root)
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const dir = url.searchParams.get('dir') || ''
    const tag = (url.searchParams.get('tag') || '').trim()
    let filtered = entries
    if (dir !== '') filtered = filtered.filter((e) => e.dir === dir || e.path.startsWith(`${dir}/`))
    if (tag !== '') filtered = filtered.filter((e) => e.tags.some((t) => t === tag))
    if (q !== '') {
      filtered = filtered.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.path.toLowerCase().includes(q) ||
          (e.excerpt || '').toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)),
      )
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 2000)
    send(res, 200, { entries: filtered.slice(0, limit), total: filtered.length })
  }

  async function handleRead(res, url) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const path = url.searchParams.get('path') || ''
    const note = await readNote(root, path)
    // 顺带把这篇笔记自己的附件（录音 / 转写 / 图片）带回去：面板要在阅读区直接
    // 放播放器，多打一次请求会让播放器晚一拍出现，看起来像卡住。
    let assets = []
    try {
      const noteId = note.frontmatter && note.frontmatter.note_id ? note.frontmatter.note_id : ''
      assets = await listAssets(root, note.path, noteId)
    } catch {
      // 附件是可选的，读不到就当没有
    }
    send(res, 200, { ...note, assets })
  }

  /**
   * 本地附件直出（录音 / 图片）。
   *
   * 和音频代理是两回事：这里读的是**用户自己库里的文件**，没有外网、没有签名
   * URL，所以只需要路径包含性校验（resolveInside 已经做了 `../` 拦截）。
   */
  async function handleAsset(req, res, url) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const rel = url.searchParams.get('path') || ''
    if (rel === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    const lower = rel.toLowerCase()
    const type = /\.(mp3)$/.test(lower)
      ? 'audio/mpeg'
      : /\.(ogg)$/.test(lower)
        ? 'audio/ogg'
        : /\.(m4a|aac)$/.test(lower)
          ? 'audio/mp4'
          : /\.(wav)$/.test(lower)
            ? 'audio/wav'
            : /\.(flac)$/.test(lower)
              ? 'audio/flac'
              : /\.(png)$/.test(lower)
                ? 'image/png'
                : /\.(jpe?g)$/.test(lower)
                  ? 'image/jpeg'
                  : /\.(gif)$/.test(lower)
                    ? 'image/gif'
                    : /\.(webp)$/.test(lower)
                      ? 'image/webp'
                      : /\.(md)$/.test(lower)
                        ? 'text/markdown; charset=utf-8'
                        : null
    if (type === null) throw Object.assign(new Error('不支持的文件类型'), { status: 400 })
    const { abs } = resolveInside(root, rel)
    const st = await stat(abs)
    if (!st.isFile()) throw Object.assign(new Error('不是文件'), { status: 400 })
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=60',
    }
    // 支持 Range：录音拖动进度条要靠它
    const range = req.headers.range
    if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) {
      const [, startText, endText] = /^bytes=(\d*)-(\d*)$/.exec(range)
      let start = startText === '' ? null : Number(startText)
      let end = endText === '' ? null : Number(endText)
      if (start === null && end !== null) {
        start = Math.max(0, st.size - end)
        end = st.size - 1
      }
      if (start !== null) {
        if (end === null || end >= st.size) end = st.size - 1
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` })
          return res.end()
        }
        headers['content-range'] = `bytes ${start}-${end}/${st.size}`
        headers['content-length'] = String(end - start + 1)
        res.writeHead(206, headers)
        return createReadStream(abs, { start, end }).pipe(res)
      }
    }
    headers['content-length'] = String(st.size)
    res.writeHead(200, headers)
    return createReadStream(abs).pipe(res)
  }

  async function handleSave(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const { root } = await currentRoot()
    const path = typeof body.path === 'string' ? body.path : ''
    const content = typeof body.content === 'string' ? body.content : ''
    if (path === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    const saved = await writeNote(root, path, content)
    send(res, 200, { ok: true, ...saved })
  }

  async function handleCreate(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const { root } = await currentRoot()
    const created = await createNote(root, {
      dir: typeof body.dir === 'string' ? body.dir : '',
      title: typeof body.title === 'string' ? body.title : '',
      content: typeof body.content === 'string' ? body.content : '',
      date: typeof body.date === 'string' ? body.date : undefined,
    })
    send(res, 200, { ok: true, ...created })
  }

  async function handleDelete(req, res) {
    const body = await readJsonBody(req)
    const { root } = await currentRoot()
    const path = typeof body.path === 'string' ? body.path : ''
    if (path === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    const result = await trashNote(root, path)
    send(res, 200, { ok: true, ...result })
  }

  // ── 回收站 ─────────────────────────────────────────────────────────────────

  async function handleTrashList(res) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { items: [], vaultMissing: true })
    const items = await listTrash(root)
    send(res, 200, { items, count: items.length })
  }

  async function handleTrashRestore(req, res) {
    const body = await readJsonBody(req)
    const { root } = await currentRoot()
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (path === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    const target = typeof body.target === 'string' ? body.target : ''
    const result = await restoreNote(root, path, target)
    send(res, 200, { ok: true, ...result })
  }

  async function handleTrashPurge(req, res) {
    const body = await readJsonBody(req)
    const { root } = await currentRoot()
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    // 不传 path 就是清空整个回收站；这是不可逆操作，前端必须二次确认。
    const result = await purgeTrash(root, path)
    send(res, 200, { ok: true, ...result })
  }

  async function handleSearch(res, url) {
    const { root, missing } = await currentRoot()
    const q = url.searchParams.get('q') || ''
    if (missing) return send(res, 200, { query: q, hits: [], scanned: 0, truncated: false })
    const result = await searchNotes(root, q, { limit: Math.min(Number(url.searchParams.get('limit')) || 60, 300) })
    send(res, 200, result)
  }

  // ── 设置 ───────────────────────────────────────────────────────────────────

  async function handleGetSettings(res) {
    const settings = await readSettings()
    const { root, missing } = await resolveVaultRoot(settings.vaultRoot || config.vaultPath || null)
    send(res, 200, { ...settings, vaultRoot: settings.vaultRoot, effectiveRoot: root, missing })
  }

  async function handleSetSettings(req, res) {
    const body = await readJsonBody(req)
    const patch = {}
    if (typeof body.vaultPath === 'string') {
      const real = await setVaultRoot(body.vaultPath)
      patch.vaultRoot = real
    }
    if (typeof body.syncImages === 'boolean') patch.syncImages = body.syncImages
    if (Object.keys(patch).length > 0) await updateSettings(patch)
    const settings = await readSettings()
    const { root } = await resolveVaultRoot(settings.vaultRoot || config.vaultPath || null)
    send(res, 200, { ok: true, ...settings, effectiveRoot: root })
  }

  // ── 云端：授权 ─────────────────────────────────────────────────────────────

  function redirectUriFor(origin) {
    return `${origin}${ROUTE_PREFIX}/oauth/callback`
  }

  async function handleAuthStart(req, res) {
    const origin = config.getOrigin()
    if (!origin) throw Object.assign(new Error('无法确定 DSH Web 的访问地址'), { status: 503 })
    const redirectUri = redirectUriFor(origin)
    // 复用已注册的 client，避免每次登录都在服务端留下一个废弃 client
    const registered = await readClient()
    let clientId = registered && registered.clientId ? registered.clientId : null
    if (!clientId) {
      const created = await registerClient(redirectUri)
      clientId = created.clientId
    }
    sweepPending()
    const state = createPkceState()
    const pkce = createPkce()
    pendingAuthorizations.set(state, { verifier: pkce.verifier, redirectUri, clientId, createdAt: Date.now() })
    const url = buildAuthorizeUrl({ clientId, redirectUri, state, challenge: pkce.challenge })
    send(res, 200, { ok: true, url, redirectUri })
  }

  async function handleAuthCallback(res, url) {
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') || ''
    const pending = pendingAuthorizations.get(state)
    pendingAuthorizations.delete(state)

    if (error) return sendHtml(res, 400, callbackPage('授权被拒绝', `得到大脑返回：${escapeHtml(error)}`, false))
    if (!code) return sendHtml(res, 400, callbackPage('授权失败', '回调里没有 code 参数。', false))
    if (!pending) return sendHtml(res, 400, callbackPage('授权已过期', '这次登录请求已超时或被重复使用，请回到面板重新点「登录」。', false))

    try {
      const token = await exchangeCode({
        clientId: pending.clientId,
        code,
        redirectUri: pending.redirectUri,
        verifier: pending.verifier,
      })
      await writeAuth({
        ...token,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
      })
      sendHtml(res, 200, callbackPage('已连接得到大脑', '回到 DSH 面板即可开始导入笔记。现在就可以关掉这个页面。', true))
    } catch (err) {
      sendHtml(res, 502, callbackPage('换取令牌失败', escapeHtml(String(err && err.message ? err.message : err)), false))
    }
  }

  async function handleAuthStatus(res) {
    const auth = await readAuth()
    if (!auth) return send(res, 200, { loggedIn: false })
    const probe = await probeAccessToken(auth.accessToken)
    send(res, 200, {
      loggedIn: true,
      expiresAt: auth.expiresAt,
      expired: auth.expiresAt <= Date.now(),
      valid: probe.ok,
      serverInfo: probe.ok ? probe.serverInfo : null,
      error: probe.ok ? null : probe.error,
      hasRefreshToken: auth.refreshToken !== null,
    })
  }

  async function handleLogout(res) {
    const auth = await readAuth()
    if (auth) await revokeToken(auth.accessToken)
    await clearAuth()
    send(res, 200, { ok: true })
  }

  // ── 云端：导入 ─────────────────────────────────────────────────────────────

  /**
   * 启动一次导入（异步），面板轮询 `import/status` 拿进度。
   *
   * 为什么不用「一个长请求等到底」：几百篇笔记要跑几分钟，HTTP 中间层、代理、
   * 浏览器都可能先把连接掐掉，面板就只剩一个转圈和一句「失败」。把任务挂在
   * host 进程内、状态可轮询，导入期间用户还能继续读本地笔记——这更符合
   * 「云端只是一次性通道」的定位。
   */
  async function handleImport(req, res) {
    const body = await readJsonBody(req)
    if (importState.running) {
      return send(res, 200, { ok: false, running: true, error: '已有一个导入任务在跑，等它结束再试' })
    }
    const { root } = await currentRoot()
    let client
    try {
      client = await openClient()
    } catch (error) {
      return send(res, error.status === 401 ? 401 : 502, { ok: false, error: error.message })
    }

    importState.running = true
    importState.startedAt = new Date().toISOString()
    importState.finishedAt = null
    importState.lines = []
    importState.result = null
    importState.error = null

    const push = (line) => {
      importState.lines.push({ at: new Date().toISOString(), text: line })
      if (importState.lines.length > 500) importState.lines.shift()
    }

    // 故意不 await：请求立刻返回，任务在 host 进程里继续跑
    void (async () => {
      try {
        const stats = await importAllNotes(client, root, {
          log: push,
          maxNotes: Number(body.maxNotes) > 0 ? Math.min(Number(body.maxNotes), 5000) : undefined,
        })
        await updateSettings({ lastSyncAt: new Date().toISOString() })
        importState.result = { root, ...stats }
      } catch (error) {
        importState.error = String(error && error.message ? error.message : error)
        push(`导入中断：${importState.error}`)
      } finally {
        importState.running = false
        importState.finishedAt = new Date().toISOString()
      }
    })()

    send(res, 200, { ok: true, running: true, startedAt: importState.startedAt })
  }

  function handleImportStatus(res) {
    send(res, 200, {
      running: importState.running,
      startedAt: importState.startedAt,
      finishedAt: importState.finishedAt,
      lines: importState.lines,
      result: importState.result,
      error: importState.error,
    })
  }

  /** 只探测连通性（不写任何文件），用于「先看看还剩多少配额/能不能读」。 */
  async function handleProbe(req, res) {
    try {
      const client = await openClient()
      const tools = await client.listTools()
      let topics = null
      try {
        topics = await client.callTool('list_topics', { page: 1, page_size: 50 })
      } catch {
        // 读不到知识库不代表连接失败
      }
      send(res, 200, { ok: true, serverInfo: client.serverInfo, toolCount: tools.length, topics })
    } catch (error) {
      send(res, 200, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  // ── 云端：Open API 凭证 ─────────────────────────────────────────────────────

  /**
   * 保存 API Key / Client ID。
   *
   * 安全约定：**这个端点只写不回**。任何情况下都不把 apiKey 原样发回浏览器——
   * 渲染进程一旦拿到完整 Key，就等于账号可以被拷走。前端要显示就显示 masked。
   */
  async function handleSetCloud(req, res) {
    const body = await readJsonBody(req)
    const patch = {}
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim()
    if (typeof body.clientId === 'string') patch.clientId = body.clientId.trim()
    if (typeof body.grantId === 'string') patch.grantId = body.grantId.trim()
    const current = (await readCloud()) || { apiKey: '', clientId: '', grantId: '' }
    const next = {
      apiKey: patch.apiKey !== undefined ? patch.apiKey : current.apiKey,
      clientId: patch.clientId !== undefined ? patch.clientId : current.clientId,
      grantId: patch.grantId !== undefined ? patch.grantId : current.grantId,
    }
    // 只有两样都给齐才算「配置成功」；只填一半存下来但明确告知还缺什么
    await writeCloud(next)
    // 换了凭证就要忘掉上一次「Key 被拒」的结论，否则填了正确的 Key 也还在走兜底通道
    resetKeyRejection()
    const saved = await readCloud()
    const ready = saved !== null && saved.apiKey !== '' && saved.clientId !== ''
    send(res, 200, {
      ok: true,
      ready,
      apiKeyMasked: saved ? maskSecret(saved.apiKey) : '',
      clientIdMasked: saved ? maskSecret(saved.clientId) : '',
      hasGrantId: Boolean(saved && saved.grantId),
      missing: ready ? [] : [!saved || saved.apiKey === '' ? 'API Key' : null, !saved || saved.clientId === '' ? 'Client ID' : null].filter(Boolean),
    })
  }

  /** 清空云端凭证（不影响本地笔记，也不影响旧的 OAuth 凭证）。 */
  async function handleClearCloud(res) {
    await clearCloud()
    // 清掉 Key 之后就不能再记着「Key 被拒」，否则用户重新登录也没法用
    resetKeyRejection()
    send(res, 200, { ok: true })
  }

  /**
   * 连通性 + 配额探测。
   *
   * 调一次 note/list（limit=1）就够：能验证 Key、Client ID、网络三件事，而且
   * 只消耗 1 次读配额。把服务端回的 rate_limit 原样带给面板，用户就能自己看到
   * 「今天还剩多少次」。
   */
  async function handleCloudProbe(res) {
    let client
    try {
      client = await openCloudClient()
    } catch (error) {
      return send(res, 200, { ok: false, configured: false, error: error.message })
    }
    try {
      const page = await client.listNotes({ limit: 1 })
      send(res, 200, {
        ok: true,
        configured: true,
        reachable: true,
        sampleCount: page.notes.length,
        hasMore: page.hasMore,
      })
    } catch (error) {
      send(res, 200, {
        ok: false,
        configured: true,
        reachable: error.status !== 502,
        status: error.status ?? null,
        reason: error.reason ?? null,
        requestId: error.requestId ?? null,
        error: error.message,
      })
    }
  }

  // ── 云端：笔记 CRUD（直接操作得到大脑，不是本地文件）──────────────────────

  /**
   * 云端笔记列表。
   *
   * 这是「直接接入应用」的地基：面板的云端视图就是靠它翻页。返回里带
   * `hasAudio` / `hasTranscript`，前端据此决定要不要显示播放器。
   */
  async function handleCloudList(res, url) {
    const client = await openCloudClient()
    const cursor = url.searchParams.get('cursor') || undefined
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50)
    const page = await client.listNotes({ cursor, limit })
    send(res, 200, {
      notes: page.notes.map((n) => normalizeNote(n)).filter(Boolean),
      hasMore: page.hasMore,
      cursor: page.cursor,
      total: page.total,
    })
  }

  /** 云端笔记详情（含 audio / timeline / todos，面板的播放器和时间轴用它）。 */
  async function handleCloudRead(res, url) {
    const client = await openCloudClient()
    const noteId = url.searchParams.get('id') || ''
    if (noteId === '') throw Object.assign(new Error('id 不能为空'), { status: 400 })
    const raw = await client.getNote(noteId)
    if (!raw) throw Object.assign(new Error('云端没有这篇笔记（可能已被删除）'), { status: 404 })
    // 顺带告诉前端「这篇在本地库里的哪一个文件」：面板要提供「把本地改动推到云端」
    // 这个动作，没有路径就只能让用户自己找。state 里记的就是同步落点。
    const state = await readSyncState()
    const record = state.notes[String(noteId)]
    send(res, 200, {
      note: normalizeNote(raw),
      raw,
      localPath: record && typeof record.path === 'string' ? record.path : '',
    })
  }

  /** 在云端新建笔记。写操作直接落得到大脑，不只是本地。 */
  async function handleCloudCreate(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const client = await openCloudClient()
    const created = await client.createNote({
      noteType: typeof body.noteType === 'string' ? body.noteType : 'plain_text',
      title: typeof body.title === 'string' ? body.title : '',
      content: typeof body.content === 'string' ? body.content : '',
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      topicId: typeof body.topicId === 'string' && body.topicId !== '' ? body.topicId : undefined,
      clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined,
    })
    send(res, 200, { ok: true, ...created })
  }

  /** 在云端更新笔记。tags 是完整替换，前端要传全集。 */
  async function handleCloudUpdate(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const client = await openCloudClient()
    const noteId = typeof body.noteId === 'string' ? body.noteId : ''
    if (noteId === '') throw Object.assign(new Error('noteId 不能为空'), { status: 400 })
    await client.updateNote({
      noteId,
      title: typeof body.title === 'string' ? body.title : undefined,
      content: typeof body.content === 'string' ? body.content : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    })
    // 云端改完顺手把本地镜像也刷一遍，否则面板上「本地」和「云端」会不一致
    let local = null
    try {
      local = await syncOne(noteId)
    } catch (error) {
      local = { error: error.message }
    }
    send(res, 200, { ok: true, local })
  }

  /** 删除云端笔记（进回收站，可在得到大脑里恢复）。 */
  async function handleCloudDelete(req, res) {
    const body = await readJsonBody(req)
    const client = await openCloudClient()
    const noteId = typeof body.noteId === 'string' ? body.noteId : ''
    if (noteId === '') throw Object.assign(new Error('noteId 不能为空'), { status: 400 })
    await client.deleteNote(noteId)
    // 本地对应文件移进回收站（不硬删）
    let local = null
    try {
      const state = await readSyncState()
      const rec = state.notes[noteId]
      if (rec && rec.path) {
        const { root } = await currentRoot()
        await trashNote(root, rec.path)
        delete state.notes[noteId]
        await writeSyncState(state)
        local = { trashed: rec.path }
      }
    } catch (error) {
      local = { error: error.message }
    }
    send(res, 200, { ok: true, local })
  }

  async function handleCloudTagsAdd(req, res) {
    const body = await readJsonBody(req)
    const client = await openCloudClient()
    const noteId = typeof body.noteId === 'string' ? body.noteId : ''
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : []
    if (noteId === '' || tags.length === 0) throw Object.assign(new Error('noteId 与 tags 都不能为空'), { status: 400 })
    await client.addTags(noteId, tags)
    send(res, 200, { ok: true })
  }

  async function handleCloudTagsDelete(req, res) {
    const body = await readJsonBody(req)
    const client = await openCloudClient()
    const noteId = typeof body.noteId === 'string' ? body.noteId : ''
    const tagId = typeof body.tagId === 'string' ? body.tagId : ''
    if (noteId === '' || tagId === '') throw Object.assign(new Error('noteId 与 tagId 都不能为空'), { status: 400 })
    await client.deleteTag(noteId, tagId)
    send(res, 200, { ok: true })
  }

  /** 知识库列表（面板「知识库」视图的数据源）。 */
  async function handleCloudTopics(res, url) {
    const client = await openCloudClient()
    const page = Number(url.searchParams.get('page')) || 1
    const result = await client.listTopics(page)
    send(res, 200, result)
  }

  async function handleCloudTopicNotes(res, url) {
    const client = await openCloudClient()
    const topicId = url.searchParams.get('topicId') || ''
    if (topicId === '') throw Object.assign(new Error('topicId 不能为空'), { status: 400 })
    const page = Number(url.searchParams.get('page')) || 1
    const result = await client.listTopicNotes({ topicId, page })
    send(res, 200, { ...result, notes: result.notes.map((n) => normalizeNote(n, { topicName: '' })).filter(Boolean) })
  }

  /**
   * 语义召回（云端向量检索）。
   *
   * 和本地 `/search` 的区别：本地是子串匹配，快、离线、只搜已同步的；这里是
   * 语义检索，能按意思找到没出现过的词，但要联网且吃配额。两个都给用户，
   * 让他自己选——面板上就是两个搜索框。
   */
  async function handleCloudRecall(req, res) {
    const body = await readJsonBody(req)
    const client = await openCloudClient()
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (query === '') throw Object.assign(new Error('query 不能为空'), { status: 400 })
    const topK = Number(body.topK) > 0 ? Math.min(Number(body.topK), 10) : 5
    const results = body.topicId ? await client.recallInTopic({ topicId: body.topicId, query, topK }) : await client.recall(query, topK)
    send(res, 200, {
      query,
      results: results.map((r) => {
        const n = normalizeNote(r.note ?? r, {})
        return n ? { ...n, score: typeof r.score === 'number' ? r.score : null } : null
      }).filter(Boolean),
    })
  }

  async function handleCloudShare(req, res) {
    const body = await readJsonBody(req)
    const client = await openCloudClient()
    const noteId = typeof body.noteId === 'string' ? body.noteId : ''
    if (noteId === '') throw Object.assign(new Error('noteId 不能为空'), { status: 400 })
    const url = await client.createShareLink({ noteId, excludeAudio: body.excludeAudio === true })
    send(res, 200, { ok: true, url })
  }

  // ── 音频：流式代理 ─────────────────────────────────────────────────────────

  /**
   * 录音音频代理。
   *
   * 为什么不直接把 play_url 塞给 `<audio src>`：那个地址是 CDN 上的短期签名
   * 链接，(1) 会过期，(2) 直接暴露云端凭证签出来的 URL，(3) 某些环境下 CDN
   * 的 CORS 头不允许 `audio` 元素跨源加载。所以由 host 侧用同一个 Axios/fetch
   * 通道拉流并原样转发，浏览器永远只跟本机 127.0.0.1 说话。
   *
   * 边界：只允许转发白名单域名，防止这个端点被当成开放代理。
   */
  async function handleAudioProxy(req, res, url) {
    const target = url.searchParams.get('url') || ''
    if (target === '') throw Object.assign(new Error('url 不能为空'), { status: 400 })
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      throw Object.assign(new Error('url 不是合法地址'), { status: 400 })
    }
    if (!/^https?:$/.test(parsed.protocol)) throw Object.assign(new Error('只支持 http/https'), { status: 400 })
    const host = parsed.hostname.toLowerCase()
    if (!AUDIO_HOST_ALLOWLIST.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      throw Object.assign(new Error(`不允许代理这个域名：${host}`), { status: 403 })
    }

    const range = req.headers.range
    const upstream = await fetch(target, {
      headers: {
        // 支持 Range：音频拖动进度条要靠它，否则每次都要从头下整个文件
        ...(typeof range === 'string' ? { Range: range } : {}),
        // 有些 CDN 要求带 Referer 才给音频
        Referer: 'https://www.biji.com/',
        'User-Agent': 'Mozilla/5.0 (dsh-getnote)',
      },
      redirect: 'follow',
    })
    const headers = { 'cache-control': 'private, max-age=300', 'accept-ranges': 'bytes' }
    for (const key of ['content-type', 'content-length', 'content-range']) {
      const v = upstream.headers.get(key)
      if (v) headers[key] = v
    }
    if (!headers['content-type']) headers['content-type'] = 'audio/mpeg'
    res.writeHead(upstream.status, headers)
    if (!upstream.body) return res.end()
    try {
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) await once(res, 'drain')
      }
    } catch {
      // 客户端提前断开（用户拖进度条/关面板）是常态，不算错误
    }
    res.end()
  }

  // ── 自动同步 ───────────────────────────────────────────────────────────────

  /**
   * 执行一轮同步（供手动端点使用）。
   *
   * 真正的实现在模块级 performSyncImpl：定时器在 apply 里起，它拿不到
   * createHandler 的闭包，所以同步主体必须放在两边都能调到的位置。
   */
  async function performSync(opts = {}) {
    return performSyncImpl({ ...opts, config })
  }

  /** 单篇同步：云端改完立刻把那一篇刷到本地，不用等整轮。 */
  async function syncOne(noteId) {
    const client = await openCloudClient()
    const { root } = await currentRoot()
    const state = await readSyncState()
    const scan = await scanVault(root)
    const index = new Map()
    for (const entry of scan.entries) {
      if (entry.noteId) index.set(String(entry.noteId), entry.path)
    }
    const result = await syncSingleNote({ client, root, state, noteId, index })
    if (result.note) {
      const notes = { ...state.notes, [noteId]: result.note }
      await writeSyncState({ notes, lastRunAt: new Date().toISOString(), lastCursor: state.lastCursor })
    }
    return { path: result.path, action: result.action }
  }

  /** 手动触发一轮同步（请求立刻返回，面板轮 `sync/status` 看进度）。 */
  async function handleSyncStart(req, res) {
    const body = await readJsonBody(req)
    if (syncState.running) return send(res, 200, { ok: false, running: true, error: '已经有一轮同步在跑了' })
    const full = body.full === true
    // 先验证凭证，别让用户点了之后等三十秒才看到「没配置」
    try {
      await openCloudClient()
    } catch (error) {
      return send(res, error.status === 401 ? 401 : 502, { ok: false, error: error.message })
    }
    void (async () => {
      const result = await performSync({ full, reason: 'manual' })
      syncState.lastResult = { ...(syncState.lastResult || {}), ...(result.ok === false ? { failed: result.error } : {}) }
    })()
    send(res, 200, { ok: true, running: true, startedAt: syncState.startedAt })
  }

  function handleSyncStatus(res) {
    send(res, 200, {
      running: syncState.running,
      startedAt: syncState.startedAt,
      finishedAt: syncState.finishedAt,
      lastResult: syncState.lastResult,
      lastError: syncState.lastError,
    })
  }

  /** 本地 → 云端：把一篇本地笔记推上去。 */
  async function handleSyncPush(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const client = await openCloudClient()
    const { root } = await currentRoot()
    const relPath = typeof body.path === 'string' ? body.path : ''
    if (relPath === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    const result = await pushLocalNote({ client, root, relPath, noteId: typeof body.noteId === 'string' ? body.noteId : undefined })
    send(res, 200, { ok: true, ...result })
  }

  /**
   * 自动同步的开关与间隔。
   *
   * 这里只改设置，真正的定时器由 apply 里的 scheduleAutoSync 负责——分离的原因
   * 是设置可能来自 cordis.patch.yml（启动时就该起定时器），也可能来自面板点击。
   */
  async function handleAutoSyncSettings(req, res) {
    const body = await readJsonBody(req)
    const patch = {}
    if (typeof body.enabled === 'boolean') patch.autoSync = body.enabled
    if (body.minutes !== undefined) patch.autoSyncMinutes = normalizeAutoSync({ autoSyncMinutes: body.minutes }).intervalMinutes
    if (typeof body.incremental === 'boolean') patch.autoSyncIncremental = body.incremental
    const settings = await updateSettings(patch)
    send(res, 200, {
      ok: true,
      enabled: settings.autoSync,
      minutes: settings.autoSyncMinutes,
      incremental: settings.autoSyncIncremental,
    })
  }

  // ── 路由分发 ───────────────────────────────────────────────────────────────

  return async function handler(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://internal')
    } catch {
      return send(res, 400, { error: 'bad url' })
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 0 || `/${parts[0]}` !== ROUTE_PREFIX) return send(res, 404, { error: 'not found' })

    const action = parts[1] || 'status'
    const method = (req.method || 'GET').toUpperCase()

    try {
      // OAuth 回调走浏览器整页跳转（GET），其余都是 JSON 端点
      if (action === 'oauth' && parts[2] === 'callback') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return await handleAuthCallback(res, url)
      }
      if (action === 'oauth' && parts[2] === 'start') return await handleAuthStart(req, res)
      if (action === 'oauth' && parts[2] === 'status') return await handleAuthStatus(res)
      if (action === 'logout') return await handleLogout(res)

      // 音频代理走 GET，且不能是 JSON 端点（要写二进制流，自己管响应头）
      if (action === 'audio') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return await handleAudioProxy(req, res, url)
      }

      // 本地附件（录音 / 图片 / 转写）同样是二进制流
      if (action === 'asset') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return await handleAsset(req, res, url)
      }

      if (method === 'GET') {
        if (action === 'status') return await handleStatus(res)
        if (action === 'tree') return await handleTree(res)
        if (action === 'list') return await handleList(res, url)
        if (action === 'trash' && parts[2] === 'list') return await handleTrashList(res)
        if (action === 'read') return await handleRead(res, url)
        if (action === 'search') return await handleSearch(res, url)
        if (action === 'settings') return await handleGetSettings(res)
        if (action === 'probe') return await handleProbe(req, res)
        if (action === 'import' && parts[2] === 'status') return handleImportStatus(res)
        // 云端（Open API）
        if (action === 'api' && parts[2] === 'probe') return await handleCloudProbe(res)
        if (action === 'cloud' && parts[2] === 'list') return await handleCloudList(res, url)
        if (action === 'cloud' && parts[2] === 'read') return await handleCloudRead(res, url)
        if (action === 'cloud' && parts[2] === 'topics') return await handleCloudTopics(res, url)
        if (action === 'cloud' && parts[2] === 'topic-notes') return await handleCloudTopicNotes(res, url)
        // 同步
        if (action === 'sync' && parts[2] === 'status') return handleSyncStatus(res)
      }

      if (method === 'POST') {
        if (action === 'save') return await handleSave(req, res)
        if (action === 'create') return await handleCreate(req, res)
        if (action === 'delete') return await handleDelete(req, res)
        if (action === 'trash' && parts[2] === 'restore') return await handleTrashRestore(req, res)
        if (action === 'trash' && parts[2] === 'purge') return await handleTrashPurge(req, res)
        if (action === 'settings') return await handleSetSettings(req, res)
        if (action === 'import') return await handleImport(req, res)
        // 云端凭证（只写不回）
        if (action === 'api' && parts[2] === 'credentials') return await handleSetCloud(req, res)
        if (action === 'api' && parts[2] === 'clear') return await handleClearCloud(res)
        // 云端 CRUD
        if (action === 'cloud' && parts[2] === 'create') return await handleCloudCreate(req, res)
        if (action === 'cloud' && parts[2] === 'update') return await handleCloudUpdate(req, res)
        if (action === 'cloud' && parts[2] === 'delete') return await handleCloudDelete(req, res)
        if (action === 'cloud' && parts[2] === 'tags-add') return await handleCloudTagsAdd(req, res)
        if (action === 'cloud' && parts[2] === 'tags-delete') return await handleCloudTagsDelete(req, res)
        if (action === 'cloud' && parts[2] === 'recall') return await handleCloudRecall(req, res)
        if (action === 'cloud' && parts[2] === 'share') return await handleCloudShare(req, res)
        // 同步
        if (action === 'sync' && parts[2] === 'start') return await handleSyncStart(req, res)
        if (action === 'sync' && parts[2] === 'push') return await handleSyncPush(req, res)
        if (action === 'sync' && parts[2] === 'auto') return await handleAutoSyncSettings(req, res)
      }

      return send(res, 404, { error: `unknown action: ${action}` })
    } catch (error) {
      return fail(res, error)
    }
  }
}

/**
 * 一轮同步的实际实现（模块级）。
 *
 * 放在模块级而不是 createHandler 闭包里，是因为自动同步的定时器在 apply 里起：
 * 它拿不到 handler 的闭包，但需要调用完全相同的同步逻辑。两份实现会漂移，
 * 所以只留一份，用 config 参数补上闭包能拿到的东西。
 *
 * 三重防重入：running 标志 + 自动同步的最短间隔 + 定时器 tick 自己的 autoRunning。
 * 理由很实际：用户手动点了同步、同时定时器也醒了，两轮并发会把同一篇笔记写两遍，
 * 读配额也会翻倍。
 */
async function performSyncImpl({ full = false, reason = 'manual', config = {} } = {}) {
  if (syncState.running) return { ok: false, running: true, error: '已经有一轮同步在跑了' }
  const now = Date.now()
  if (reason === 'auto' && now - syncState.lastAttemptAt < SYNC_MIN_GAP_MS) {
    return { ok: false, skipped: true, error: '距上次同步太近，跳过这一轮' }
  }
  syncState.lastAttemptAt = now
  syncState.running = true
  syncState.startedAt = new Date().toISOString()
  syncState.lastError = null

  const lines = []
  const log = (text) => {
    lines.push({ at: new Date().toISOString(), text })
    if (lines.length > 400) lines.shift()
  }
  try {
    const client = await openCloudClient()
    const settings = await readSettings()
    const configured = settings.vaultRoot || config.vaultPath || null
    const { root, missing } = await resolveVaultRoot(configured)
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const state = await readSyncState()
    // 现有本地索引：note_id → 相对路径，省掉为每篇笔记单独扫盘
    const scan = await scanVault(root)
    const index = new Map()
    for (const entry of scan.entries) {
      if (entry.noteId) index.set(String(entry.noteId), entry.path)
    }
    const result = await runSync({ client, root, state, full, log, index })
    const nextState = { notes: result.notes, lastRunAt: new Date().toISOString(), lastCursor: state.lastCursor }
    await writeSyncState(nextState)
    await updateSettings({ lastSyncAt: nextState.lastRunAt })
    syncState.lastResult = {
      pulled: result.pulled,
      skipped: result.skipped,
      adopted: result.adopted,
      conflicts: result.conflicts,
      deleted: result.deleted,
      errors: result.errors.length,
      scanned: result.scanned,
      pages: result.pages,
      full: result.full,
      reason,
      at: new Date().toISOString(),
    }
    syncState.lastError = result.errors.length > 0 ? result.errors[0].message : null
    for (const e of result.errors) log(`失败：${e.title || e.noteId || e.stage} — ${e.message}`)
    return { ok: true, ...syncState.lastResult, lines }
  } catch (error) {
    syncState.lastError = String(error && error.message ? error.message : error)
    log(`同步中断：${syncState.lastError}`)
    return { ok: false, error: syncState.lastError, lines, status: error.status ?? null }
  } finally {
    syncState.running = false
    syncState.finishedAt = new Date().toISOString()
  }
}

function createPkceState() {  const bytes = new Uint8Array(24)
  // Node 22+ 全局 crypto.getRandomValues
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/** 回调落地页（独立小页面：这里不是 iframe，是浏览器的整页跳转目标）。 */
function callbackPage(title, message, ok) {
  const accent = ok ? 'var(--ok, #3b8a5a)' : 'var(--err, #b4433a)'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
background:Canvas;color:CanvasText}
.card{max-width:420px;padding:32px 28px;text-align:center;border-radius:16px;
border:1px solid color-mix(in srgb,CanvasText 14%,transparent);background:Canvas}
h1{margin:0 0 12px;font-size:18px;font-weight:600;color:${accent}}
p{margin:0;font-size:13px;line-height:1.7;color:color-mix(in srgb,CanvasText 72%,transparent)}
.tip{margin-top:18px;font-size:12px;color:color-mix(in srgb,CanvasText 50%,transparent)}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p><p class="tip">dsh-getnote · 得到大脑</p></div></body></html>`
}

/**
 * 不导出 `Config`（与 dsh-obsidian-notes 一致）。
 *
 * 原因：cordis Loader 要求 `export const Config` 是一个 schemastery schema
 * （内部要调 `Config.validate(...)`）。写成 JSON Schema 对象或裸对象都会让整个
 * 插件行在加载阶段直接失败，报 `Cannot read properties of undefined (reading
 * 'validate')` —— 这一版正是踩了这个坑（fiberPhase: "failed"，面板和路由都不出现）。
 *
 * 而本包是从 workspace 以 symlink 装进来的，不能可靠地 import profile 的
 * `@deepseek-ai/schemastery`。所以干脆不声明 schema：loader 会把 cordis.patch.yml
 * 里的 config 原样传进来，我们自己在 apply 里做类型收敛（见 normalizeConfig）。
 */

/** 把 loader 传来的 config 收敛成已知字段，任何形状都不炸（没有 schema 兜底了，只能自己防）。 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    vaultPath: typeof raw.vaultPath === 'string' ? raw.vaultPath.trim() : '',
  }
}

export function apply(ctx, config) {
  const merged = normalizeConfig(config)
  merged.getOrigin = () => {
    try {
      const svc = ctx.get('webServer')
      return svc && typeof svc.getOrigin === 'function' ? svc.getOrigin() : null
    } catch {
      return null
    }
  }

  ctx.inject(['webServer'], (httpCtx) => {
    const routes = {
      ...merged,
      getOrigin: () => {
        try {
          return httpCtx.webServer.getOrigin()
        } catch {
          return null
        }
      },
    }
    const handler = createHandler(routes)
    httpCtx.effect(
      () => httpCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-getnote: /getnote 本地库与导入 API',
    )
  })

  // ── 自动同步定时器 ─────────────────────────────────────────────────────────
  //
  // 为什么用 setInterval 而不是宿主 timer 服务：这条循环要在插件整个生命周期里
  // 一直跑，而且必须能被 ctx.effect 干净地停掉。setInterval + clearInterval 的
  // 语义最简单，卸载时不会留下幽灵定时器。
  //
  // 为什么是「每分钟 tick 一次、按需判断」而不是「按间隔设一个 setTimeout」：
  // 用户随时可能在设置里改间隔（5 分钟 ↔ 12 小时），tick 模式改完立刻生效，
  // 不需要重建定时器。而且 tick 本身不联网，只在到点时才真正发请求。
  let autoTimer = null
  let autoRunning = false

  const tick = async () => {
    if (autoRunning) return
    autoRunning = true
    try {
      const settings = await readSettings()
      if (!settings.autoSync) return
      // 这里不能只检查「有没有 API Key」：用户完全可能只走「登录得到大脑」那条
      // OAuth 通道（实测就是这种情况），那样定时器会永远静默不跑，用户以为
      // 自动同步开着其实一次都没成功过。所以问 cloudReadiness：任意一条通道可用即可。
      const readiness = await cloudReadiness()
      if (!readiness.configured) return
      const state = await readSyncState()
      const intervalMs = Math.max(settings.autoSyncMinutes, 5) * 60 * 1000
      const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0
      const due = !Number.isFinite(last) || last === 0 || Date.now() - last >= intervalMs
      if (!due) return
      if (syncState.running) return
      // 故意不 await performSync 的完整流程：让 tick 立刻返回，避免下一次 tick
      // 撞上正在跑的这一轮（syncState.running 已经挡住，这里是双保险）
      void performSyncImpl({ full: false, reason: 'auto' })
    } catch {
      // 自动同步失败必须静默：它每 15 分钟跑一次，不能因为云端 502 就刷错误
      // 提示。失败原因留在 syncState.lastError 里，用户去面板能看到。
    } finally {
      autoRunning = false
    }
  }

  ctx.effect(() => {
    // 启动后先等 20 秒再第一次 tick：给 DSH 自身启动、webServer 就绪留出时间，
    // 也避免开机器时和别的插件抢网络
    const kickoff = setTimeout(() => { void tick() }, 20000)
    autoTimer = setInterval(() => { void tick() }, 60 * 1000)
    // Node 里定时器不阻止进程退出：DSH 退出时不该被这个循环拖着
    if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref()
    if (kickoff && typeof kickoff.unref === 'function') kickoff.unref()
    return () => {
      clearTimeout(kickoff)
      if (autoTimer) clearInterval(autoTimer)
      autoTimer = null
    }
  }, 'dsh-getnote: 自动同步定时器')
}

export { excerptOf, parseFrontmatter }
