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
import { createHash } from 'node:crypto'
import { applyUpdate, checkForUpdate, readOwnPackage } from './update.js'
import { access, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import {
  cardInfo,
  cardPendingCount,
  checkCardEnvironment,
  deleteCardFiles,
  importCardRecordings,
  listCardFiles,
  scanCard,
  wifiActivate,
  wifiJoin,
  wifiLeave,
  wifiScan,
} from './card.js'
import { clearScanCache, getScan, invalidateScan } from './scan-cache.js'
import { ensureWatch, stopWatch, vaultVersion } from './watch.js'
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
  extractWikiLinks,
  findBacklinks,
  freshnessOf,
  graphOf,
  heatmapOf,
  relatedOf,
  listAssets,
  listConflicts,
  listDirs,
  listTrash,
  outlineOf,
  parseFrontmatter,
  purgeTrash,
  readConflict,
  readNote,
  normalizeTags,
  readTags,
  rewriteTags,
  removeDir,
  removeTag,
  renameTag,
  createDir,
  resolveConflict,
  unresolveConflict,
  resolveInside,
  saveAsset,
  restoreNote,
  searchNotes,
  trashNote,
  toggleTodo,
  vaultStats,
  writeNote,
} from './vault.js'
import {
  listHistory,
  readHistoryEntry,
  restoreHistoryEntry,
  snapshotNote,
} from './history.js'
import { exportVaultToZip, importZipToVault } from './archive.js'
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
import {
  contentFingerprint,
  localFingerprintOf,
  pushNote as pushLocalNote,
  runSync,
  syncSingleNote,
} from './cloud-sync.js'

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
 * 录音卡直连的运行期状态（进程内单例）。
 *
 * 和 syncState 分开的理由：录音卡是 BLE 设备，一次只能被一个主机占用，而且传输
 * 速率只有 25 KB/s 左右——一个小时的录音要传十几分钟。它必须独占一个「正在导入」
 * 标志，否则用户连点两下就会有两个进程抢同一张卡，两边都读不全。
 */
const cardState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lines: [],
  result: null,
  error: null,
}
const CARD_MAX_LINES = 300

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
  // 面板最近一次「我在看」的心跳。仅前台运行模式下，超过
  // PANEL_VISIBLE_MS 没收到心跳就当作没人在看，不再自动同步。
  lastPanelSeenAt: 0,
}

/** 自动同步的最短间隔保护：任何情况下都不许比这更频繁地打云端。 */
const SYNC_MIN_GAP_MS = 60 * 1000

/**
 * 仅前台模式判定「面板还在看」的时间窗。
 *
 * 心跳 20 秒一次；给 3 分钟宽限是为了容忍渲染器卡顿、用户切走一分钟又回来、
 * 或者笔记本合盖再打开这类停顿——窗口给太紧会出现「我刚回来它还没恢复」，
 * 给太松又等于没限制住后台消耗配额。
 */
const PANEL_VISIBLE_MS = 3 * 60 * 1000

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

/**
 * 从请求 URL 里读一个布尔开关（`?fresh=1` / `?fresh=true`）。
 *
 * 单独抽出来是因为 handler 拿不到解析后的 URL —— 路由分发里解析过一次就丢了。
 * 这里重新解析一遍：handler 里的 URL 都很短，解析开销远小于多传一个参数
 * 让九个 handler 的签名都变。
 */
