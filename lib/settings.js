/**
 * dsh-getnote — 设置与凭证的持久化（host 侧）
 *
 * 所有状态都落在 $DSH_HOME 下，**不进浏览器、不进 localStorage**：
 *   · $DSH_HOME/dsh-getnote.json        —— 本地库路径等用户设置
 *   · $DSH_HOME/dsh-getnote/auth.json   —— 得到大脑 OAuth 凭证（0600）
 *
 * 设计前提（本插件的产品定位）：会员可能到期，云端随时会断。所以这里保存的一切
 * 都只是**可选同步通道**的状态；删掉 auth.json 之后插件仍然完整可用——因为笔记的
 * 真身是本地库里的 Markdown 文件。
 */
import { readFile, writeFile, rename, mkdir, chmod, realpath, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const SETTINGS_FILENAME = 'dsh-getnote.json'
const AUTH_FILENAME = 'dsh-getnote/auth.json'
const CLOUD_FILENAME = 'dsh-getnote/cloud.json'
const SYNC_FILENAME = 'dsh-getnote/state.json'

/** DSH 主目录：$DSH_HOME（缺省 ~/.dsh）。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env : join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(dshHome(), SETTINGS_FILENAME)
}

export function authPath() {
  return join(dshHome(), AUTH_FILENAME)
}

/** 默认本地库根：$DSH_HOME/dsh-getnote/vault。空库也成立，面板会引导建第一篇。 */
export function defaultVaultRoot() {
  return join(dshHome(), 'dsh-getnote', 'vault')
}

/**
 * 已知的「得到大脑归档」候选目录。
 *
 * 插件第一次跑起来时如果自己库里没有笔记，就在这些位置找现成的归档目录，
 * 找到就当作**建议**交给前端显示（不静默切换——用户可能有多套库，替他决定
 * 一个错的根目录比什么都不做更糟）。
 */
export function knownVaultCandidates() {
  const home = homedir()
  // 常见位置找现成的「得到大脑归档」目录。刻意不写死任何绝对路径：
  // 开源之后别人机器上没有那个目录，写死只会变成一条永远失败的候选，
  // 同时把开发者的目录结构泄露在源码里。
  const list = [
    join(home, "Documents", "得到大脑归档"),
    join(home, "得到大脑归档"),
    join(home, "Documents", "Get笔记"),
  ]
  // 环境变量兜底：想指向一个特别的位置时用 DSH_GETNOTE_VAULT，不用改代码。
  const fromEnv = process.env.DSH_GETNOTE_VAULT
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") list.unshift(fromEnv.trim())
  return list
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写：临时文件 + rename（断电不会留半截 JSON）。 */
async function writeJsonAtomic(path, value, mode) {
  await mkdir(dirname(path), { recursive: true })
  // 带随机后缀：设置与凭证可能被并发保存（面板保存 + 自动同步落 lastRunAt），
  // 共用同一个 `.pid.tmp` 时后写的会截断先写的，rename 上去就是半截 JSON。
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  if (mode) {
    try {
      await chmod(tmp, mode)
    } catch {
      // Windows 上 chmod 只影响只读位，失败不影响功能
    }
  }
  await rename(tmp, path)
}

/**
 * 规范化用户选的主题色。
 *
 * 只接受 `#rgb` / `#rrggbb`，一律回小写 `#rrggbb`；不合法回 null 表示「用默认配色」。
 *
 * 刻意**只存一个颜色**，三层深浅（左深 / 中浅 / 右近白）由前端按色相推导——
 * 理由记在 client.js 的 themeFromColor 里：如果把三层颜色都存下来，用户下次
 * 把主题色改成很浅的颜色时，「左栏最暗」这条视觉规则就靠用户的自觉维持了，
 * 一定会出现左栏比右栏还淡的情况。存色相、推导明度，规则才守得住。
 */
export function normalizeThemeColor(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim().toLowerCase()
  if (raw === '') return null
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(raw)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null
}

/**
 * 关系图配色的默认值：很浅的蓝。
 *
 * 跟 themeColor 分开存，是两件不同的事——面板背景要克制，关系图是「看结构」，
 * 线太淡就什么都看不出来，所以它需要比主题色更亮一档的独立选择。
 */
export const DEFAULT_GRAPH_COLOR = '#9dc6ef'

/** 规范化关系图颜色。跟主题色同一套校验，但空值回落默认色而不是 null。 */
export function normalizeGraphColor(input) {
  const hex = normalizeThemeColor(input)
  return hex === null ? DEFAULT_GRAPH_COLOR : hex
}

/** 面板界面语言：只认这三本字典，其他一律当「自动」。 */
export const SUPPORTED_LOCALES = ['zh', 'en', 'nl']

/**
 * 规范化界面语言。
 *
 * 返回 null 表示「自动」——跟随宿主 locale 猜一个，认不出再用中文。
 * 之所以允许 null 而不是强制选一个：新装用户不该被要求先去设置里挑语言。
 */
export function normalizeLocale(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim().toLowerCase()
  if (raw === '') return null
  if (raw === 'zh' || raw.startsWith('zh-')) return 'zh'
  if (raw === 'en' || raw.startsWith('en-')) return 'en'
  if (raw === 'nl' || raw.startsWith('nl-')) return 'nl'
  return null
}

/**
 * 读设置。
 *
 * `vaultRoot` 为 null 表示「用默认库」——刻意和「空字符串」区分开：
 * 空字符串是用户手动清空的中间态，交给 resolveVaultRoot 回落默认。
 */
export async function readSettings() {
  const data = await readJson(settingsPath())
  const vaultRoot = typeof data.vaultRoot === 'string' && data.vaultRoot.trim() !== '' ? data.vaultRoot : null
  const auto = normalizeAutoSync({
    autoSync: data.autoSync,
    autoSyncMinutes: data.autoSyncMinutes,
    autoSyncIncremental: data.autoSyncIncremental,
    autoSyncForegroundOnly: data.autoSyncForegroundOnly,
  })
  return {
    vaultRoot,
    // 上次同步完成时间（本地文件，离线也能给用户看）
    lastSyncAt: typeof data.lastSyncAt === 'string' ? data.lastSyncAt : null,
    // 同步时是否把笔记正文里的图片也抓下来（默认关：图片要额外上传配额）
    syncImages: data.syncImages === true,
    // 自动同步：默认关（要用户显式打开，否则一装插件就偷偷联网）
    autoSync: auto.enabled,
    autoSyncMinutes: auto.intervalMinutes,
    autoSyncIncremental: auto.incremental,
    // 仅前台运行：开了之后背后没人在看就不自动同步
    autoSyncForegroundOnly: auto.foregroundOnly,
    // 面板主题色：null = 用内置的蓝。只存一个色相，三层深浅由前端推导。
    themeColor: normalizeThemeColor(data.themeColor),
    // 深色模式。默认 false：浅色是这套配色的主场，不能让老用户升级后突然变黑。
    darkMode: data.darkMode === true,
    // 关系图配色。空/非法都回落默认浅蓝，别让关系图因为一个坏值变成全黑。
    graphColor: normalizeGraphColor(data.graphColor),
    // 界面语言：null = 自动（跟随宿主 locale，认不出用中文）
    uiLocale: normalizeLocale(data.uiLocale),
    // 自定义笔记模板。空数组是正常状态（用户还没加过），不是错误。
    templates: normalizeTemplates(data.templates),
  }
}

/** 合并式写入：只覆盖 patch 里出现的字段。 */
export async function updateSettings(patch = {}) {
  const cur = await readSettings()
  const next = {
    ...(patch.vaultRoot !== undefined ? { vaultRoot: patch.vaultRoot } : cur.vaultRoot ? { vaultRoot: cur.vaultRoot } : {}),
    lastSyncAt: patch.lastSyncAt !== undefined ? patch.lastSyncAt : cur.lastSyncAt,
    syncImages: patch.syncImages !== undefined ? patch.syncImages : cur.syncImages,
    autoSync: patch.autoSync !== undefined ? patch.autoSync === true : cur.autoSync,
    autoSyncMinutes: patch.autoSyncMinutes !== undefined ? normalizeAutoSync({ autoSyncMinutes: patch.autoSyncMinutes }).intervalMinutes : cur.autoSyncMinutes,
    autoSyncIncremental: patch.autoSyncIncremental !== undefined ? patch.autoSyncIncremental !== false : cur.autoSyncIncremental,
    autoSyncForegroundOnly: patch.autoSyncForegroundOnly !== undefined ? patch.autoSyncForegroundOnly === true : cur.autoSyncForegroundOnly,
    // themeColor 用 'in' 判断：null 是「恢复默认配色」这个动作本身，不能被当成「没传」跳过
    themeColor: 'themeColor' in patch ? normalizeThemeColor(patch.themeColor) : cur.themeColor,
    // 同理：uiLocale 的 null 是「自动」这个真实选项，不能当没传
    uiLocale: 'uiLocale' in patch ? normalizeLocale(patch.uiLocale) : cur.uiLocale,
    // 深色模式：只认严格 true。写 false 是「关掉」，没传是「不动」——
    // 这两件事必须分开，否则关掉一次之后再也没法通过别的请求保持关闭。
    darkMode: patch.darkMode !== undefined ? patch.darkMode === true : cur.darkMode,
    // 关系图配色：传空字符串/null 视为「恢复默认」，不是「没传」
    graphColor: 'graphColor' in patch ? normalizeGraphColor(patch.graphColor) : cur.graphColor,
    // 模板列表：整个数组替换，不做逐项合并——用户删掉一个模板就该真的消失，
    // 逐项合并会让删掉的那个又冒回来。空数组是合法值（清空所有自定义模板）。
    templates: 'templates' in patch ? normalizeTemplates(patch.templates) : cur.templates,
  }
  await writeJsonAtomic(settingsPath(), next)
  return readSettings()
}

/** 展开 `~` 前缀（Windows 上只有 ~ 也认）。 */
export function expandHome(input) {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/** 校验并保存本地库根目录，返回 realpath。目录不存在则报 400（不替用户创建）。 */
export async function setVaultRoot(input) {
  const expanded = expandHome(input)
  if (typeof expanded !== 'string' || expanded.trim() === '' || !isAbsolute(expanded)) {
    throw Object.assign(new Error('vault root must be an absolute path'), { status: 400 })
  }
  let real
  try {
    real = await realpath(expanded)
  } catch {
    throw Object.assign(new Error(`目录不存在：${expanded}`), { status: 400 })
  }
  const st = await stat(real)
  if (!st.isDirectory()) throw Object.assign(new Error(`不是目录：${expanded}`), { status: 400 })
  await updateSettings({ vaultRoot: real })
  return real
}

/**
 * 解析当前生效的本地库根。
 *
 * 用户配置的目录存在就用它；不存在（被删/被移动）时**不静默换库**，而是把
 * 问题带回去，让面板显式提示「库目录不见了」——悄悄落到空目录会让用户以为
 * 笔记全丢了。
 */
export async function resolveVaultRoot(configured) {
  const candidates = configured && configured.trim() !== '' ? [expandHome(configured)] : []
  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate)
      const st = await stat(real)
      if (st.isDirectory()) return { root: real, missing: null }
    } catch {
      return { root: resolve(candidate), missing: candidate }
    }
  }
  const fallback = defaultVaultRoot()
  await mkdir(fallback, { recursive: true })
  return { root: await realpath(fallback), missing: null }
}

// ── OAuth 凭证 ───────────────────────────────────────────────────────────────

/**
 * 读凭证。返回 null 表示没登录过——这是**正常状态**，不是错误：
 * 面板在没有凭证时依然完整可用（读本地库）。
 */
export async function readAuth() {
  const data = await readJson(authPath())
  if (!data || typeof data !== 'object') return null
  if (typeof data.accessToken !== 'string' || data.accessToken === '') return null
  return {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : null,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : 0,
    clientId: typeof data.clientId === 'string' ? data.clientId : null,
    redirectUri: typeof data.redirectUri === 'string' ? data.redirectUri : null,
    obtainedAt: typeof data.obtainedAt === 'string' ? data.obtainedAt : null,
  }
}

export async function writeAuth(auth) {
  await writeJsonAtomic(authPath(), auth, 0o600)
}

export async function clearAuth() {
  await writeJsonAtomic(authPath(), {}, 0o600)
}

/** 客户端注册信息（client_id / redirect_uri）单独存：掉 token 也不必重新注册。 */
export async function readClient() {
  const data = await readJson(authPath())
  if (typeof data.clientId !== 'string' || data.clientId === '') return null
  return { clientId: data.clientId, redirectUri: typeof data.redirectUri === 'string' ? data.redirectUri : null }
}