function url_flag(req, name) {
  try {
    const url = new URL(req && req.url ? req.url : '/', 'http://internal')
    const value = url.searchParams.get(name)
    return value === '1' || value === 'true' || value === 'yes'
  } catch {
    return false
  }
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

/**
 * 读原始 Buffer（zip 上传用）。
 *
 * 必须和 readBody 分开：readBody 会 toString('utf8')，二进制 zip 走一遍
 * 会被替换字符污染，再拿去过 inflate 就得到「归档损坏」，而其实文件是好的。
 */
function readBufferBody(req, cap, res = null) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) {
        req.pause()
        // pause() 只是不再读，连接还开着：恶意客户端可以发过半截就挂着，
        // 攒出成百上千条不结束的请求。响应写完之后直接销毁这条连接。
        if (res !== null && typeof res.once === 'function') {
          res.once('finish', () => {
            try {
              req.destroy()
            } catch {
              /* 已经关了 */
            }
          })
        }
        rejectBody(Object.assign(new Error('request body too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => rejectBody(error))
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
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
    const resolved = await resolveVaultRoot(configured)
    // 顺手保证监听的是当前库：库目录可以在设置里改，不能只在 apply 时建一次。
    // root 没变时这里只是一次字符串比较，开销可以忽略。
    if (!resolved.missing) {
      ensureWatch(resolved.root, () => {
        // 外部（Obsidian / git / 别的编辑器）改了文件 → 让扫描缓存失效，
        // 面板下一次心跳就能看到新版本号并重新拉一次。
        invalidateScan(resolved.root)
      })
    }
    return { ...resolved, settings }
  }

  /**
   * 按**整个响应体**算 ETag。
   *
   * 为什么不用扫描签名：扫描签名只覆盖库文件（路径+mtime+字节数），而
   * `/bootstrap` 的响应里还塞着 status——回收站条数、冲突条数、自动同步上次
   * 结果、凭证是否过期、主题色、模板……这些都不在扫描结果里，改它们根本不会
   * 动签名。拿扫描签名当 ETag 的后果是：用户清了回收站、改了主题色，浏览器
   * 带 If-None-Match 过来照样收到 304，界面永远停在旧状态。
   *
   * 按响应体哈希是唯一不会「漏掉某个字段」的写法——以后往 status 里加字段，
   * ETag 自动跟着变，不需要有人记得来这里补一行。代价是 200 时本来就要
   * stringify，304 时多一次 stringify；相比扫一遍全库可以忽略。
   */
  function bodyEtag(text) {
    return `W/"${createHash("sha1").update(text).digest("hex").slice(0, 16)}"`
  }

  async function handleStatus(res, options = {}) {
    const { root, missing, settings } = await currentRoot()
    let scan = null
    if (!missing) {
      try {
        // 走缓存：面板一次刷新会同时打 /status 和 /tree，两个 handler 各扫一遍
        // 全库是纯浪费。缓存把这一次的多个请求合并成一次扫描。
        scan = await getScan(root, options)
      } catch (error) {
        scan = { entries: [], errors: [{ path: '.', message: String(error && error.message ? error.message : error) }], truncated: false }
      }
    }
    send(res, 200, await buildStatusBody({ root, missing, settings, scan }))
  }

  /**
   * status 的响应体。抽出来是因为 `/bootstrap` 要把 status 和 tree 塞进同一个响应里，
   * 两边各写一份必然漂移——尤其那些带注释解释「为什么放 status 里」的字段，
   * 抄第二遍的时候最容易漏。
   */
  async function buildStatusBody({ root, missing, settings, scan }) {
    const entries = scan !== null ? scan.entries : []
    const errors = scan !== null ? scan.errors : []
    const truncated = scan !== null ? scan.truncated : false
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
          const scan = await getScan(candidate)
          if (scan.entries.length > 0) suggestions.push({ path: candidate, notes: scan.entries.length })
        } catch {
          // 候选不存在：跳过
        }
      }
    }

    // 回收站条数：面板要在「笔记」页签上直接显示「回收站 N」，用户才知道有东西可救。
    const trashItems = missing ? [] : await listTrash(root)
    // 冲突条数：页签角标的语义是「还有几件事等你决定」，所以只算**未处理**的。
    // 处理过的留档仍然留着（能反悔），但它们不该继续挂在角标上。
    let conflictCount = 0
    if (!missing) {
      try {
        const all = await listConflicts(root)
        conflictCount = all.filter((item) => item.resolved !== true).length
      } catch {
        conflictCount = 0
      }
    }

    return {
      vaultRoot: root,
      vaultMissing: missing,
      settingsPath: settingsPath(),
      authPath: authPath(),
      notes: stats.notes,
      dirs: stats.dirs,
      bytes: stats.bytes,
      lastSyncAt: settings.lastSyncAt,
      // 面板主题色（null = 内置蓝）。放 status 里而不是单独开一个路由：
      // 面板每次刷新都要它，多一次请求只会让首屏闪一下默认色。
      themeColor: settings.themeColor,
      // 深色模式与关系图配色跟主题色一起发：面板首屏就要定稿外观，
      // 晚一拍会让界面先亮一下再变暗，比不提供这个开关还难受。
      darkMode: settings.darkMode === true,
      graphColor: settings.graphColor,
      // 界面语言（null = 自动跟随宿主）。同样放 status：面板首屏就要定稿文案，
      // 晚一拍拿到的语言会让界面先中文后英文闪一下。
      uiLocale: settings.uiLocale,
      // 自定义笔记模板。跟 status 一起发：点「+」时菜单要立刻列出模板，
      // 再多一次请求会让菜单先空着再长出几项。
      templates: settings.templates,
      truncated,
      errors,
      suggestions,
      // 写作热力图。跟 status 一起发，是因为面板首屏就要画它——单独一个路由
      // 会让热力图在首屏之后才「啪」地出现，看起来像加载失败重试。
      // 26 周 = 半年，格子数 182，JSON 也就几 KB，不值得再拆。
      heatmap: missing ? null : heatmapOf(entries, { weeks: 26 }),
      // 保鲜度跟热力图是一对：热力图说「最近写得怎么样」，它说「哪些落灰了」。
      // 两者都在首屏左栏，跟着 status 一起发，不用为它多开一次请求。
      freshness: missing ? null : freshnessOf(entries, { staleDays: 90, limit: 30 }),
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
        foregroundOnly: settings.autoSyncForegroundOnly,
        panelVisible: Date.now() - (syncState.lastPanelSeenAt || 0) <= PANEL_VISIBLE_MS,
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
      // 冲突留档条数：同步页的「冲突」入口靠它显示待处理数量
      conflicts: conflictCount,
      // 库内容版本号：外部（Obsidian / git / 别的编辑器）改了文件就 +1。
      // 面板 20 秒一次的心跳会顺手比对这个值，变了就重新拉一次——
      // 这样「在别处改了笔记」不用手点刷新也能看见。
      vaultVersion: vaultVersion(),
    }
  }

  async function handleTree(req, res) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { root, tree: { name: '', path: '', kind: 'dir', children: [], count: 0 }, entries: [] })
    // ?fresh=1 跳过缓存：用户点刷新就是怀疑看到的是旧的，这时候还给他缓存等于骗他。
    const fresh = url_flag(req, 'fresh')
    const scan = await getScan(root, { fresh })
    const { entries, errors, truncated } = scan
    const body = { root, tree: buildTree(entries), entries, dirs: listDirs(entries), errors, truncated }
    // ETag 用扫描结果的内容签名（路径 + mtime + 字节数）。命中就回 304，
    // 用户点刷新时浏览器只拿到一个空响应——库没变，传输量几乎为零。
    //
    // 注意 cache-control 仍然是 no-store：这里要的是「条件请求能省下传输」，
    // 不是「让浏览器自己缓存一份」。库在本地，随时可能被别的编辑器改，
    // 让浏览器自作主张拿缓存才是危险的。
    const text = JSON.stringify(body)
    // ETag 按响应体算，不按扫描签名：签名只覆盖库文件，而响应里还有 dirs/errors
    // 这类由扫描结果派生、但不由 mtime 直接决定的字段。按体哈希永远不会漏。
    const etag = bodyEtag(text)
    if (req && req.headers && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      etag,
    })
    res.end(text)
  }

  /**
   * 首屏一次拿全：status + tree 合并成一个响应。
   *
   * 面板刷新原来打两个请求、扫两遍全库（见 scan-cache.js 的说明）。合并之后
   * 一次扫描、一个请求，首屏少一个来回。两个老端点都保留：外部脚本和测试还在用，
   * 而且单独要 status 的时候不该被迫传整棵树。
   */
  async function handleBootstrap(req, res) {
    const { root, missing, settings } = await currentRoot()
    const scan = missing ? { entries: [], errors: [], truncated: false, signature: 'missing' } : await getScan(root)
    const statusBody = await buildStatusBody({ root, missing, settings, scan })
    const treeBody = missing
      ? { root, tree: { name: '', path: '', kind: 'dir', children: [], count: 0 }, entries: [], dirs: [''] }
      : {
          root,
          tree: buildTree(scan.entries),
          entries: scan.entries,
          dirs: listDirs(scan.entries),
          errors: scan.errors,
          truncated: scan.truncated,
        }
    const text = JSON.stringify({ status: statusBody, ...treeBody })
    // 必须按响应体算，不能按扫描签名：status 里的回收站条数、冲突条数、
    // 凭证过期、主题色、模板都不在扫描签名覆盖范围内。用签名当 ETag 会让
    // 「清了回收站 / 改了主题色」这类变化永远收不到 304 之外的结果。
    const etag = bodyEtag(text)
    if (req && req.headers && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      etag,
    })
    res.end(text)
  }

  async function handleList(res, url) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { entries: [], total: 0 })
    const { entries } = await getScan(root)
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
    // 大纲与出链一起带上：面板要在大纲栏和「关联笔记」区显示，各打一次请求
    // 会让这两块晚一拍出现。两者都只是本地正则，成本可以忽略。
    let outline = []
    let links = []
    try {
      outline = outlineOf(note.body !== undefined && note.body !== null ? note.body : note.content)
      links = extractWikiLinks(note.content)
    } catch {
      // 解析失败不影响正文阅读
    }
    send(res, 200, { ...note, assets, outline, links })
  }

  /**
   * 反查引用（哪些笔记写了 `[[当前篇]]`）。
   *
   * 单独一个端点而不是塞进 /read：一次反查要读全库正文，和「打开一篇笔记」
   * 的快慢完全不是一个量级。用户点「关联笔记」时再查，不该让他打开每篇笔记
   * 都等全库扫描。
   */
  async function handleBacklinks(res, url) {
    const { root, missing } = await currentRoot()
    const target = url.searchParams.get('path') || ''
    if (missing) return send(res, 200, { target, hits: [] })
    const result = await findBacklinks(root, target)
    send(res, 200, result)
  }

  /**
   * 关系图：全库双链网络。
   *
   * 单独一个端点：画图要读全库正文（每篇一次 readFile），和「打开一篇笔记」不是一个
   * 量级。跟着 status 一起发会让首屏每次都等一遍全库读盘，而用户可能一整天都不看
   * 这张图。
   */
  async function handleGraph(res, url) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { nodes: [], edges: [], total: 0, linked: 0 })
    const limit = Number(url.searchParams.get('limit')) || 300
    const scan = await getScan(root)
    send(res, 200, await graphOf(root, scan.entries, { limit }))
  }

  /**
   * 相关推荐：给某一篇笔记算「你可能还想看」。
   *
   * 用扫描缓存里的 entries 就够（只要标签/标题/目录/日期），不读正文——所以它很快，
   * 打开笔记时可以跟着 /read 一起发。
   */
  async function handleRelated(res, url) {
    const { root, missing } = await currentRoot()
    const target = url.searchParams.get('path') || ''
    if (missing || target === '') return send(res, 200, { path: target, hits: [] })
    const scan = await getScan(root)
    send(res, 200, relatedOf(scan.entries, target, { limit: 8 }))
  }

  // ── 冲突（B2）─────────────────────────────────────────────────────────────

  async function handleConflictList(res) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { items: [], count: 0, pending: 0, resolved: 0 })
    const items = await listConflicts(root)
    // count 是总数，pending 是「还没处理」的条数。页签角标用 pending——
    // 角标的语义是「有多少事等你决定」，处理过的留档虽然还在，但已经不用管了。
    const pending = items.filter((item) => item.resolved !== true).length
    send(res, 200, { items, count: items.length, pending, resolved: items.length - pending })
  }

  async function handleConflictRead(res, url) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const path = url.searchParams.get('path') || ''
    const detail = await readConflict(root, path)
    // 顺手把候选正本的当前内容带上：比对界面要左右并排显示，再打一次
    // /read 会让右侧晚一拍出现、看起来像没加载出来。
    let local = null
    if (detail.candidates.length > 0) {
      try {
        const note = await readNote(root, detail.candidates[0].path)
        local = { path: note.path, content: note.content, title: note.title, body: note.body }
      } catch {
        local = null
      }
    }
    send(res, 200, { ...detail, local })
  }

  async function handleConflictResolve(req, res) {
    const body = await readJsonBody(req)
    const path = String(body.path || '').trim()
    if (path === '') throw Object.assign(new Error('需要 path'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const keepLocal = body.keepLocal === true
    // 采纳云端版会覆盖正本，先留一版历史——冲突解决后想反悔，历史是唯一退路。
    const snapshot = keepLocal
      ? null
      : async (rel) => {
          try {
            await snapshotNote(root, rel)
          } catch {
            // 历史存不下不该阻塞用户解决冲突
          }
        }
    const result = await resolveConflict(root, path, { keepLocal, snapshot })
    send(res, 200, { ok: true, ...result })
  }

  /**
   * 把一条冲突退回「未处理」。
   *
   * 采纳完改主意是这个功能最正常的用法（用户看两天觉得当初选错了），
   * 没有这个端点就只能去文件系统里删状态文件才能把它捞回来。
   */
  async function handleConflictUnresolve(req, res) {
    const body = await readJsonBody(req)
    const path = String(body.path || '').trim()
    if (path === '') throw Object.assign(new Error('需要 path'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const result = await unresolveConflict(root, path)
    send(res, 200, { ok: true, ...result })
  }

  // ── 目录 / 标签的增删（左栏右键菜单用）────────────────────────────────────

  /**
   * 新建目录。
   *
   * 左栏「目录」标题行右侧的「+」走这里。空目录建完在树上暂时看不见
   * （scanVault 只收 .md），返回里带 `empty: true` 让面板提示一句，
   * 否则用户会以为没建成又点一次。
   */
  async function handleCreateDir(req, res) {
    const body = await readJsonBody(req)
    const dir = String(body.dir || body.path || '').trim()
    if (dir === '') throw Object.assign(new Error('目录名不能为空'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const result = await createDir(root, dir)
    send(res, 200, { ok: true, empty: true, ...result })
  }

  /** 删除目录（只允许空目录，非空回 409 并告诉用户还有几篇）。 */
  async function handleDeleteDir(req, res) {
    const body = await readJsonBody(req)
    const dir = String(body.dir || body.path || '').trim()
    if (dir === '') throw Object.assign(new Error('需要 dir'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const result = await removeDir(root, dir)
    send(res, 200, { ok: true, ...result })
  }

  /**
   * 彻底去掉一个标签（从所有带这个标签的笔记里抹掉）。
   *
   * 标签不是独立实体，删标签等于批量改 frontmatter，所以要现扫一遍全库
   * 拿到真实条目（不能用前端传来的列表，那个可能是过滤后的子集）。
   */
  async function handleDeleteTag(req, res) {
    const body = await readJsonBody(req)
    const tag = String(body.tag || '').trim()
    if (tag === '') throw Object.assign(new Error('需要 tag'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const { entries } = await getScan(root)
    // 走版本历史而不是给每篇留 .bak：批量删标签可能一次改几十篇，
    // 留 .bak 会在库里堆出几十个看不见的副本。
    const result = await removeTag(root, tag, entries, {
      snapshot: async (rel) => {
        await snapshotNote(root, rel)
      },
    })
    send(res, 200, result)
  }

  /**
   * 标签改名（所有带这个标签的笔记一起改）。
   *
   * 和删标签一样要现扫全库：标签只存在 frontmatter 里，面板手上的列表可能是
   * 过滤后的子集，按子集改会漏掉一部分笔记，留下「一半改了名字一半没改」的状态。
   */
  async function handleRenameTag(req, res) {
    const body = await readJsonBody(req)
    const from = String(body.from || body.tag || '').trim()
    const to = String(body.to || body.name || '').trim()
    if (from === '') throw Object.assign(new Error('需要 from（原标签名）'), { status: 400 })
    if (to === '') throw Object.assign(new Error('新标签名不能为空'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const { entries } = await getScan(root)
    const result = await renameTag(root, from, to, entries, {
      snapshot: async (rel) => {
        await snapshotNote(root, rel)
      },
    })
    send(res, 200, result)
  }

  // ── 待办勾选 ──────────────────────────────────────────────────────────────

  /**
   * 勾掉正文里第 index 个待办。
   *
   * 只改正文里那一个方框字符：用户可能写了 `- [x] 买牛奶  #生活`，整行重建会
   * 把缩进、bullet 样式、行尾的额外内容一起丢掉。
   */
  async function handleToggleTodo(req, res) {
    const body = await readJsonBody(req)
    const path = String(body.path || '').trim()
    if (path === '') throw Object.assign(new Error('需要 path（笔记路径）'), { status: 400 })
    const index = Number(body.index)
    if (!Number.isInteger(index) || index < 0) {
      throw Object.assign(new Error('需要 index（第几个待办，从 0 开始）'), { status: 400 })
    }
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const result = await toggleTodo(root, path, index, {
      snapshot: async (rel) => {
        await snapshotNote(root, rel)
      },
    })
    send(res, 200, result)
  }

  // ── 版本历史（C2）─────────────────────────────────────────────────────────

  async function handleHistoryList(res, url) {
    const { root, missing } = await currentRoot()
    const path = url.searchParams.get('path') || ''
    if (missing || path === '') return send(res, 200, { path, items: [], count: 0 })
    const items = await listHistory(root, path)
    send(res, 200, { path, items, count: items.length })
  }

  async function handleHistoryRead(res, url) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const path = url.searchParams.get('path') || ''
    const name = url.searchParams.get('name') || ''
    const entry = await readHistoryEntry(root, path, name)
    send(res, 200, entry)
  }

  async function handleHistoryRestore(req, res) {
    const body = await readJsonBody(req)
    const path = String(body.path || '').trim()
    const name = String(body.name || '').trim()
    if (path === '' || name === '') throw Object.assign(new Error('需要 path 与 name'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const result = await restoreHistoryEntry(root, path, name, { keepCurrent: body.keepCurrent !== false })
    send(res, 200, { ok: true, ...result })
  }

  // ── 整库导出 / 导入（C1）──────────────────────────────────────────────────

  /**
   * 导出整库 zip。
   *
   * 走 GET 且直接写二进制流，不用 JSON 包 base64——几十上百 MB 的库
   * base64 一遍会膨胀 33%，浏览器拼 Blob 时还要再拷一次。
   */
  async function handleArchiveExport(req, res) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const result = await exportVaultToZip(root)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(result.buffer.length),
      // 用 attachment 让浏览器直接落盘；文件名带时间戳，重复导出不会互相覆盖
      'content-disposition': `attachment; filename="getnote-vault-${stamp}.zip"; filename*=UTF-8''getnote-vault-${stamp}.zip`,
      'cache-control': 'no-store',
      'x-getnote-entries': String(result.entries.length),
    })
    res.end(result.buffer)
  }

  /** 不导出，只报「会导出多少」——面板上先给用户看一眼再点下载。 */
  async function handleArchiveInfo(res) {
    const { root, missing } = await currentRoot()
    if (missing) return send(res, 200, { notes: 0, bytes: 0, files: 0 })
    const { entries } = await getScan(root)
    let bytes = 0
    for (const entry of entries) bytes += entry.bytes || 0
    // 附件大小单独算：用户在决定要不要导出前，最关心的是「会不会很大」
    let assetBytes = 0
    let assetCount = 0
    try {
      const dirs = new Set()
      for (const entry of entries) {
        const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
        dirs.add(dir === '' ? 'asset' : `${dir}/asset`)
      }
      for (const dir of dirs) {
        const { abs } = resolveInside(root, `${dir}/.`, { create: false })
        let names
        try {
          names = await readdir(abs)
        } catch {
          continue
        }
        for (const name of names) {
          try {
            const st = await stat(join(abs, name))
            if (st.isFile()) {
              assetBytes += st.size
              assetCount += 1
            }
          } catch {
            // 单个文件读不到就跳过
          }
        }
      }
    } catch {
      // 附件统计失败不影响主统计
    }
    send(res, 200, { notes: entries.length, bytes, files: entries.length + assetCount, assetBytes, assetCount })
  }

  async function handleArchiveImport(req, res) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    // zip 走二进制 body，上限放宽到 512MB（readBody 的默认上限是给 JSON 用的 2MB）
    // 512MB 只是「绝不接受更大」的天花板，不是生产上限：readBufferBody 会把
  // 整个 body 收进内存再 concat（峰值约 2 倍），几个并发就能把宿主进程撑爆。
  // 这个插件导出的包远到不了这个量级，收到实际能用的上限。
  const buffer = await readBufferBody(req, 128 * 1024 * 1024, res)
    const mode = req.headers['x-getnote-import-mode'] === 'skip' ? 'skip' : 'rename'
    const result = await importZipToVault(root, buffer, { mode })
    send(res, 200, { ok: true, ...result })
  }

  /**
   * 往笔记的附件目录里存一张图（面板里粘贴/拖拽用）。
   *
   * 为什么走二进制 body 而不是 JSON+base64：一张截图 base64 之后要占 1.37 倍，
   * 20MB 的图会变成 27MB 的字符串，JSON.parse 那一下足够让面板卡住两秒。
   * 扩展名放 header 里，body 就是原始字节。
   */
  async function handleAssetUpload(req, res, url) {
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const rel = url.searchParams.get('path') || ''
    if (rel === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    const raw = String(req.headers['x-getnote-ext'] || '').trim()
    const ext = raw === '' ? '' : raw.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (ext === '') throw Object.assign(new Error('缺少 x-getnote-ext（文件扩展名）'), { status: 400 })
    const buffer = await readBufferBody(req, 32 * 1024 * 1024, res)
    const saved = await saveAsset(root, rel, buffer, ext)
    // 立刻失效扫描缓存：附件不影响笔记列表，但 handleRead 会带 assets，
    // 面板保存后马上重读一次就要能看到刚粘的图。
    invalidateScan(root)
    send(res, 200, saved)
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

  /**
   * 把当前笔记「链」到另一篇：在正文末尾追加一行双链 [[目标]]。
   * 只做单向（当前篇出一条边指向目标）——反向关系由关系图页根据全部双链自动画，
   * 不需要在这里补齐。幂等：目标已经是本篇出链时不追加。
   */
  async function handleLink(req, res) {
    const body = await readJsonBody(req, 32 * 1024)
    const path = typeof body.path === "string" && body.path !== "" ? body.path : ""
    const target = typeof body.target === "string" ? body.target.trim() : ""
    if (path === "") throw Object.assign(new Error("需要 path（当前笔记）"), { status: 400 })
    if (target === "") throw Object.assign(new Error("需要 target（要连到哪篇笔记）"), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error("本地库目录不存在"), { status: 404 })

    const note = await readNote(root, path)
    const currentLinks = extractWikiLinks(note.content)
    // 目标已是本篇出链的一种写法就算连过（[[目标]] / [[目标.md]] / [[路径/目标]]）
    const targetBase = target.replace(/^.*\//, "").replace(/\.md$/i, "")
    const isLinked = Array.from(currentLinks).some(
      (l) => l.replace(/\.[^/]*$/, "").replace(/^.*\//, "") === targetBase,
    )
    if (isLinked) {
      send(res, 200, { ok: true, already: true, links: Array.from(currentLinks) })
      return
    }
    const linkLine = `[[${targetBase}]]`
    const bodySep = note.content.endsWith("\n") ? "" : "\n"
    const updated = note.content + bodySep + linkLine + "\n"
    try {
      await snapshotNote(root, path)
    } catch {
      // 历史是附加价值，不是写链接的前置条件
    }
    await writeNote(root, path, updated, { backup: false })
    invalidateScan(root)
    send(res, 200, { ok: true, already: false, links: Array.from(extractWikiLinks(updated)) })
  }
  async function handleSave(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const { root } = await currentRoot()
    const path = typeof body.path === 'string' ? body.path : ''
    if (path === '') throw Object.assign(new Error('path 不能为空'), { status: 400 })
    // content 必须是字符串。不能「缺字段就当空串」：客户端字段名写错、老版本
    // 面板、或者别的调用方少传一个 key，都会把这篇笔记整篇覆盖成 0 字节，而
    // 用户看到的是「保存成功」。实测 618 字节的笔记就是这样没的。
    if (typeof body.content !== 'string') {
      throw Object.assign(new Error('content 必须是字符串（缺这个字段会清空笔记）'), { status: 400 })
    }
    const content = body.content
    // 覆盖前先留一版历史：用户在面板里改完保存、过两天想找「之前那段话」，
    // 历史是唯一退路。存不下不该阻塞保存本身，所以整段吞掉错误。
    let snapshotted = false
    try {
      await snapshotNote(root, path)
      snapshotted = true
    } catch {
      // 历史是附加价值，不是保存的前置条件
    }
    // 唯一「历史没存上 + 新内容是空的」的组合要拦一下：这时没有任何退路，
    // 一次误落就会把正文抹掉。用户真想清空笔记，留一个字都比全空安全。
    if (!snapshotted && content === '') {
      const previous = await readNote(root, path).catch(() => null)
      if (previous !== null && previous.content !== '') {
        throw Object.assign(new Error('这次保存会清空笔记，且历史没存上，已拒绝'), { status: 409 })
      }
    }
    // backup:false — 已经有历史了，再留 .bak 只会让库里多出一个
    // 用户看不到、删不掉的副本（`.bak` 不在扫描范围内，等于永久垃圾）。
    const saved = await writeNote(root, path, content, { backup: false })
    send(res, 200, { ok: true, ...saved })
  }

  /**
   * 批量操作（D2）：加标签 / 移目录 / 删除。
   *
   * 逐篇处理而不是「先校验全部再统一写」：中途某篇失败时，已经成功的
   * 那些不该回滚——用户选了 20 篇，19 篇成功、1 篇因为文件被占用失败，
   * 回滚掉那 19 篇等于让他重来一遍。所以返回里带 failed 明细。
   */
  async function handleBatch(req, res) {
    const body = await readJsonBody(req, MAX_BODY)
    const action = String(body.action || '')
    const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string' && p !== '') : []
    if (paths.length === 0) throw Object.assign(new Error('需要 paths'), { status: 400 })
    if (action !== 'tag' && action !== 'move' && action !== 'delete') {
      throw Object.assign(new Error('action 只能是 tag / move / delete'), { status: 400 })
    }
    const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
    const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
    if (action === 'tag' && tag === '') throw Object.assign(new Error('需要 tag'), { status: 400 })
    if (action === 'move' && dir === '') throw Object.assign(new Error('需要 dir'), { status: 400 })
    const { root, missing } = await currentRoot()
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })

    let changed = 0
    const failed = []
    for (const path of paths) {
      try {
        if (action === 'delete') {
          try {
            await snapshotNote(root, path)
          } catch {
            // 历史不是删除的前置条件
          }
          await trashNote(root, path)
          changed += 1
          continue
        }
        const note = await readNote(root, path)
        if (action === 'tag') {
          // 加标签要改 frontmatter。用 rewriteTags 而不是自己拼字符串：
          // 块列表写法（tags: 换行后跟 `- 甲`）下只替换第一行会留下一堆
          // 悬空列表项，文件看着「标签加上了但旧标签还挂在下面」。
          const meta = note.frontmatter || {}
          const text = note.content
          const actual = readTags(text)
          const current = actual.length > 0 ? actual : normalizeTags(meta.tags)
          if (current.includes(tag)) {
            changed += 1
            continue
          }
          const updated = rewriteTags(text, [...current, tag])
          // 同上：批量加标签走历史，不留 .bak
          try {
            await snapshotNote(root, path)
          } catch {
            // 历史不是加标签的前置条件
          }
          await writeNote(root, path, updated, { backup: false })
          changed += 1
        } else {
          // 移目录：直接把文件搬到 <dir>/<basename>，**保留原文件名**。
          // 早先的实现走 createNote 重新生成文件名，结果 `2026-11-15-标题.md`
          // 变成 `标题.md`——日期前缀是用户归档库的命名约定，不能因为搬个目录
          // 就丢掉。目标已存在时加 -2/-3 后缀，绝不覆盖。
          const base = path.split('/').pop()
          if (dir + '/' + base === path) {
            changed += 1
            continue
          }
          const { abs: srcAbs } = resolveInside(root, path)
          let finalName = base
          let targetAbs = resolveInside(root, `${dir}/${base}`, { create: true }).abs
          await mkdir(dirname(targetAbs), { recursive: true })
          let suffix = 2
          // 存在性检查用 access，避免 rename 在 Windows 上静默覆盖
          for (;;) {
            try {
              await access(targetAbs)
              finalName = base.replace(/(\.md)$/i, `-${suffix}$1`)
              targetAbs = resolveInside(root, `${dir}/${finalName}`, { create: true }).abs
              suffix += 1
            } catch {
              break
            }
          }
          await rename(srcAbs, targetAbs)
          changed += 1
        }
      } catch (err) {
        failed.push({ path, error: err && err.message ? err.message : String(err) })
      }
    }
    send(res, 200, { ok: true, changed, failed, total: paths.length })
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
    // 删前留一版历史：回收站能救回「整篇被删」，但救不回「删了以后又新建
    // 了同名文件、回收站里那份被顶掉」这种情况；历史是按内容留的，更稳。
    try {
      await snapshotNote(root, path)
    } catch {
      // 同上：历史不是删除的前置条件
    }
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

  // ── 单篇同步（B1）────────────────────────────────────────────────────────

  /**
   * 「这一篇要云端最新版」：直接拉这篇的详情刷到本地。
   *
   * 不走整轮 runSync，因为整轮要翻页扫全部笔记（十几页 HTTP，几秒到几十秒），
   * 而用户此刻只想让眼前这一篇对上。singleNote 是同步引擎里现成的单篇路径。
   */
  async function handleSyncPullOne(req, res) {
    const body = await readJsonBody(req)
    const path = String(body.path || '').trim()
    const noteId = String(body.noteId || '').trim()
    if (path === '' && noteId === '') {
      throw Object.assign(new Error('需要 path 或 noteId'), { status: 400 })
    }
    const settings = await readSettings()
    const { root, missing } = await resolveVaultRoot(settings.vaultRoot || config.vaultPath || null)
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const client = await openCloudClient()
    const state = await readSyncState()
    const id = noteId !== '' ? noteId : await noteIdOfPath(root, path, state)
    if (id === '') throw Object.assign(new Error('这篇笔记没有 note_id，无从刷新'), { status: 400 })
    const outcome = await syncSingleNote({ client, root, state, noteId: id })
    await writeSyncState(state)
    let note = null
    try {
      note = await readNote(root, outcome.path || path)
    } catch {
      note = null
    }
    send(res, 200, { ok: true, outcome, note, noteId: id })
  }

  /**
   * 「这一篇以我本地为准」：把本地正文推到云端，覆盖云端。
   *
   * 和 /sync/push 的区别只有一点：这里在推送成功后**顺手刷新 state 里的
   * 云端指纹**，否则下一轮同步会看到「本地指纹 ≠ 记录的本地指纹」，判定
   * 用户改过、而云端刚被我们改过 → 又写一个 .conflicts 留档，用户会觉得
   * 自己明明刚推过、却莫名多了个冲突文件。
   */
  async function handleSyncPushOne(req, res) {
    const body = await readJsonBody(req)
    const path = String(body.path || '').trim()
    if (path === '') throw Object.assign(new Error('需要 path'), { status: 400 })
    const settings = await readSettings()
    const { root, missing } = await resolveVaultRoot(settings.vaultRoot || config.vaultPath || null)
    if (missing) throw Object.assign(new Error(`本地库目录不存在：${missing}`), { status: 404 })
    const client = await openCloudClient()
    const result = await pushLocalNote({ client, root, relPath: path })
    // 推送成功后刷新这一篇的指纹记录：只记 note_id 不记指纹的话，下一轮同步
    // 会看到「本地指纹 ≠ 记录里的本地指纹」判成用户改过、而云端此刻正是我们
    // 刚推上去的版本 → 又生成一个 .conflicts 留档，用户会觉得「我明明推过了
    // 怎么冒出一个冲突文件」。
    if (result.noteId) {
      const state = await readSyncState()
      const key = String(result.noteId)
      const prev = state.notes && state.notes[key] ? state.notes[key] : {}
      let localFp = prev.localFp
      let cloudFp = prev.cloudFp
      try {
        // localFingerprintOf 收的是绝对路径（它直接 readFile），所以这里要过
        // resolveInside 转换一次，不能把库相对路径直接传进去。
        localFp = await localFingerprintOf(resolveInside(root, path).abs)
        const fresh = await client.getNote(key)
        if (fresh) cloudFp = contentFingerprint(fresh)
      } catch {
        // 拿不到就保留旧值，总比记成 undefined 好
      }
      state.notes = state.notes || {}
      state.notes[key] = { ...prev, path, localFp, cloudFp }
      await writeSyncState(state)
    }
    send(res, 200, { ok: true, result })
  }

  /** 从 state 里反查某条本地路径对应的云端 note_id。 */
  async function noteIdOfPath(root, path, state) {
    if (path === '') return ''
    const notes = state && state.notes ? state.notes : {}
    for (const [id, record] of Object.entries(notes)) {
      if (record && record.path === path) return String(id)
    }
    // state 里没记过（比如用户自己新建的笔记）：读 frontmatter 里的 note_id
    try {
      const note = await readNote(root, path)
      const fm = note.frontmatter || {}
      if (fm.note_id !== undefined && fm.note_id !== null) return String(fm.note_id)
    } catch {
      // 读不到就认命
    }
    return ''
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
    // 主题色：'themeColor' in body 才写，因为 null 是「恢复默认配色」这个真实动作，
    // 用 !== undefined 判断会把 null 当成「没传」，用户就恢复不了。
    if ('themeColor' in body) patch.themeColor = body.themeColor
    // 深色模式开关。只接受布尔值：真值判断会让 "false" 这种字符串变成 true。
    if (typeof body.darkMode === 'boolean') patch.darkMode = body.darkMode
    // 关系图配色：'graphColor' in body 才写，因为 null 是「恢复默认浅蓝」
    if ('graphColor' in body) patch.graphColor = body.graphColor
    // 界面语言同理：null 是「自动」这个真实选项
    if ('uiLocale' in body) patch.uiLocale = body.uiLocale
    // 自定义模板：整组替换（空数组＝清空），不是逐项合并
    if ('templates' in body) patch.templates = body.templates
    if (Object.keys(patch).length > 0) await updateSettings(patch)
    const settings = await readSettings()
    const { root } = await resolveVaultRoot(settings.vaultRoot || config.vaultPath || null)
    send(res, 200, { ok: true, ...settings, effectiveRoot: root })
  }

  // ── 应用内升级 ─────────────────────────────────────────────────────────────

  /**
   * 检查新版本。
   *
   * 断网/连不上发布源是**最常见**的情况，绝不能报成 500「检查失败」——
   * 用户会以为插件坏了。所以这里把离线单独识别出来，回 200 + offline 标记，
   * 让面板能说「连不上发布源，稍后再试」而不是「错误」。
   */
  async function handleUpdateCheck(res) {
    try {
      const info = await checkForUpdate()
      send(res, 200, { ok: true, offline: false, ...info })
    } catch (error) {
      if (error && error.offline) {
        const own = await readOwnPackage()
        return send(res, 200, { ok: true, offline: true, current: own.version, latest: '', available: false, tarball: '' })
      }
      throw error
    }
  }

  /** 下载并原地升级。返回 restartRequired 由面板提示用户重启 DSH。 */
  async function handleUpdateApply(res) {
    const result = await applyUpdate()
    send(res, 200, result)
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
  /**
   * 把 MCP 的章节数据收敛成前端好渲染的形状。
   *
   * 不同来源（Open API 详情 / MCP get_note_chapters）字段名不统一，这里对每个
   * 字段都做回退；拿不到就返回空数组，前端据此不显示章节块——**绝不编造章节**，
   * 编出来的章节点了会跳到错误的位置。
   */
  function normalizeChapters(input) {
    const list = Array.isArray(input)
      ? input
      : input && Array.isArray(input.chapters)
        ? input.chapters
        : input && Array.isArray(input.items)
          ? input.items
          : []
    const out = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const title = String(item.title ?? item.name ?? item.text ?? '').trim()
      if (title === '') continue
      const rawStart = item.start_ms ?? item.startMs ?? item.start
      const startMs = typeof rawStart === 'number' && Number.isFinite(rawStart) ? rawStart : null
      out.push({ title, startMs })
    }
    return out
  }

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
    // 章节（智能总结的小标题 + 时间点）。只有 MCP 通道有 getChapters，
    // Open API 走的是 raw.chapters / raw.timeline.chapters；两条都试，
    // 都拿不到就算了——章节是锦上添花，不能因为它失败让整篇笔记打不开。
    let chapters = normalizeChapters(raw.chapters ?? (raw.timeline ? raw.timeline.chapters : null))
    if (chapters.length === 0 && typeof client.getChapters === 'function') {
      try {
        chapters = normalizeChapters(await client.getChapters(noteId))
      } catch {
        chapters = []
      }
    }
    send(res, 200, {
      note: normalizeNote(raw),
      raw,
      chapters,
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
    // redirect 必须 manual：'follow' 只校验了第一跳，CDN 只要 302 到
    // http://127.0.0.1:内网端口/... 这个端点就成了能打内网的代理。
    // 每一跳都重新过一遍白名单，最多 5 跳。
    let upstream = null
    let next = target
    for (let hop = 0; hop < 5; hop += 1) {
      const response = await fetch(next, {
        headers: {
          // 支持 Range：音频拖动进度条要靠它，否则每次都要从头下整个文件
          ...(typeof range === 'string' ? { Range: range } : {}),
          // 有些 CDN 要求带 Referer 才给音频
          Referer: 'https://www.biji.com/',
          'User-Agent': 'Mozilla/5.0 (dsh-getnote)',
        },
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        let hopUrl = null
        try {
          hopUrl = new URL(location, next)
        } catch {
          throw Object.assign(new Error('CDN 返回了不合法的跳转地址'), { status: 502 })
        }
        const hopHost = hopUrl.hostname.toLowerCase()
        if (!/^https?:$/.test(hopUrl.protocol) || !AUDIO_HOST_ALLOWLIST.some((suffix) => hopHost === suffix || hopHost.endsWith('.' + suffix))) {
          throw Object.assign(new Error('CDN 跳转到了不允许的域名：' + hopHost), { status: 403 })
        }
        next = hopUrl.toString()
        continue
      }
      upstream = response
      break
    }
    if (upstream === null) throw Object.assign(new Error('CDN 跳转次数过多'), { status: 502 })
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
    const scan = await getScan(root)
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

  // ── 录音卡直连（本地 BLE）───────────────────────────────────────────────

  /** 环境自检：Python 与 bleak 在不在。不碰蓝牙，很快。 */
  async function handleCardEnv(res) {
    const env = await checkCardEnvironment()
    return send(res, 200, { ok: true, ...env, running: cardState.running })
  }

  /** 扫描附近的录音卡（广播名 Get-XXXXXX）。 */
  async function handleCardScan(res, url) {
    const timeout = Number(url.searchParams.get('timeout') || 8)
    const safeTimeout = Number.isFinite(timeout) ? Math.min(20, Math.max(4, Math.round(timeout))) : 8
    const found = await scanCard(safeTimeout)
    return send(res, 200, { ok: true, ...found })
  }

  /** 卡片状态：设备时间 / MTU / 剩余空间 / 待导入条数。 */
  async function handleCardInfo(res) {
    const info = await cardInfo()
    return send(res, 200, { ok: true, ...info })
  }

  /** 卡片上的录音文件列表。 */
  async function handleCardList(res) {
    const files = await listCardFiles()
    return send(res, 200, { ok: true, files, count: files.length })
  }

  /** 导入进度（面板轮询这个）。 */
  function handleCardStatus(res) {
    return send(res, 200, {
      ok: true,
      running: cardState.running,
      startedAt: cardState.startedAt,
      finishedAt: cardState.finishedAt,
      lines: cardState.lines,
      result: cardState.result,
      error: cardState.error,
    })
  }

  /**
   * 把卡片上的录音导入笔记库。
   *
   * 立刻返回、后台跑：一小时录音要传十几分钟，同步等会让面板转圈转到用户以为卡死。
   * 进度走 /card/status 轮询。
   */
  async function handleCardImport(req, res) {
    if (cardState.running) {
      return send(res, 200, {
        ok: false,
        running: true,
        error: '已经有一个录音卡导入在跑了，等它结束再试',
      })
    }
    const body = await readJsonBody(req)
    // resolveVaultRoot 收的是「配置里的那个路径字符串」，不是 settings 对象。
    const settings = await readSettings()
    const { root, missing } = await resolveVaultRoot(settings.vaultRoot || config.vaultPath || null)
    if (missing || root === null) {
      throw Object.assign(new Error('笔记库目录不存在，先去设置里选一个目录'), { status: 400 })
    }
    const env = await checkCardEnvironment()
    if (!env.ready) {
      throw Object.assign(
        new Error(
          env.error ||
            '录音卡直连需要 Python 3.10+ 和 bleak。装一下：pip install bleak',
        ),
        { status: 503, reason: 'no-python' },
      )
    }

    cardState.running = true
    cardState.startedAt = new Date().toISOString()
    cardState.finishedAt = null
    cardState.lines = []
    cardState.result = null
    cardState.error = null

    const push = (line) => {
      cardState.lines.push(String(line))
      if (cardState.lines.length > CARD_MAX_LINES) cardState.lines.shift()
    }

    const options = {
      all: body.all !== false,
      names: typeof body.names === 'string' ? body.names : '',
      deleteAfter: body.deleteAfter === true,
      dir: typeof body.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : '录音卡',
      log: push,
    }

    void (async () => {
      try {
        const result = await importCardRecordings(root, options)
        cardState.result = result
        if (result.failed > 0) {
          cardState.error = `${result.failed} 个文件导入失败，详情看日志`
        }
      } catch (error) {
        cardState.error = error && error.message ? error.message : String(error)
        push(`出错：${cardState.error}`)
      } finally {
        cardState.running = false
        cardState.finishedAt = new Date().toISOString()
      }
    })()

    return send(res, 200, { ok: true, running: true, startedAt: cardState.startedAt })
  }

  /** 删掉卡片上的指定文件。不可恢复，必须显式传 names。 */
  async function handleCardDelete(req, res) {
    const body = await readJsonBody(req)
    if (typeof body.names !== 'string' || body.names.trim() === '') {
      throw Object.assign(new Error('要删哪个文件？names 不能为空'), { status: 400 })
    }
    const result = await deleteCardFiles(body.names)
    return send(res, 200, { ok: true, ...result })
  }

  // ── 录音卡热点快传 ──────────────────────────────────────────────────────────
  //
  // 为什么要走热点：BLE 实测约 25 KB/s，一小时录音 56 MB 要传四十分钟；连上
  // 卡片自己的 SoftAP 走 HTTP 通常能到 1 MB/s 以上。BLE 仍然是控制面（负责
  // 让卡片把热点打开），WiFi 只是数据面。
  //
  // 三个动作刻意拆开：激活（BLE 让卡片开热点）、连接（改本机 WLAN 配置去连它）、
  // 退出（把本机网络恢复原样）。混成一个动作的话，「卡住了」和「连上了但没找到
  // 服务」这两种完全不同的失败会报成同一句话，用户不知道该先动哪里。

  /** 只看当前网络状况，不改任何设置。 */
  async function handleCardWifiScan(res) {
    const result = await wifiScan()
    return send(res, 200, result)
  }

  /**
   * 用 BLE 激活卡片热点，然后连上去找传输服务。
   *
   * 这个 handler 会改本机 WLAN 配置，所以无论成败都在 finally 里确保：
   * 要么已经连上并找到了服务，要么把网络恢复原样。最坏情况是「激活失败」——
   * 那时根本没连过热点，不需要恢复，但代码仍然走同一条路径，避免漏分支。
   */
  async function handleCardWifiActivate(req, res) {
    const body = await readJsonBody(req)
    const cmd = typeof body.cmd === 'string' && body.cmd.trim() !== '' ? body.cmd.trim() : null
    const bodyHex = typeof body.body === 'string' && body.body.trim() !== '' ? body.body.trim() : null
    const join = body.join !== false
    // keep 是给排查用的：留着热点让用户自己去看。默认必须恢复网络。
    const keep = body.keep === true
    const wait = Number.isFinite(Number(body.wait)) ? Number(body.wait) : 3
    const result = await wifiActivate({ cmd, body: bodyHex, join, keep, wait })
    return send(res, 200, result)
  }

  /** 手动连一个已知热点。卡片热点名/密码从 BLE 通知里拿不到时，用户还能手输。 */
  async function handleCardWifiJoin(req, res) {
    const body = await readJsonBody(req)
    const ssid = typeof body.ssid === 'string' ? body.ssid.trim() : ''
    if (ssid === '') throw Object.assign(new Error('要连哪个热点？ssid 不能为空'), { status: 400 })
    const password = typeof body.password === 'string' && body.password !== '' ? body.password : null
    const keep = body.keep === true
    const timeout = Number.isFinite(Number(body.timeout)) ? Number(body.timeout) : 30
    const result = await wifiJoin({ ssid, password, keep, timeout })
    return send(res, 200, result)
  }

  /** 退出卡片热点并删掉 profile。面板在任何失败路径上都应该调它兜底。 */
  async function handleCardWifiLeave(req, res) {
    const result = await wifiLeave()
    return send(res, 200, result)
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
    if (typeof body.foregroundOnly === 'boolean') patch.autoSyncForegroundOnly = body.foregroundOnly
    // 面板上报自己「现在可见」时走这里：仅前台模式下，定时器靠这个时间戳
    // 判断背后还有没有人在看。单独一个字段而不复用 sync/auto，是因为这个
    // 心跳每几秒就来一次，不该每次都去重写设置文件（磁盘写放大）。
    if (body.ping === true) {
      syncState.lastPanelSeenAt = Date.now()
      // 顺带把库内容版本号带回去：面板比对到它变了就知道「别处改了文件」，
      // 不用再为这件事单独开一个轮询端点。
      return send(res, 200, {
        ok: true,
        pong: true,
        foregroundOnly: (await readSettings()).autoSyncForegroundOnly,
        vaultVersion: vaultVersion(),
      })
    }
    const settings = await updateSettings(patch)
    send(res, 200, {
      ok: true,
      enabled: settings.autoSync,
      minutes: settings.autoSyncMinutes,
      incremental: settings.autoSyncIncremental,
      foregroundOnly: settings.autoSyncForegroundOnly,
    })
  }

  /**
   * 只接受「从 DSH 自己的页面发出来」的请求。
   *
   * 为什么需要这道闸：这些路由挂在宿主的 webServer 上，默认谁都能调。
   * 用户在浏览器里随便打开一个网页，那个网页就能 POST `/getnote/delete` 把笔记删掉——
   * 插件市场给的那条警告说的正是这件事。判据用 Origin / Referer：跨站请求的
   * 这两个头由浏览器强制填成攻击者自己的地址，脚本改不了，所以比对宿主地址
   * 就能把跨站请求挡在门外。
   *
   * 三条放行规则，每条都有具体理由：
   * 1. 两个头都没有 → 放行。命令行 curl、脚本、测试都不发这两个头，它们不是
   *    「被别的网页借刀」的场景，挡掉只会让排障变难。
   * 2. Origin 或 Referer 与宿主地址一致 → 放行。同源的 GET 通常不带 Origin，
   *    所以 Referer 那条分支是必需的，不能只看 Origin。
   * 3. oauth/callback 例外 → 放行。它是一次从得到大脑那边的**整页跳转**，
   *    Referer 必然是对方站点，按上面的规则会被挡掉，登录就永远回不来。
   */
  // 可选的 panel token：在插件配置里设 apiToken 之后，所有 /getnote/* 请求都必须
  // 带 x-getnote-token。默认不设，保持脚本与测试的现有行为。
  // 它挡的是「浏览器里另一个网页」之外的另一类情况——本机上别的进程想要借道时，
  // 至少得先知道这个值。跨站脚本想加这个头会先触发 CORS 预检，本机路由不回预检头，
  // 所以对浏览器这一侧还是死路。
  const panelToken = typeof config.apiToken === 'string' ? config.apiToken.trim() : ''

  function guardRequest(req, res, url) {
    // token 是**额外**放行路径，不是唯一路径：面板自己的请求由浏览器发出、
    // 带同源 Origin/Referer，但带不上 token（面板并不知道它）。所以这里
    // 先让「带对 token 的调用方」直接过，其余照旧走 Origin/Referer 校验。
    if (panelToken !== '') {
      const given = String((req.headers && req.headers['x-getnote-token']) || '').trim()
      if (given !== '' && given === panelToken) return true
    }
    let expected = null
    try {
      expected = config.getOrigin()
    } catch {
      expected = null
    }
    // 拿不到宿主地址（宿主版本差异）时放行：宁可少一层防护，也不能让整个面板打不开。
    if (typeof expected !== 'string' || expected === '') return true
    const norm = (value) => String(value || '').trim().replace(/\/+$/, '')
    const target = norm(expected)
    const path = url && url.pathname ? url.pathname : ''
    if (path.startsWith(`${ROUTE_PREFIX}/oauth/callback`)) return true
    const origin = norm(req.headers && req.headers.origin)
    if (origin !== '') {
      if (origin === target) return true
      send(res, 403, { error: '只接受来自 DSH 面板的请求（跨站请求被拒绝）' })
      return false
    }
    const referer = norm(req.headers && req.headers.referer)
    if (referer !== '') {
      if (referer === target || referer.startsWith(`${target}/`)) return true
      send(res, 403, { error: '只接受来自 DSH 面板的请求（跨站请求被拒绝）' })
      return false
    }
    // 都没带 Origin/Referer：不是浏览器同源面板发来的（浏览器同源请求必定带
    // Referer 或 Origin 之一）。设了 apiToken 时这类裸调用必须拿出 token，
    // 否则本机任何进程都能借道；没设时维持原样放行，脚本才用得起来。
    if (panelToken !== '') {
      send(res, 403, { error: '缺少 x-getnote-token（插件配置里设了 apiToken）' })
      return false
    }
    return true
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

    // 跨站请求一律挡掉：这些路由挂在宿主的 webServer 上，默认谁都能调，
    // 浏览器里随便一个网页就能 POST /getnote/delete 把笔记删掉。
    if (!guardRequest(req, res, url)) return

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

      // 附件上传：走二进制 body，必须在 dispatchPost 之前分流（那里是 JSON 解析），
      // 也必须排在下面的 asset GET 分支之前——那个分支见到非 GET 会直接回 405。
      if (action === 'asset' && parts[2] === 'upload') {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        clearScanCache()
        try {
          return await handleAssetUpload(req, res, url)
        } finally {
          clearScanCache()
        }
      }

      // 本地附件（录音 / 图片 / 转写）同样是二进制流
      if (action === 'asset') {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return await handleAsset(req, res, url)
      }

      if (method === 'GET') {
        if (action === 'status') return await handleStatus(res)
        // 首屏一次拿全 status + tree：一次扫描、一个请求。老的两个端点保留，
        // 外部脚本和测试还在用，而且只要 status 的时候不该被迫传整棵树。
        if (action === 'bootstrap') return await handleBootstrap(req, res)
        // ?fresh=1 跳过扫描缓存：用户点刷新就是怀疑看到的是旧的，
        // 这时候还给他缓存等于骗他。
        if (action === 'tree') return await handleTree(req, res)
        if (action === 'list') return await handleList(res, url)
        if (action === 'trash' && parts[2] === 'list') return await handleTrashList(res)
        if (action === 'read') return await handleRead(res, url)
        if (action === 'search') return await handleSearch(res, url)
        if (action === 'backlinks') return await handleBacklinks(res, url)
      if (action === 'graph') return await handleGraph(res, url)
      if (action === 'related') return await handleRelated(res, url)
        if (action === 'settings') return await handleGetSettings(res)
        // 应用内升级：检查是 GET（只读发布源），应用是 POST（会写文件）
        if (action === 'update' && parts[2] === 'check') return await handleUpdateCheck(res)
        if (action === 'probe') return await handleProbe(req, res)
        if (action === 'import' && parts[2] === 'status') return handleImportStatus(res)
        // 冲突留档（B2）
        if (action === 'conflict' && parts[2] === 'list') return await handleConflictList(res)
        if (action === 'conflict' && parts[2] === 'read') return await handleConflictRead(res, url)
        // 版本历史（C2）
        if (action === 'history' && parts[2] === 'list') return await handleHistoryList(res, url)
        if (action === 'history' && parts[2] === 'read') return await handleHistoryRead(res, url)
        // 整库导出（C1）
        if (action === 'archive' && parts[2] === 'export') return await handleArchiveExport(req, res)
        if (action === 'archive' && parts[2] === 'info') return await handleArchiveInfo(res)
        // 云端（Open API）
        if (action === 'api' && parts[2] === 'probe') return await handleCloudProbe(res)
        if (action === 'cloud' && parts[2] === 'list') return await handleCloudList(res, url)
        if (action === 'cloud' && parts[2] === 'read') return await handleCloudRead(res, url)
        if (action === 'cloud' && parts[2] === 'topics') return await handleCloudTopics(res, url)
        if (action === 'cloud' && parts[2] === 'topic-notes') return await handleCloudTopicNotes(res, url)
        // 同步
        if (action === 'sync' && parts[2] === 'status') return handleSyncStatus(res)
        // 录音卡直连（本地 BLE，不经云端）
        if (action === 'card' && parts[2] === 'env') return await handleCardEnv(res)
        if (action === 'card' && parts[2] === 'scan') return await handleCardScan(res, url)
        if (action === 'card' && parts[2] === 'info') return await handleCardInfo(res)
        if (action === 'card' && parts[2] === 'list') return await handleCardList(res)
        if (action === 'card' && parts[2] === 'status') return handleCardStatus(res)
        // 热点快传：scan 只看网络状况，不改任何设置
        if (action === 'card' && parts[2] === 'wifi-scan') return await handleCardWifiScan(res)
      }

      if (method === 'POST') {
        // 任何 POST 都会改库（保存、改名、删标签、批量、导入、同步…），
        // 所以统一在前后各失效一次扫描缓存，而不是二十多个端点各记一遍。
        // 读端点（GET）不失效：它们正是缓存要服务的对象。
        clearScanCache()
        try {
          return await dispatchPost()
        } finally {
          clearScanCache()
        }
      }

      return send(res, 404, { error: `unknown action: ${action}` })
    } catch (error) {
      return fail(res, error)
    }

    async function dispatchPost() {
      if (action === 'update' && parts[2] === 'apply') return await handleUpdateApply(res)
      if (action === 'link' && parts[2] === 'create') return await handleLink(req, res)
      if (action === 'save') return await handleSave(req, res)
      if (action === 'batch') return await handleBatch(req, res)
      if (action === 'create') return await handleCreate(req, res)
      if (action === 'delete') return await handleDelete(req, res)
      // 目录 / 标签增删（左栏右键菜单 + 「+」按钮）
      if (action === 'dir' && parts[2] === 'create') return await handleCreateDir(req, res)
      if (action === 'dir' && parts[2] === 'delete') return await handleDeleteDir(req, res)
      if (action === 'tag' && parts[2] === 'delete') return await handleDeleteTag(req, res)
      if (action === 'tag' && parts[2] === 'rename') return await handleRenameTag(req, res)
      // 待办勾选：只翻正文里那一个方框，其余原样
      if (action === 'todo' && parts[2] === 'toggle') return await handleToggleTodo(req, res)
      if (action === 'trash' && parts[2] === 'restore') return await handleTrashRestore(req, res)
      if (action === 'trash' && parts[2] === 'purge') return await handleTrashPurge(req, res)
      if (action === 'settings') return await handleSetSettings(req, res)
      if (action === 'import') return await handleImport(req, res)
      // 冲突解决（B2）
      if (action === 'conflict' && parts[2] === 'resolve') return await handleConflictResolve(req, res)
      if (action === 'conflict' && parts[2] === 'unresolve') return await handleConflictUnresolve(req, res)
      // 版本历史恢复（C2）
      if (action === 'history' && parts[2] === 'restore') return await handleHistoryRestore(req, res)
      // 整库导入（C1）
      if (action === 'archive' && parts[2] === 'import') return await handleArchiveImport(req, res)
      // 录音卡直连：导入 / 删除卡片文件
      if (action === 'card' && parts[2] === 'import') return await handleCardImport(req, res)
      if (action === 'card' && parts[2] === 'delete') return await handleCardDelete(req, res)
      // 热点快传：激活 / 连接 / 退出。三者分开，是因为「激活失败」和
      // 「连上了但没找到服务」要能分别报给用户，混成一个动作就说不清了。
      if (action === 'card' && parts[2] === 'wifi-activate') return await handleCardWifiActivate(req, res)
      if (action === 'card' && parts[2] === 'wifi-join') return await handleCardWifiJoin(req, res)
      if (action === 'card' && parts[2] === 'wifi-leave') return await handleCardWifiLeave(req, res)
      // 单篇同步（B1）
      if (action === 'sync' && parts[2] === 'pull-one') return await handleSyncPullOne(req, res)
      if (action === 'sync' && parts[2] === 'push-one') return await handleSyncPushOne(req, res)
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

      return send(res, 404, { error: `unknown action: ${action}` })
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
    const scan = await getScan(root)
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
    // 可选的 panel token：设了之后非浏览器同源的裸调用必须带 x-getnote-token。
    // 放在这里而不是另立 Config（导出 Config 会让 cordis Loader 在
    // schemastery 校验上炸掉），跟 vaultPath 一样走宽松归一。
    apiToken: typeof raw.apiToken === 'string' ? raw.apiToken.trim() : '',
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
      // 仅前台运行：面板每次可见时上报心跳，超时没心跳就当没人在看。
      // 时间窗给 3 分钟（心跳本身 20 秒一次），足够容忍渲染器卡顿或用户
      // 切走一下回来，又不会在用户真正离开后继续花配额。
      if (settings.autoSyncForegroundOnly) {
        const seen = syncState.lastPanelSeenAt || 0
        if (Date.now() - seen > PANEL_VISIBLE_MS) return
      }
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

  ctx.effect(() => () => {
    // 插件被停用/重载时关掉文件监听：fs.watch 在 Windows 上会占住目录句柄，
    // 不关的话重载几次就攒下几个监听器，同一份改动被处理好几遍。
    stopWatch()
  }, 'dsh-getnote: 库目录文件监听')
}

export { excerptOf, parseFrontmatter }