// ── Open API 凭证（API Key + Client ID [+ 企业 Grant ID]）────────────────────
//
// 和 OAuth 凭证分开存：OAuth 那套会过期、需要刷新；API Key 是长期凭证，不会
// 自己失效。分开存也意味着「退出云端」可以只清一套而不影响另一套。

export function cloudPath() {
  return join(dshHome(), CLOUD_FILENAME)
}

/**
 * 读云端接入凭证。
 *
 * 返回 `{apiKey, clientId, grantId, savedAt}`；没配过返回 null。
 * **这是机密**：只回给 host 侧调用方，路由层必须只用 `hasApiKey` 之类的布尔值
 * 对外暴露，绝不把 apiKey 原样发给浏览器。
 */
export async function readCloud() {
  const data = await readJson(cloudPath())
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : ''
  const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : ''
  if (apiKey === '' && clientId === '') return null
  return {
    apiKey,
    clientId,
    grantId: typeof data.grantId === 'string' ? data.grantId.trim() : '',
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : null,
  }
}

/** 写云端凭证（0600）。传空字符串即清除对应字段。 */
export async function writeCloud({ apiKey, clientId, grantId }) {
  const next = {
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
    clientId: typeof clientId === 'string' ? clientId.trim() : '',
    grantId: typeof grantId === 'string' ? grantId.trim() : '',
    savedAt: new Date().toISOString(),
  }
  if (next.apiKey === '' && next.clientId === '') {
    await writeJsonAtomic(cloudPath(), {}, 0o600)
    return null
  }
  await writeJsonAtomic(cloudPath(), next, 0o600)
  return next
}

export async function clearCloud() {
  await writeJsonAtomic(cloudPath(), {}, 0o600)
}

/**
 * 凭证的展示形态：**只给能确认身份的部分**。
 *
 * 前端需要知道「配没配」「配的是哪个 Key」才能给出有意义的反馈，但完整 Key 泄漏
 * 到渲染进程就等于泄漏账号。折中：保留前 12 位与后 4 位（gk_live_ + 尾部），
 * 中间打码。Client ID 同理。
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 16) return value.slice(0, 4) + '…'
  return `${value.slice(0, 12)}…${value.slice(-4)}`
}

// ── 同步状态 ─────────────────────────────────────────────────────────────────
//
// 增量同步靠这个文件：记住每篇笔记上次同步时的内容指纹，下次只需比较指纹，
// 不用重新读全量。也是「云端删除 vs 本地编辑」冲突判定的依据。

export function syncStatePath() {
  return join(dshHome(), SYNC_FILENAME)
}

export async function readSyncState() {
  const data = await readJson(syncStatePath())
  const notes = data && typeof data.notes === 'object' && data.notes !== null ? data.notes : {}
  return {
    // note_id → { fingerprint, path, updatedAt, syncedAt, cloudDeleted }
    notes,
    lastRunAt: typeof data.lastRunAt === 'string' ? data.lastRunAt : null,
    lastCursor: typeof data.lastCursor === 'string' ? data.lastCursor : null,
  }
}

export async function writeSyncState(state) {
  await writeJsonAtomic(syncStatePath(), {
    notes: state && typeof state.notes === 'object' ? state.notes : {},
    lastRunAt: state?.lastRunAt ?? null,
    lastCursor: state?.lastCursor ?? null,
  })
}

/** 自动同步的偏好（存在主设置文件里，跟着用户走）。 */
/**
 * 自定义笔记模板：用户在设置里自己攒的骨架。
 *
 * 为什么要允许自定义：内置的日记/读书/会议/随手记只覆盖最常见的四类，但每个人
 * 的「周报」「复盘」「课程笔记」结构都不一样，硬编码进代码只会越堆越乱。存在
 * 设置文件里，跟着用户走，换机器也跟着。
 *
 * 约束（都是为了让它在界面上还能看）：
 *   · 最多 MAX_TEMPLATES 个，超出直接截断——菜单里放二十个模板，用户找自己要的
 *     那个比手打还慢；
 *   · 名字去空白、限长，重复名字后面那个被丢掉（同名两项在菜单里分不出来）；
 *   · 正文限长，避免有人把整篇文章粘进去当成模板。
 */
export const MAX_TEMPLATES = 12
const TEMPLATE_NAME_MAX = 24
const TEMPLATE_BODY_MAX = 4000

/** 把任意输入整理成可用的模板列表。坏数据一律丢掉，不抛错。 */
export function normalizeTemplates(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input) {
    if (out.length >= MAX_TEMPLATES) break
    if (item === null || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, TEMPLATE_NAME_MAX) : ''
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const body = typeof item.body === 'string' ? item.body.slice(0, TEMPLATE_BODY_MAX) : ''
    out.push({ name, body })
  }
  return out
}

export function normalizeAutoSync(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const minutes = Number(cfg.autoSyncMinutes)
  return {
    enabled: cfg.autoSync === true,
    // 出了范围就夹到边界，而不是退回默认值：用户填 1 分钟的意思明显是「尽快」，
    // 悄悄改成 15 会让他以为设置没生效。5 分钟是下限（官方读配额 1000/天，
    // 5 分钟一轮全天也就 288 次；15 分钟更省，所以默认 15）。
    intervalMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.max(Math.round(minutes), 5), 720) : 15,
    // 默认只拉「有变化的」，不做全量重扫
    incremental: cfg.autoSyncIncremental !== false,
    // 仅前台运行：默认关。开了之后只有面板处于可见状态时才自动同步，
    // 背后没人在看的时候不去花配额、不去动磁盘上的文件。
    foregroundOnly: cfg.autoSyncForegroundOnly === true,
  }
}
