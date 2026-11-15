/**
 * dsh-getnote — 浏览器半边：左侧栏入口 + 中央笔记面板。
 *
 * 这是 `__ModuleLoader__.load` 工厂，而不是普通 ES 模块 —— 与 DSH 自带的
 * 所有 client bundle 同一种形状，由宿主的模块表加载，React 从模块表取。
 *
 * 数据全部来自 host 的 `/getnote/*` 路由（本地文件系统）；面板本身不碰网络、
 * 不认云端 —— 断网、会员过期，这个面板都照常能读能写。唯一的联网动作是用户
 * 主动点的「登录并导入」，它也只是让 host 去抓一次数据落成文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-getnote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-getnote'
    const PANEL_ID = 'dsh-getnote'
    const PANEL_ORDER = 7
    const STYLE_ID = 'dshgn-style'

    // ── 文案 ──────────────────────────────────────────────────────────────────

    const LEX = {
      zh: {
        'panel.title': '得到大脑',
        'panel.hint': '本地笔记库',
        'tab.notes': '笔记',
        'tab.import': '导入',
        'tab.settings': '设置',
        'action.refresh': '刷新',
        'action.new': '新建',
        'action.save': '保存',
        'action.cancel': '取消',
        'action.edit': '编辑',
        'action.delete': '删除',
        'action.copyRef': '复制引用',
        'action.copied': '已复制',
        'action.retry': '重试',
        'search.placeholder': '搜索标题、正文、标签…',
        'search.clear': '清空',
        'tree.all': '全部笔记',
        'tree.dirs': '目录',
        'tree.tags': '标签',
        'empty.noVault': '还没有本地笔记库',
        'empty.noVaultDesc': '先在「设置」里指定一个目录，或者点「导入」把得到大脑的笔记抓下来。',
        'empty.noNotes': '这个目录还没有笔记',
        'empty.select': '选一篇笔记开始阅读',
        'empty.selectDesc': '左栏是目录，中间是笔记列表。也可以点「新建」写一篇。',
        'empty.search': '没有匹配的笔记',
        'meta.notes': '篇',
        'meta.dirs': '个目录',
        'reader.missing': '文件不存在或已被移动',
        'reader.frontmatter': '属性',
        'import.title': '一次性导入',
        'import.desc':
          '趁得到大脑会员还有效，把云端笔记全量抓成本地 Markdown。之后会员到期、断网、甚至服务下线，这里的笔记都照常能读能改 —— 导入是本插件唯一会联网的动作。',
        'import.loggedIn': '已连接得到大脑',
        'import.notLoggedIn': '未连接',
        'import.login': '登录得到大脑',
        'import.loginHint': '会打开浏览器完成授权，完成后回到这个面板即可。',
        'import.start': '开始导入',
        'import.running': '正在导入…',
        'import.logout': '退出登录',
        'import.result': '导入结果',
        'import.lastSync': '上次导入',
        'import.never': '从未导入',
        'import.done': '完成',
        'import.newNotes': '新增',
        'import.skipped': '已存在跳过',
        'import.failed': '失败',
        'import.authorizeWait': '等待浏览器授权…',
        'import.openLink': '如果没有自动打开，点这里手动授权',
        'import.needLogin': '先登录得到大脑，才能读取云端笔记。',
        'import.cloudHint': '这一步之后就不再需要会员了。',
        'settings.vault': '笔记库目录',
        'settings.vaultHint': '留空则使用默认位置（DSH 配置目录下的 dsh-getnote/vault）。',
        'settings.save': '保存目录',
        'settings.saved': '已保存',
        'settings.suggest': '在这个位置发现了已有笔记',
        'settings.use': '用这个',
        'settings.authFile': '凭证文件',
        'settings.loggedIn': '已登录',
        'settings.loggedOut': '未登录',
        'settings.loginExpired': '登录已过期',
        'settings.storeHint': '登录凭证只保存在本机 DSH 配置目录，不出现在浏览器里。',
        'error.prefix': '出错了',
        'note.created': '已新建',
        'note.saved': '已保存',
        'note.deleted': '已移入回收站',
        'note.unsaved': '有未保存的修改',
  'note.localAudio': '本地录音',
        'note.wikilinkMissing': '库里找不到「{name}」这篇笔记',
        'note.image': '图片',
        'tab.trash': '回收站',
        'trash.desc': '删掉的笔记先放这里，随时可以恢复。恢复只是把文件搬回库里，不碰内容。',
        'trash.empty': '回收站是空的',
        'trash.emptyHint': '在笔记列表里点删除，文件会先到这里。清空才会真的删。',
        'trash.deletedAt': '删除于',
        'trash.restore': '恢复',
        'trash.restored': '已恢复到库里',
        'trash.purgeOne': '永久删除',
        'trash.purgeAll': '清空回收站',
        'trash.purgeConfirm': '清空回收站会真的删掉这些文件，无法撤销。继续？',
        'trash.purgeOneConfirm': '永久删除这个文件，无法撤销。继续？',
        'trash.purged': '已清理',
        'trash.originalName': '原文件',
        'cloud.newNote': '新建云端笔记',
        'cloud.newNoteTitle': '标题',
        'cloud.newNoteBody': '正文',
        'cloud.create': '创建',
        'cloud.created': '已创建',
        'cloud.tags': '标签',
        'cloud.addTagHint': '输入标签，回车或点加号',
        'cloud.tagAdded': '已加标签',
        'cloud.tagRemoved': '已删标签',
        'cloud.removeTag': '删掉这个标签',
        'cloud.shareLink': '分享链接',
        'cloud.shareCreated': '分享链接已生成',
        'cloud.shareExcludeAudio': '不含录音',
        'cloud.copyLink': '复制链接',
        'cloud.copied': '已复制',
        'cloud.topics': '知识库',
        'cloud.allTopics': '全部云端笔记',
        'cloud.topicNotes': '知识库内的笔记',
        'cloud.pushLocal': '推送本地改动到云端',
        'cloud.pushHint': '把这篇本地笔记的标题和正文覆盖到云端。会改动云端内容，请确认。',
        'cloud.pushed': '已推送到云端',
        // ── 云端（Open API）──
        'tab.cloud': '云端',
        'tab.sync': '同步',
        'cloud.title': '云端笔记',
        'cloud.desc': '直接读得到大脑里的内容，可以播放录音、改标题正文、加标签、删到回收站。',
        'cloud.notConfigured': '还没接入得到大脑',
        'cloud.notConfiguredDesc':
          '去「设置 → 云端接入」填 API Key 与 Client ID。在 openapi.biji.com 控制台创建个人开发应用就能拿到这两个值。',
        'cloud.loading': '正在读取云端…',
        'cloud.empty': '云端还没有笔记',
        'cloud.loadMore': '加载更多',
        'cloud.audio': '录音',
        'cloud.play': '播放',
        'cloud.pause': '暂停',
        'cloud.transcript': '逐字稿',
        'cloud.moments': '时间轴',
        'cloud.todos': '待办',
        'cloud.tags': '标签',
        'cloud.editTitle': '标题',
        'cloud.editBody': '正文',
        'cloud.saveCloud': '保存到云端',
        'cloud.savedCloud': '已保存到云端，本地镜像也刷新了',
        'cloud.deleteCloud': '删除（进回收站）',
        'cloud.deletedCloud': '已从云端删除',
        'cloud.addTag': '加标签',
        'cloud.share': '生成分享链接',
        'cloud.polling': '云端详情加载中…',
        'cloud.localCopy': '本地副本',
        'cloud.noLocalCopy': '本地还没有这一篇',
        'cloud.pullOne': '拉到本地',
        // ── 同步 ──
        'sync.title': '自动同步',
        'sync.desc':
          '打开后每隔一段时间自动把云端新增和修改的笔记拉到本地，不需要手动点。本地改过的笔记不会被覆盖；两边都改过会另存一份到 .conflicts 目录。',
        'sync.enabled': '开启自动同步',
        'sync.interval': '同步间隔',
        'sync.minutes': '分钟',
        'sync.incremental': '只同步有变化的（省配额）',
        'sync.now': '立即同步',
        'sync.running': '正在同步…',
        'sync.lastRun': '上次同步',
        'sync.never': '从未同步',
        'sync.result': '同步结果',
        'sync.pulled': '拉取',
        'sync.skipped': '未变化',
        'sync.adopted': '保留本地',
        'sync.conflicts': '冲突',
        'sync.deleted': '已删除',
        'sync.errors': '失败',
        'sync.fullScan': '全量扫描（能发现云端删除，慢且费配额）',
        'sync.quotaHint': '官方配额：读 1000 次/天、写 200 次/天。默认 15 分钟一轮、只拉有变化的，全天也就用掉几十次。',
        'sync.legacy': '旧的一次性导入',
        'sync.legacyHint': 'OAuth 通道，只在没配 API Key 时兜底用。',
        // ── 云端凭证 ──
        'api.title': '云端接入',
        'api.desc': '填自己的 API Key 与 Client ID，插件就能直接操作得到大脑（读笔记、播录音、改内容、自动同步）。',
        'api.apiKey': 'API Key',
        'api.clientId': 'Client ID',
        'api.grantId': '授权 ID（可选，企业代授权才需要）',
        'api.keyPlaceholder': 'gk_live_...',
        'api.idPlaceholder': 'cli_...',
        'api.grantPlaceholder': 'grt_...（留空即可）',
        'api.save': '保存凭证',
        'api.saved': '凭证已保存',
        'api.test': '测试连接',
        'api.testing': '测试中…',
        'api.ok': '连接正常',
        'api.clear': '清除凭证',
        'api.cleared': '凭证已清除',
        'api.ready': '已接入',
        'api.notReady': '未接入',
        'api.missing': '还缺',
        'api.file': '凭证文件',
        'api.consoleHint': '去 openapi.biji.com → 控制台 → 创建个人开发应用，拿到 Client ID；再在 API Key 页生成一个 Key。',
        'api.neverEcho': 'Key 只保存在本机，保存后不会再显示完整内容。',
        'api.needKey': 'API Key 与 Client ID 都要填才能用。',
        'api.keyRejected': '这个 API Key 被服务端拒绝了',
        'api.usingFallback': '还好你登录过得到大脑，现在自动改用登录通道，功能都正常。要修好 Key，去控制台确认它已激活、且应用有对应权限。',
        'api.viaLogin': '当前用的是「登录得到大脑」这条通道，不需要 API Key。',
      },
      en: {
        'panel.title': 'Get笔记',
        'panel.hint': 'Local note vault',
        'tab.notes': 'Notes',
        'tab.import': 'Import',
        'tab.settings': 'Settings',
        'action.refresh': 'Refresh',
        'action.new': 'New',
        'action.save': 'Save',
        'action.cancel': 'Cancel',
        'action.edit': 'Edit',
        'action.delete': 'Delete',
        'action.copyRef': 'Copy reference',
        'action.copied': 'Copied',
        'action.retry': 'Retry',
        'search.placeholder': 'Search title, body, tags…',
        'search.clear': 'Clear',
        'tree.all': 'All notes',
        'tree.dirs': 'Folders',
        'tree.tags': 'Tags',
        'empty.noVault': 'No local vault yet',
        'empty.noVaultDesc': 'Pick a folder in Settings, or press Import to pull your notes down.',
        'empty.noNotes': 'No notes in this folder',
        'empty.select': 'Pick a note to read',
        'empty.selectDesc': 'Folders on the left, notes in the middle. Or press New.',
        'empty.search': 'No matching notes',
        'meta.notes': 'notes',
        'meta.dirs': 'folders',
        'reader.missing': 'File is missing or was moved',
        'reader.frontmatter': 'Properties',
        'import.title': 'One-time import',
        'import.desc':
          'While your subscription still works, pull every cloud note down as local Markdown. Afterwards the notes stay readable and editable — this is the only action in the plugin that touches the network.',
        'import.loggedIn': 'Connected',
        'import.notLoggedIn': 'Not connected',
        'import.login': 'Sign in',
        'import.loginHint': 'A browser window opens for authorization; come back here when done.',
        'import.start': 'Start import',
        'import.running': 'Importing…',
        'import.logout': 'Sign out',
        'import.result': 'Result',
        'import.lastSync': 'Last import',
        'import.never': 'never',
        'import.done': 'Done',
        'import.newNotes': 'new',
        'import.skipped': 'skipped',
        'import.failed': 'failed',
        'import.authorizeWait': 'Waiting for authorization…',
        'import.openLink': 'If no window opened, authorize manually here',
        'import.needLogin': 'Sign in first to read cloud notes.',
        'import.cloudHint': 'After this you no longer need the subscription.',
        'settings.vault': 'Vault folder',
        'settings.vaultHint': 'Leave empty for the default location (dsh-getnote/vault under the DSH config dir).',
        'settings.save': 'Save folder',
        'settings.saved': 'Saved',
        'settings.suggest': 'Found existing notes here',
        'settings.use': 'Use it',
        'settings.authFile': 'Credential file',
        'settings.loggedIn': 'Signed in',
        'settings.loggedOut': 'Not signed in',
        'settings.loginExpired': 'Sign-in expired',
        'settings.storeHint': 'Credentials stay in the local DSH config dir, never in the browser.',
        'error.prefix': 'Error',
        'note.created': 'Created',
        'note.saved': 'Saved',
        'note.deleted': 'Moved to trash',
        'note.unsaved': 'Unsaved changes',
  'note.localAudio': 'Local recording',
        'note.wikilinkMissing': 'No note named "{name}" in this vault',
        'note.image': 'Image',
        'tab.trash': 'Trash',
        'trash.desc': 'Deleted notes wait here and can be restored. Restoring just moves the file back.',
        'trash.empty': 'Trash is empty',
        'trash.emptyHint': 'Deleting a note moves it here first. Only purging really deletes it.',
        'trash.deletedAt': 'Deleted',
        'trash.restore': 'Restore',
        'trash.restored': 'Restored into the vault',
        'trash.purgeOne': 'Delete forever',
        'trash.purgeAll': 'Empty trash',
        'trash.purgeConfirm': 'Emptying the trash really deletes these files. Continue?',
        'trash.purgeOneConfirm': 'Delete this file forever. Continue?',
        'trash.purged': 'Purged',
        'trash.originalName': 'Original file',
        'cloud.newNote': 'New cloud note',
        'cloud.newNoteTitle': 'Title',
        'cloud.newNoteBody': 'Body',
        'cloud.create': 'Create',
        'cloud.created': 'Created',
        'cloud.tags': 'Tags',
        'cloud.addTagHint': 'Type a tag, press Enter or plus',
        'cloud.tagAdded': 'Tag added',
        'cloud.tagRemoved': 'Tag removed',
        'cloud.removeTag': 'Remove this tag',
        'cloud.shareLink': 'Share link',
        'cloud.shareCreated': 'Share link created',
        'cloud.shareExcludeAudio': 'Exclude audio',
        'cloud.copyLink': 'Copy link',
        'cloud.copied': 'Copied',
        'cloud.topics': 'Knowledge bases',
        'cloud.allTopics': 'All cloud notes',
        'cloud.topicNotes': 'Notes in this knowledge base',
        'cloud.pushLocal': 'Push local changes to cloud',
        'cloud.pushHint': 'Overwrite the cloud title and body with this local note. This changes cloud content.',
        'cloud.pushed': 'Pushed to cloud',
        // ── Cloud (Open API) ──
        'tab.cloud': 'Cloud',
        'tab.sync': 'Sync',
        'cloud.title': 'Cloud notes',
        'cloud.desc': 'Read Get笔记 directly, play recordings, edit text, add tags, delete to trash.',
        'cloud.notConfigured': 'Not connected to Get笔记',
        'cloud.notConfiguredDesc':
          'Add your API Key and Client ID under Settings → Cloud access. Create a personal app at openapi.biji.com to get both.',
        'cloud.loading': 'Loading cloud notes…',
        'cloud.empty': 'No cloud notes yet',
        'cloud.loadMore': 'Load more',
        'cloud.audio': 'Recording',
        'cloud.play': 'Play',
        'cloud.pause': 'Pause',
        'cloud.transcript': 'Transcript',
        'cloud.moments': 'Timeline',
        'cloud.todos': 'To-dos',
        'cloud.tags': 'Tags',
        'cloud.editTitle': 'Title',
        'cloud.editBody': 'Body',
        'cloud.saveCloud': 'Save to cloud',
        'cloud.savedCloud': 'Saved to cloud; local copy refreshed too',
        'cloud.deleteCloud': 'Delete (to trash)',
        'cloud.deletedCloud': 'Deleted from cloud',
        'cloud.addTag': 'Add tag',
        'cloud.share': 'Create share link',
        'cloud.polling': 'Loading cloud note…',
        'cloud.localCopy': 'Local copy',
        'cloud.noLocalCopy': 'No local copy yet',
        'cloud.pullOne': 'Pull to local',
        // ── Sync ──
        'sync.title': 'Auto sync',
        'sync.desc':
          'When on, new and changed cloud notes are pulled to the local vault on a timer, with no clicking. Locally edited notes are never overwritten; when both sides changed, a copy goes to .conflicts.',
        'sync.enabled': 'Enable auto sync',
        'sync.interval': 'Interval',
        'sync.minutes': 'min',
        'sync.incremental': 'Only sync changes (saves quota)',
        'sync.now': 'Sync now',
        'sync.running': 'Syncing…',
        'sync.lastRun': 'Last sync',
        'sync.never': 'never',
        'sync.result': 'Result',
        'sync.pulled': 'pulled',
        'sync.skipped': 'unchanged',
        'sync.adopted': 'kept local',
        'sync.conflicts': 'conflicts',
        'sync.deleted': 'deleted',
        'sync.errors': 'failed',
        'sync.fullScan': 'Full scan (detects cloud deletions; slower, uses more quota)',
        'sync.quotaHint': 'Official quota: 1000 reads/day, 200 writes/day. The default 15-minute incremental run uses only dozens.',
        'sync.legacy': 'Legacy one-time import',
        'sync.legacyHint': 'OAuth channel, kept only as a fallback when no API key is set.',
        // ── Cloud credentials ──
        'api.title': 'Cloud access',
        'api.desc': 'Add your own API Key and Client ID so the plugin can drive Get笔记: read notes, play audio, edit, auto-sync.',
        'api.apiKey': 'API Key',
        'api.clientId': 'Client ID',
        'api.grantId': 'Grant ID (optional, enterprise only)',
        'api.keyPlaceholder': 'gk_live_...',
        'api.idPlaceholder': 'cli_...',
        'api.grantPlaceholder': 'grt_... (leave empty)',
        'api.save': 'Save credentials',
        'api.saved': 'Credentials saved',
        'api.test': 'Test connection',
        'api.testing': 'Testing…',
        'api.ok': 'Connection OK',
        'api.clear': 'Clear credentials',
        'api.cleared': 'Credentials cleared',
        'api.ready': 'Connected',
        'api.notReady': 'Not connected',
        'api.missing': 'missing',
        'api.file': 'Credential file',
        'api.consoleHint': 'Create a personal app at openapi.biji.com → console → get the Client ID, then generate a key on the API Key page.',
        'api.neverEcho': 'The key stays on this machine and is never echoed back in full.',
        'api.needKey': 'Both API Key and Client ID are required.',
        'api.keyRejected': 'This API key was rejected by the server',
        'api.usingFallback': 'Your Get笔记 login still works, so the plugin switched to that channel automatically. To fix the key, check in the console that it is active and the app has the right scopes.',
        'api.viaLogin': 'Currently using the "sign in to Get笔记" channel — no API key needed.',
      },
    }

    /**
     * 取文案：优先宿主 locale（用户切语言时跟着变），否则用内置中文。
     *
     * bind 在每次调用时才解析，不在 apply 时缓存：apply 早于 locale 就绪是常态，
     * 缓存下来的 bound 会永远返回 key，界面就整片英文键名了。
     */
    let boundCtx = null
    function setLocaleCtx(ctx) {
      boundCtx = ctx
    }
    function makeT(ctx) {
      const bound = () => {
        // ctx 优先，其次用 apply 时记下的那个；都在调用时才解析，
        // 这样 locale 服务晚于 apply 就绪也照样能取到文案
        const host = ctx || boundCtx
        if (!host || !host.locale || typeof host.locale.bind !== 'function') return null
        try {
          return host.locale.bind(NS)
        } catch {
          return null
        }
      }
      return (key) => {
        const translate = bound()
        if (translate) {
          try {
            const text = translate(key)
            if (typeof text === 'string' && text !== key && text !== '') return text
          } catch {
            // 宿主 locale 未就绪：落到内置字典
          }
        }
        return LEX.zh[key] || key
      }
    }

    // 组件里拿文案的入口：apply 时记下真实 ctx，取不到时用内置中文兜底
    let panelT = null
    function getT() {
      if (panelT === null) panelT = makeT(undefined)
      return panelT
    }

    // ── HTTP ──────────────────────────────────────────────────────────────────

    /**
     * 调 host 的本地库 API。
     *
     * 保留 `status`：调用方要能区分「路由不存在」（宿主还没重启 / 插件没装好）
     * 和业务失败，否则两者都会被显示成「空库」，用户会以为笔记丢了。
     */
    async function api(path, init) {
      const options = { ...(init || {}) }
      const res = await fetch(`/getnote${path}`, options)
      let json = {}
      try {
        json = await res.json()
      } catch {
        // 非 JSON 响应：保留状态码，让上层给出「宿主版本不匹配」这类可操作提示
      }
      if (!res.ok) {
        const err = new Error((json && json.error) || `HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      return json
    }

    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * 附件名的可读标签。
     *
     * 云端/旧体系生成的附件名长这样：
     * `示例录音笔记_1200000000000000001_audio.mp3`
     * 播放器卡片上直接显示这一长串，用户根本看不出这是什么。去掉 `_<note_id>`
     * 与 `_audio` / `_transcript` 后缀，只留下干净的名字 + 扩展名。
     */
    function assetLabel(name) {
      const raw = String(name || '')
      if (raw === '') return ''
      const ext = (/\.([a-z0-9]+)$/i.exec(raw) || [])[1] || ''
      let stem = ext === '' ? raw : raw.slice(0, -(ext.length + 1))
      // 真实文件名是 `<标题>_<note_id>_audio.mp3`，`_audio` 在 note_id **后面**，
      // 所以一遍替换只能剥掉一层。反复剥到不再变化为止，否则卡片上会留着
      // 「标题_1200000000000000001.mp3」这种半截名字。
      for (let i = 0; i < 4; i += 1) {
        const next = stem.replace(/_\d{10,}$/, '').replace(/_(audio|transcript|image|video)$/i, '')
        if (next === stem) break
        stem = next
      }
      return ext === '' ? stem : `${stem}.${ext}`
    }

    function formatTime(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // ── 图标 ──────────────────────────────────────────────────────────────────

    const ICONS = {
      brain:
        'M9.2 3.4A5.2 5.2 0 0 0 4 8.6c0 1 .3 1.9.8 2.7A3.9 3.9 0 0 0 3.6 14a4 4 0 0 0 2.3 3.6A4.3 4.3 0 0 0 9.6 21c.9 0 1.7-.3 2.4-.8.7.5 1.5.8 2.4.8a4.3 4.3 0 0 0 3.7-3.4A4 4 0 0 0 20.4 14a3.9 3.9 0 0 0-1.2-2.7c.5-.8.8-1.7.8-2.7a5.2 5.2 0 0 0-5.2-5.2c-.9 0-1.7.2-2.4.6a4.6 4.6 0 0 0-2.4-.6Z M12 6.4v13.2 M12 12.2 8.6 9.6 M12 15.4l3.4-2.6',
      folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3l2 2h8A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z',
      file: 'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Zm0 0v6h6',
      search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z M16.5 16.5 21 21',
      plus: 'M12 5v14 M5 12h14',
      refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
      trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
      edit: 'M4 20h4l10-10-4-4L4 16Z M14 6l4 4',
      cloud: 'M7 18a4 4 0 0 1 .6-7.96A5.5 5.5 0 0 1 18 10.5a3.5 3.5 0 0 1-.5 7.5Z',
      check: 'M4 12.5 9.5 18 20 6.5',
      gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
      up: 'M12 19V5 M5 12l7-7 7 7',
      close: 'M6 6l12 12 M18 6 6 18',
      link: 'M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1.2 1.2 M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1.2-1.2',
      play: 'M8 5.5v13l11-6.5Z',
      pause: 'M9 5v14 M15 5v14',
      audio: 'M4 13v-2a8 8 0 0 1 16 0v2 M4 13h2.5v5H5a1 1 0 0 1-1-1Z M20 13h-2.5v5H19a1 1 0 0 0 1-1Z',
      sync: 'M4 9a8 8 0 0 1 13.7-3.3L20 8 M20 4v4h-4 M20 15a8 8 0 0 1-13.7 3.3L4 16 M4 20v-4h4',
      clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 7v5l3.5 2',
    }

    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const name = props && props.name ? props.name : 'brain'
      const path = ICONS[name] || ICONS.brain
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className: props && props.className ? props.className : undefined,
        },
        path.split(' M').map((segment, index) =>
          h('path', { key: index, d: index === 0 ? segment : `M${segment}` }),
        ),
      )
    }

    // ── Markdown 渲染（无依赖）─────────────────────────────────────────────────

    /**
     * 行内：`code` / **粗** / *斜* / [文本](链接) / 裸链接。
     *
     * 刻意保持保守：认不出的语法原样显示，绝不吞字。笔记里的时间是 `[00:12:30]`
     * 这种方括号，误判成链接会让整篇时间轴坏掉，所以链接必须是 `[文本](url)` 全形。
     */
    function renderInline(text, keyPrefix, options) {
      const opts = options || {}
      const nodes = []
      const pattern =
        /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(!?\[\[[^\]\n]+\]\])|(\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g
      let last = 0
      let match
      let seq = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        const key = `${keyPrefix}-${seq++}`
        if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'dshgn_code' }, token.slice(1, -1)))
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('*')) {
          nodes.push(h('em', { key }, token.slice(1, -1)))
        } else if (token.startsWith('[[') || token.startsWith('![[')) {
          // Obsidian 双链：`[[目标]]` / `[[目标|显示文字]]` / `![[附件]]`
          const embed = token.startsWith('!')
          const inner = token.slice(embed ? 3 : 2, -2)
          const pipe = inner.indexOf('|')
          const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
          const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim()
          if (embed) {
            nodes.push(h('span', { key, className: 'dshgn_embed' }, renderEmbed(target, key, opts)))
          } else {
            nodes.push(
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'dshgn_wikilink',
                  // 双链在 Obsidian 里是跳转。这里没有 Obsidian 的解析器，尽力而为：
                  // 有完整路径就按路径打开，只写标题就在当前库里按标题/文件名找。
                  onClick: () => {
                    if (typeof opts.onOpenWikiLink === 'function') opts.onOpenWikiLink(target)
                  },
                },
                label || target,
              ),
            )
          }
        } else if (token.startsWith('[')) {
          const split = token.indexOf('](')
          const label = token.slice(1, split)
          const href = token.slice(split + 2, -1)
          nodes.push(
            h(
              'a',
              { key, href, target: '_blank', rel: 'noreferrer noopener', className: 'dshgn_link' },
              label,
            ),
          )
        } else {
          nodes.push(
            h('a', { key, href: token, target: '_blank', rel: 'noreferrer noopener', className: 'dshgn_link' }, token),
          )
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    /** 图像扩展名判定：只认浏览器能直接显示的格式。 */
    const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i

    /**
     * 渲染一个 `![[附件]]` 嵌入。
     *
     * 图片走 `/getnote/asset` 直接读用户库里的文件——同源、不受 CDN 签名过期影响，
     * 也不需要把附件内容塞进笔记正文（那样库会越滚越大）。
     * 音频交给 AudioPlayer；认不出来的（PDF、docx…）只给文件名，不假装能预览。
     */
    function renderEmbed(target, key, options) {
      const opts = options || {}
      const clean = String(target || '').trim()
      if (clean === '') return null
      const assets = Array.isArray(opts.assets) ? opts.assets : []
      // 双链里通常只写文件名，所以优先在「这篇笔记的附件」里按文件名匹配
      const base = clean.split('/').pop()
      const hit = assets.find((a) => a.name === clean || a.name === base)
      const path = (hit && hit.path) || clean
      if (IMAGE_EXT_RE.test(path)) {
        return h('img', {
          key,
          className: 'dshgn_img',
          src: `/getnote/asset?path=${encodeURIComponent(path)}`,
          alt: base,
          loading: 'lazy',
        })
      }
      return h('span', { key, className: 'dshgn_embedFile' }, base)
    }

    /** 表格：`| a | b |` + 分隔行。返回 { table, consumed }。 */
    function parseTable(lines, start) {
      const headerCells = splitRow(lines[start])
      if (headerCells === null) return null
      if (start + 1 >= lines.length) return null
      if (!/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[start + 1])) return null
      const rows = []
      let index = start + 2
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = splitRow(lines[index])
        if (cells === null) break
        rows.push(cells)
        index += 1
      }
      return { header: headerCells, rows, consumed: index - start }
    }

    function splitRow(line) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|')) return null
      const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
      return inner.split('|').map((cell) => cell.trim())
    }

    /**
     * 去掉正文开头与标题同名的一级标题。
     *
     * 云端笔记的正文经常以 `# 标题` 开头，而阅读区外面已经渲染了一行 h1，
     * 不剥掉就会出现两个一模一样的大标题。只剥「一级 + 同名」，别的不动。
     */
    function stripLeadingHeading(markdown, title) {
      const text = String(markdown || '')
      const name = String(title || '').trim()
      if (name === '') return text
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return text.replace(new RegExp(`^\\s*#\\s+${escaped}\\s*\\n+`), '')
    }

    function renderBlocks(markdown, options) {
      const opts = options || {}
      const lines = String(markdown || '').split(/\r?\n/)
      const blocks = []
      let index = 0
      let key = 0

      while (index < lines.length) {
        const line = lines[index]
        const trimmed = line.trim()

        if (trimmed === '') {
          index += 1
          continue
        }

        // 代码围栏
        const fence = /^(```|~~~)\s*(\S*)\s*$/.exec(trimmed)
        if (fence) {
          const marker = fence[1]
          const lang = fence[2] || ''
          const body = []
          index += 1
          while (index < lines.length && !lines[index].trim().startsWith(marker)) {
            body.push(lines[index])
            index += 1
          }
          index += 1 // 跳过收尾围栏（未闭合就到文件末尾）
          const fenceText = body.join('\n')
          // 归档里的「## 逐字稿」是一段带时间戳的围栏。用等宽字体渲染中文口语
          // 既丑又会被横向裁掉，所以认出来就走逐字稿排版。
          blocks.push(
            looksLikeTranscript(fenceText)
              ? h(TranscriptBlock, { key: `b${key++}`, text: fenceText })
              : h(
                  'pre',
                  { key: `b${key++}`, className: 'dshgn_pre' },
                  lang ? h('span', { className: 'dshgn_preLang' }, lang) : null,
                  h('code', null, fenceText),
                ),
          )
          continue
        }

        // 标题
        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
        if (heading) {
          const level = heading[1].length
          blocks.push(
            h(
              `h${Math.min(level + 0, 6)}`,
              { key: `b${key++}`, className: `dshgn_h dshgn_h${level}` },
              renderInline(heading[2], `b${key}`, opts),
            ),
          )
          index += 1
          continue
        }

        // 分隔线
        if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
          blocks.push(h('hr', { key: `b${key++}`, className: 'dshgn_hr' }))
          index += 1
          continue
        }

        // 表格
        if (trimmed.startsWith('|')) {
          const table = parseTable(lines, index)
          if (table) {
            blocks.push(
              h(
                'div',
                { key: `b${key++}`, className: 'dshgn_tableWrap' },
                h(
                  'table',
                  { className: 'dshgn_table' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      table.header.map((cell, i) => h('th', { key: i }, renderInline(cell, `th${i}`, opts))),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    table.rows.map((row, rowIndex) =>
                      h(
                        'tr',
                        { key: rowIndex },
                        row.map((cell, cellIndex) =>
                          h('td', { key: cellIndex }, renderInline(cell, `td${rowIndex}-${cellIndex}`, opts)),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            )
            index += table.consumed
            continue
          }
        }

        // 引用块（逐行，不吞后续行）
        if (trimmed.startsWith('>')) {
          const body = []
          while (index < lines.length && lines[index].trim().startsWith('>')) {
            body.push(lines[index].trim().replace(/^>\s?/, ''))
            index += 1
          }
          blocks.push(
            h(
              'blockquote',
              { key: `b${key++}`, className: 'dshgn_quote' },
              renderBlocks(body.join('\n')),
            ),
          )
          continue
        }

        // 列表（含任务列表）
        const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (listMatch) {
          const ordered = /\d/.test(listMatch[2])
          const items = []
          while (index < lines.length) {
            const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
            if (!current) {
              // 列表项里的续行
              if (lines[index].trim() !== '' && items.length > 0 && /^\s{2,}\S/.test(lines[index])) {
                items[items.length - 1].continuation.push(lines[index].trim())
                index += 1
                continue
              }
              break
            }
            items.push({ text: current[3], ordered: /\d/.test(current[2]), continuation: [] })
            index += 1
          }
          blocks.push(
            h(
              ordered ? 'ol' : 'ul',
              { key: `b${key++}`, className: 'dshgn_mdList' },
              items.map((item, itemIndex) => {
                const task = /^\[( |x|X)\]\s+(.*)$/.exec(item.text)
                const content = task ? task[2] : item.text
                return h(
                  'li',
                  { key: itemIndex, className: task ? 'dshgn_li dshgn_task' : 'dshgn_li' },
                  task
                    ? h('span', {
                        className: task[1].toLowerCase() === 'x' ? 'dshgn_check dshgn_checkOn' : 'dshgn_check',
                        'aria-hidden': 'true',
                      })
                    : null,
                  renderInline(content, `li${itemIndex}`, opts),
                  item.continuation.length > 0
                    ? h('div', { className: 'dshgn_liCont' }, renderInline(item.continuation.join(' '), `lc${itemIndex}`, opts))
                    : null,
                )
              }),
            ),
          )
          continue
        }

        // 段落：连续非空行合成一段（保持换行）
        const paragraph = []
        while (
          index < lines.length &&
          lines[index].trim() !== '' &&
          !/^\s*(#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[index]) &&
          !/^(\*{3,}|-{3,}|_{3,})$/.test(lines[index].trim())
        ) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(
          h('p', { key: `b${key++}`, className: 'dshgn_p' }, renderInline(paragraph.join('\n'), `p${key}`, opts)),
        )
      }

      return blocks
    }

    // ── 样式（只用 --dsw-* token，跟随主题）─────────────────────────────────────

    const CSS = `
.dshgn_root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-size:13px}
.dshgn_head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px;
  border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dshgn_headMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dshgn_title{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}
.dshgn_sub{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dshgn_tabs{display:flex;gap:2px;padding:3px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_tab{appearance:none;border:0;height:24px;padding:0 10px;border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:24px}
.dshgn_tab:hover{color:var(--dsw-alias-label-primary)}
.dshgn_tab[data-on="true"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.dshgn_actions{display:flex;align-items:center;gap:4px;flex:none}
.dshgn_iconBtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshgn_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshgn_iconBtn:disabled{opacity:.45;cursor:default}
.dshgn_iconBtn[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-brand-primary)}
.dshgn_btn{appearance:none;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;
  border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.dshgn_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_btn:disabled{opacity:.5;cursor:default}
.dshgn_btnPrimary{border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshgn_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshgn_btnDanger{color:var(--dsw-alias-state-error-primary)}
.dshgn_body{flex:1;display:flex;min-height:0}
.dshgn_tree{flex:none;width:190px;display:flex;flex-direction:column;min-height:0;
  border-right:0.5px solid var(--dsw-alias-border-l2);overflow-y:auto;padding:8px 6px}
.dshgn_treeHead{display:flex;align-items:center;justify-content:space-between;gap:6px;
  padding:4px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary);user-select:none}
.dshgn_treeRow{display:flex;align-items:center;gap:6px;height:26px;padding:0 7px;border-radius:7px;
  color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;user-select:none}
.dshgn_treeRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_treeRow[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}
.dshgn_treeName{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.dshgn_treeCount{flex:none;font-size:10px;color:var(--dsw-alias-label-dimmed)}
.dshgn_tagRow{display:inline-flex;align-items:center;gap:4px;height:22px;margin:0 4px 4px 0;padding:0 8px;
  border-radius:11px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px}
.dshgn_tagRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_tagRow[data-on="true"]{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover-accent);
  color:var(--dsw-alias-brand-primary)}
.dshgn_treeTags{display:flex;flex-wrap:wrap;padding:2px 4px}
.dshgn_list{flex:none;width:260px;display:flex;flex-direction:column;min-height:0;
  border-right:0.5px solid var(--dsw-alias-border-l2)}
.dshgn_searchWrap{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px;
  border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dshgn_search{flex:1;min-width:0;height:26px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);
  border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;
  font-size:12px;outline:none}
.dshgn_search:focus{border-color:var(--dsw-alias-brand-primary)}
/* 搜索框左侧的放大镜：以前没有规则，图标会被 input 的 flex:1 挤到贴边 */
.dshgn_searchIcon{flex:none;color:var(--dsw-alias-label-tertiary);pointer-events:none}
/* 侧栏入口图标（ownerProps.size 决定尺寸，这里只保证块级对齐） */
.dshgn_sideIcon{display:block;flex:none}
.dshgn_listBody{flex:1;overflow-y:auto;padding:6px}
.dshgn_card{display:flex;flex-direction:column;gap:2px;padding:7px 8px;border-radius:8px;cursor:pointer;
  border-left:2px solid transparent;user-select:none}
.dshgn_card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_card[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover-accent);
  border-left-color:var(--dsw-alias-brand-primary)}
.dshgn_cardTitle{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshgn_cardMeta{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;white-space:nowrap}
.dshgn_cardExcerpt{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshgn_note{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.dshgn_noteHead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 14px;
  border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dshgn_notePath{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshgn_scroll{flex:1;overflow-y:auto;padding:16px clamp(16px,3vw,32px) 48px}
.dshgn_md{max-width:760px;margin:0 auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.75}
.dshgn_h{margin:18px 0 8px;line-height:1.4;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshgn_h1{font-size:20px;margin-top:0}
.dshgn_h2{font-size:16px;padding-bottom:5px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dshgn_h3{font-size:14px}
.dshgn_h4,.dshgn_h5,.dshgn_h6{font-size:13px}
.dshgn_p{margin:8px 0;white-space:pre-wrap;word-break:break-word}
.dshgn_hr{border:0;border-top:0.5px solid var(--dsw-alias-border-l2);margin:16px 0}
.dshgn_link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.dshgn_link:hover{text-decoration:underline}
.dshgn_code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dshgn_pre{position:relative;margin:10px 0;padding:11px 12px;border-radius:9px;overflow-x:auto;
  background:var(--dsw-alias-interactive-bg-hover);border:0.5px solid var(--dsw-alias-border-l1)}
.dshgn_pre code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  line-height:1.65;white-space:pre;color:var(--dsw-alias-label-primary)}
.dshgn_preLang{position:absolute;top:4px;right:8px;font-size:10px;color:var(--dsw-alias-label-dimmed)}
/* 逐字稿单独一套排版：它是一段段中文口语，不是代码。
   以前复用 .dshgn_pre 的等宽字体，中文全部回落到宋体/雅黑，等宽对中文毫无作用，
   加上 white-space:pre 不折行，长句在窄栏里被横向裁掉，只能拖滚动条看——这就是「字体太丑」的由来。
   现在换成正文字体栈、放大字号、放宽行距，并允许自动折行；每段之间用细分隔线，
   方便对着时间戳找位置。 */
.dshgn_transcript{margin:10px 0;padding:2px 0 2px 0;border:0;background:transparent;
  font-family:var(--dsw-font-sans,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif);
  font-size:13px;line-height:1.9;color:var(--dsw-alias-label-primary);white-space:pre-wrap;
  word-break:break-word;overflow-wrap:anywhere}
.dshgn_transcript p{margin:0;padding:5px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.dshgn_transcript p:last-child{border-bottom:0}
.dshgn_transcript .dshgn_ts{display:inline-block;min-width:56px;margin-right:8px;
  font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);
  user-select:none}
.dshgn_transcript .dshgn_speaker{color:var(--dsw-alias-brand-primary);font-weight:600;margin-right:6px}
.dshgn_quote{margin:10px 0;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary)}
.dshgn_mdList{margin:8px 0;padding-left:22px}
.dshgn_li{margin:3px 0;line-height:1.7}
.dshgn_liCont{color:var(--dsw-alias-label-secondary)}
.dshgn_task{list-style:none;margin-left:-18px;display:flex;align-items:flex-start;gap:6px}
.dshgn_check{flex:none;width:12px;height:12px;margin-top:5px;border-radius:3px;
  border:1.5px solid var(--dsw-alias-border-l2);display:inline-block}
.dshgn_checkOn{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshgn_tableWrap{overflow-x:auto;margin:10px 0}
.dshgn_table{border-collapse:collapse;font-size:12px;min-width:100%}
.dshgn_table th,.dshgn_table td{padding:6px 10px;text-align:left;
  border-bottom:0.5px solid var(--dsw-alias-border-l2);vertical-align:top}
.dshgn_table th{color:var(--dsw-alias-label-secondary);font-weight:600;
  background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_editor{flex:1;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;padding:16px clamp(16px,3vw,32px);
  background:transparent;color:var(--dsw-alias-label-primary);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7}
.dshgn_empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;padding:32px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dshgn_emptyTitle{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dshgn_emptyDesc{font-size:12px;line-height:1.7;max-width:340px}
.dshgn_pane{flex:1;overflow-y:auto;padding:18px clamp(16px,3vw,28px) 40px}
.dshgn_cardBox{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.dshgn_section{display:flex;flex-direction:column;gap:8px;padding:14px 15px;border-radius:10px;
  border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay)}
.dshgn_sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
/* 卡片标题行：标题 + 右侧状态徽章。以前徽章只能挂在下一行，读起来像两个独立信息。 */
.dshgn_sectionHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}
.dshgn_sectionDesc{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dshgn_rowLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshgn_input{flex:1;min-width:180px;height:28px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l2);
  border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;
  font-size:12px;outline:none}
.dshgn_input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshgn_badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:10px;
  font-size:10.5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshgn_badgeOk{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-brand-primary)}
.dshgn_badgeWarn{background:transparent;color:var(--dsw-alias-state-warn-primary);
  box-shadow:inset 0 0 0 0.5px var(--dsw-alias-state-warn-primary)}
.dshgn_badgeErr{color:var(--dsw-alias-state-error-primary)}
.dshgn_log{max-height:220px;overflow-y:auto;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-interactive-bg-hover);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dshgn_error{padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:20;
  display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:9px;
  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);
  font-size:12px;box-shadow:0 6px 22px rgba(0,0,0,.16)}
.dshgn_rel{position:relative;height:100%}
.dshgn_spin{display:inline-block;width:12px;height:12px;border-radius:50%;
  border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);
  animation:dshgn-spin .8s linear infinite}
@keyframes dshgn-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dshgn_spin{animation:none}}
.dshgn_emptyState{display:flex;align-items:center;justify-content:center;height:100%;
  color:var(--dsw-alias-label-tertiary);font-size:12px}
/* ── 音频播放器 ── */
.dshgn_audioCard{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:10px;
  border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay)}
.dshgn_audioBar{display:flex;align-items:center;gap:10px}
.dshgn_audioBtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;
  border-radius:50%;border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);
  cursor:pointer;padding:0}
.dshgn_audioBtn:hover{background:var(--dsw-alias-button-primary-hover)}
.dshgn_audioBtn:disabled{opacity:.5;cursor:default}
/* 进度条改成自绘的 div，不再用 <input type=range>。
   原因：原生 range 在这套面板里实测「怎么拖都没反应」——元素只有 4px 高时鼠标抓不住拇指；
   把高度撑到 18px 也只是提高了命中率，受控 value 还会被 timeupdate 打回原位。
   自绘之后整条 18px 都是命中区，按下就能抓，setPointerCapture 保证拖出元素也不丢事件。
   touch-action:none 是必须的：不写的话触摸/触控板手势会抢走 pointermove，
   表现同样是「拖不动」。 */
.dshgn_audioSeek{position:relative;flex:1;min-width:0;height:18px;display:flex;align-items:center;
  cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;outline:none;
  border-radius:9px}
.dshgn_audioSeek:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dshgn_audioTrack{position:relative;width:100%;height:4px;border-radius:2px;
  background:var(--dsw-alias-border-l2);overflow:visible}
.dshgn_audioFill{position:absolute;left:0;top:0;height:100%;border-radius:2px;
  background:var(--dsw-alias-brand-primary)}
.dshgn_audioThumb{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;
  background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-overlay);
  box-shadow:0 1px 3px rgba(10,42,82,.28);transform:translate(-50%,-50%);pointer-events:none}
.dshgn_audioSeek:hover .dshgn_audioThumb{transform:translate(-50%,-50%) scale(1.12)}
.dshgn_audioTime{flex:none;font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary)}
.dshgn_audioLabel{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 开关 ── */
.dshgn_toggle{position:relative;flex:none;width:34px;height:19px;border-radius:10px;border:0;padding:0;
  background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s}
.dshgn_toggle[data-on="true"]{background:var(--dsw-alias-brand-primary)}
.dshgn_toggle::after{content:"";position:absolute;top:2.5px;left:2.5px;width:14px;height:14px;
  border-radius:50%;background:Canvas;transition:transform .15s}
.dshgn_toggle[data-on="true"]::after{transform:translateX(15px)}
.dshgn_toggleRow{display:flex;align-items:center;gap:10px;justify-content:space-between}
.dshgn_toggleLabel{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshgn_toggleTitle{font-size:12px;color:var(--dsw-alias-label-primary)}
.dshgn_toggleDesc{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
/* ── 表单字段 ── */
.dshgn_field{display:flex;flex-direction:column;gap:5px}
.dshgn_fieldLabel{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dshgn_fieldHint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.dshgn_textarea{width:100%;box-sizing:border-box;min-height:180px;resize:vertical;padding:9px 10px;
  border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px;line-height:1.65;outline:none}
.dshgn_textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dshgn_btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border-radius:7px;
  border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer}
.dshgn_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgn_btn:disabled{opacity:.5;cursor:default}
.dshgn_btnPri{border-color:transparent;background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground)}
.dshgn_btnPri:hover{background:var(--dsw-alias-button-primary-hover)}
.dshgn_btnDanger{color:var(--dsw-alias-state-error-primary)}
/* 胶囊/预设按钮：必须显式清掉 UA 的按钮底色与字体，
   否则在深色主题里会画成一块灰底（文字是主题色，底是浏览器默认灰）。 */
.dshgn_chip{display:inline-flex;align-items:center;gap:4px;height:21px;padding:0 9px;border-radius:11px;
  border:0.5px solid var(--dsw-alias-border-l2);background:transparent;font:inherit;
  font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dshgn_chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary)}
.dshgn_chip:disabled{opacity:.5;cursor:default}
.dshgn_chipOn{border-color:transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dshgn_chipOn:hover:not(:disabled){background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-foreground)}
/* 只读的标签胶囊（云端详情里的标签）：形状同 chip，但不假装可点 */
.dshgn_tagPill{display:inline-flex;align-items:center;height:21px;padding:0 9px;border-radius:11px;
  border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);
  font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
/* 标签胶囊上的「×」：只让那个叉可点，整块胶囊不响应点击——否则想点标签看详情的人
   会一不小心把标签删掉。 */
.dshgn_tagX{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;
  margin-left:5px;border:0;border-radius:50%;padding:0;cursor:pointer;font-size:11px;
  line-height:1;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit}
.dshgn_tagX:hover{background:var(--dsw-alias-state-error-primary);color:#fff}
/* 云端知识库筛选行：横向可滚，不换行——知识库多的账号换行后会占掉半屏。 */
.dshgn_topicRow{display:flex;gap:6px;overflow-x:auto;padding:2px 0 6px;flex:none}
.dshgn_topicChip{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:11px;
  border:0.5px solid var(--dsw-alias-border-l2);background:transparent;font:inherit;font-size:11px;
  color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;flex:none}
.dshgn_topicChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshgn_topicChip[data-on="true"]{border-color:transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-foreground);font-weight:500}
/* 图片附件：一行横向排，单张最高 200px，避免一张竖构图手机截图把整篇文章推到屏幕外。 */
.dshgn_imgRow{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.dshgn_img{max-width:100%;max-height:200px;border-radius:8px;object-fit:contain;
  border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover)}
/* Obsidian 双链：外观要像链接但不能真跳（库内跳转由 JS 处理），所以用 button 而不是 a。 */
.dshgn_wikilink{display:inline;padding:0;margin:0;border:0;background:transparent;font:inherit;
  color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:none;
  border-bottom:0.5px solid currentColor}
.dshgn_wikilink:hover{color:var(--dsw-alias-brand-primary);border-bottom-color:transparent}
/* 嵌入的非图片附件（![[x.pdf]] 这类）：只显示成一颗文件名胶囊，点不开也不假装能点。 */
.dshgn_embed{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;
  border-radius:10px;border:0.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-interactive-bg-hover);font-size:11px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;vertical-align:middle}
.dshgn_embedFile{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshgn_statGrid{display:flex;flex-wrap:wrap;gap:8px}
.dshgn_stat{display:flex;flex-direction:column;gap:1px;padding:7px 11px;border-radius:8px;
  background:var(--dsw-alias-interactive-bg-hover);min-width:66px}
.dshgn_statNum{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums}
.dshgn_statLabel{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dshgn_moment{display:flex;gap:10px;padding:5px 0;font-size:12px;line-height:1.65;
  border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.dshgn_moment:last-child{border-bottom:0}
.dshgn_momentAt{flex:none;width:44px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:11px}
.dshgn_momentAt:hover{text-decoration:underline}
.dshgn_banner{display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:10px;
  border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);text-align:center;
  align-items:center}
/* 警告型横幅：左对齐、带色边。用于「Key 被拒」这类要用户动手处理的提示，
   居中的空状态样式会让它看起来像普通说明文字而被划过去。 */
.dshgn_bannerWarn{align-items:stretch;text-align:left;
  border-left:3px solid var(--dsw-alias-state-warn-primary)}
.dshgn_bannerTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshgn_bannerWarn .dshgn_bannerTitle{color:var(--dsw-alias-state-warn-primary)}
.dshgn_bannerDesc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}

/* ══ 三栏配色：深蓝 → 浅蓝 → 极浅近白蓝 ══════════════════════════════════════
   做法：不改每个组件里的 token 用法，而是在各栏容器上**局部重定义** --dsw-alias-*
   变量。自定义属性沿 DOM 继承，于是这一栏里所有用 token 的字色/底色/边框色会
   自动跟着变，只有真正需要「换一种颜色」的地方才写显式规则。
   好处：以后调色只改这里一组变量，不会漏掉某个还在用旧 token 的角落。 */
.dshgn_root{
  /* 左栏（目录树）：很深的蓝 */
  --dshgn-deep:#0a2a52;
  --dshgn-deep2:#071d3b;
  --dshgn-deepFg:#e8f1fd;
  --dshgn-deepFg2:#c1d6ee;
  --dshgn-deepFg3:#8fb0d4;
  /* 中栏（笔记列表）：浅一点的蓝 */
  --dshgn-mid:#c5daf3;
  --dshgn-mid2:#b6cfee;
  --dshgn-midFg:#102a45;
  --dshgn-midFg2:#3d5c7e;
  --dshgn-midFg3:#5d7c9d;
  /* 右栏（阅读区）：很浅很浅、接近白的蓝 */
  --dshgn-light:#f7fbff;
  --dshgn-light2:#eef6ff;
  --dshgn-lightFg:#16283c;
  --dshgn-lightFg2:#40586f;
  --dshgn-lightFg3:#6b8298;
  /* 强调色：深栏上要够亮，浅栏上要够沉 */
  --dshgn-accentOnDark:#7fb8ff;
  --dshgn-accentOnLight:#1f6fb8;
  --dshgn-lineOnDark:rgba(255,255,255,.13);
  --dshgn-lineOnLight:rgba(10,42,82,.13);
}

/* ── 顶栏：与右栏同色系，压一条浅蓝分隔 ── */
.dshgn_head{
  background:linear-gradient(180deg,var(--dshgn-light) 0%,var(--dshgn-light2) 100%);
  border-bottom:1px solid var(--dshgn-lineOnLight);
  color:var(--dshgn-lightFg);
  --dsw-alias-label-primary:var(--dshgn-lightFg);
  --dsw-alias-label-secondary:var(--dshgn-lightFg2);
  --dsw-alias-label-tertiary:var(--dshgn-lightFg3);
  --dsw-alias-label-dimmed:var(--dshgn-lightFg3);
  --dsw-alias-border-l2:var(--dshgn-lineOnLight);
  --dsw-alias-interactive-bg-hover:rgba(10,42,82,.07);
  --dsw-alias-interactive-bg-hover-accent:rgba(31,111,184,.16);
  --dsw-alias-bg-overlay:#ffffff;
  --dsw-alias-brand-primary:var(--dshgn-accentOnLight);
}
.dshgn_tabs{background:rgba(10,42,82,.07);border-radius:10px}
.dshgn_tab[data-on="true"]{background:#ffffff;box-shadow:0 1px 3px rgba(10,42,82,.14)}

/* ── 左栏：深蓝。整栏用上深下更深的渐变，边界靠一条亮线收住 ── */
.dshgn_tree{
  width:204px;
  background:linear-gradient(180deg,var(--dshgn-deep) 0%,var(--dshgn-deep2) 100%);
  color:var(--dshgn-deepFg);
  border-right:1px solid rgba(0,0,0,.28);
  box-shadow:inset -1px 0 0 rgba(255,255,255,.06);
  scrollbar-color:rgba(255,255,255,.24) transparent;
  /* 局部把主题 token 翻成「深底浅字」，栏内一切 token 用法自动跟随 */
  --dsw-alias-label-primary:var(--dshgn-deepFg);
  --dsw-alias-label-secondary:var(--dshgn-deepFg2);
  --dsw-alias-label-tertiary:var(--dshgn-deepFg3);
  --dsw-alias-label-dimmed:var(--dshgn-deepFg3);
  --dsw-alias-label-primary-foreground:#08182c;
  --dsw-alias-border-l1:var(--dshgn-lineOnDark);
  --dsw-alias-border-l2:var(--dshgn-lineOnDark);
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.09);
  --dsw-alias-interactive-bg-hover-accent:rgba(255,255,255,.17);
  --dsw-alias-interactive-bg-active:rgba(255,255,255,.22);
  --dsw-alias-brand-primary:var(--dshgn-accentOnDark);
  --dsw-alias-button-primary-fill:#2f7fd4;
  --dsw-alias-button-primary-hover:#3d90e8;
}
/* 栏内小标题（目录/标签）：加字距，像侧边栏分组 */
.dshgn_tree .dshgn_treeHead{
  margin-top:6px;padding-top:9px;border-top:1px solid rgba(255,255,255,.09);
  letter-spacing:.06em;text-transform:uppercase;font-size:10px;
}
.dshgn_tree .dshgn_treeRow[data-on="true"]{box-shadow:inset 2px 0 0 var(--dshgn-accentOnDark)}
.dshgn_tree .dshgn_treeCount{
  min-width:18px;text-align:center;padding:0 4px;border-radius:8px;
  background:rgba(255,255,255,.11);font-size:10px;line-height:15px;
}
.dshgn_tree .dshgn_tagRow{
  background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);
}
.dshgn_tree .dshgn_tagRow:hover{background:rgba(255,255,255,.15)}
.dshgn_tree .dshgn_tagRow[data-on="true"]{
  background:var(--dshgn-accentOnDark);border-color:transparent;color:#08182c;font-weight:600;
}

/* ── 中栏：浅蓝。留一条稍深的右边线把它和阅读区区分开 ── */
.dshgn_list{
  width:272px;
  background:linear-gradient(180deg,var(--dshgn-mid) 0%,var(--dshgn-mid2) 100%);
  color:var(--dshgn-midFg);
  border-right:1px solid rgba(10,42,82,.16);
  scrollbar-color:rgba(10,42,82,.26) transparent;
  --dsw-alias-label-primary:var(--dshgn-midFg);
  --dsw-alias-label-secondary:var(--dshgn-midFg2);
  --dsw-alias-label-tertiary:var(--dshgn-midFg3);
  --dsw-alias-label-dimmed:var(--dshgn-midFg3);
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-border-l1:var(--dshgn-lineOnLight);
  --dsw-alias-border-l2:var(--dshgn-lineOnLight);
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.42);
  --dsw-alias-interactive-bg-hover-accent:rgba(255,255,255,.72);
  --dsw-alias-bg-overlay:#ffffff;
  --dsw-alias-brand-primary:var(--dshgn-accentOnLight);
  --dsw-alias-button-primary-fill:#1f6fb8;
  --dsw-alias-button-primary-hover:#2a82d4;
}
.dshgn_list .dshgn_searchWrap{border-bottom-color:rgba(10,42,82,.14)}
.dshgn_list .dshgn_search{
  background:rgba(255,255,255,.72);border-color:rgba(10,42,82,.16);
}
.dshgn_list .dshgn_search::placeholder{color:var(--dshgn-midFg3)}
.dshgn_list .dshgn_card{border-radius:9px;margin-bottom:2px}
.dshgn_list .dshgn_card[data-on="true"]{
  background:#ffffff;box-shadow:0 1px 4px rgba(10,42,82,.14);
  border-left-color:var(--dshgn-accentOnLight);
}
.dshgn_list .dshgn_cardTitle{font-weight:500}

/* ── 右栏：极浅近白蓝 ── */
.dshgn_note{
  background:var(--dshgn-light);
  color:var(--dshgn-lightFg);
  --dsw-alias-label-primary:var(--dshgn-lightFg);
  --dsw-alias-label-secondary:var(--dshgn-lightFg2);
  --dsw-alias-label-tertiary:var(--dshgn-lightFg3);
  --dsw-alias-label-dimmed:var(--dshgn-lightFg3);
  --dsw-alias-border-l1:var(--dshgn-lineOnLight);
  --dsw-alias-border-l2:var(--dshgn-lineOnLight);
  --dsw-alias-interactive-bg-hover:rgba(10,42,82,.055);
  --dsw-alias-interactive-bg-hover-accent:rgba(31,111,184,.12);
  --dsw-alias-bg-overlay:#ffffff;
  --dsw-alias-brand-primary:var(--dshgn-accentOnLight);
  --dsw-alias-button-primary-fill:#1f6fb8;
  --dsw-alias-button-primary-hover:#2a82d4;
  scrollbar-color:rgba(10,42,82,.22) transparent;
}
.dshgn_note .dshgn_noteHead{background:var(--dshgn-light2)}
.dshgn_note .dshgn_md{font-size:13.5px;line-height:1.8}
.dshgn_note .dshgn_md .dshgn_pre{background:#eaf2fb}
.dshgn_note .dshgn_md .dshgn_table th{background:#e9f2fc}
.dshgn_note .dshgn_md .dshgn_h2{border-bottom-color:rgba(10,42,82,.14)}

/* ── 其它页签（云端/同步/设置）：整页用极浅蓝，卡片纯白 ── */
.dshgn_pane{
  background:linear-gradient(180deg,var(--dshgn-light) 0%,var(--dshgn-light2) 100%);
  color:var(--dshgn-lightFg);
  --dsw-alias-label-primary:var(--dshgn-lightFg);
  --dsw-alias-label-secondary:var(--dshgn-lightFg2);
  --dsw-alias-label-tertiary:var(--dshgn-lightFg3);
  --dsw-alias-label-dimmed:var(--dshgn-lightFg3);
  --dsw-alias-border-l1:var(--dshgn-lineOnLight);
  --dsw-alias-border-l2:var(--dshgn-lineOnLight);
  --dsw-alias-interactive-bg-hover:rgba(10,42,82,.055);
  --dsw-alias-interactive-bg-hover-accent:rgba(31,111,184,.12);
  --dsw-alias-bg-overlay:#ffffff;
  --dsw-alias-brand-primary:var(--dshgn-accentOnLight);
  --dsw-alias-button-primary-fill:#1f6fb8;
  --dsw-alias-button-primary-hover:#2a82d4;
}
.dshgn_pane .dshgn_section{box-shadow:0 1px 2px rgba(10,42,82,.06)}
.dshgn_pane .dshgn_input,.dshgn_pane .dshgn_textarea{background:#ffffff}
.dshgn_pane .dshgn_log{background:#eef5fd}
.dshgn_pane .dshgn_stat{background:#eaf2fc}
.dshgn_root{background:var(--dshgn-light)}

/* 深色栏里的滚动条（WebKit 不认 scrollbar-color） */
.dshgn_tree::-webkit-scrollbar,.dshgn_list::-webkit-scrollbar,
.dshgn_note .dshgn_scroll::-webkit-scrollbar,.dshgn_pane::-webkit-scrollbar{width:9px;height:9px}
.dshgn_tree::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:5px}
.dshgn_list::-webkit-scrollbar-thumb{background:rgba(10,42,82,.24);border-radius:5px}
.dshgn_note .dshgn_scroll::-webkit-scrollbar-thumb,
.dshgn_pane::-webkit-scrollbar-thumb{background:rgba(10,42,82,.18);border-radius:5px}
.dshgn_tree::-webkit-scrollbar-track,.dshgn_list::-webkit-scrollbar-track,
.dshgn_note .dshgn_scroll::-webkit-scrollbar-track,.dshgn_pane::-webkit-scrollbar-track{background:transparent}
`

    function injectCss() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
      return () => {
        try {
          style.remove()
        } catch {
          // 卸载顺序不可控时忽略
        }
      }
    }

    // ── 侧栏入口 ──────────────────────────────────────────────────────────────

    /** 侧栏按钮图标。尺寸与激活态由 sidebar.panellist 的 ownerProps 给。 */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      const active = props && props.active === true
      return h(Icon, { name: 'brain', size, className: active ? 'dshgn_sideIcon dshgn_sideIconOn' : 'dshgn_sideIcon' })
    }

    // ── 面板 ──────────────────────────────────────────────────────────────────

    function GetnotePage() {
      // t 每次调用才去问 locale，所以这里缓存的是「取文案的函数」而不是文案本身
      const t = React.useMemo(() => makeT(), [])
      const [tab, setTab] = React.useState('notes')
      const [status, setStatus] = React.useState(null)
      const [tree, setTree] = React.useState(null)
      const [entries, setEntries] = React.useState([])
      const [dirs, setDirs] = React.useState([])
      const [query, setQuery] = React.useState('')
      const [activeDir, setActiveDir] = React.useState('')
      const [activeTag, setActiveTag] = React.useState('')
      const [current, setCurrent] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [error, setError] = React.useState(null)

      const showToast = React.useCallback((text) => {
        setToast(text)
        window.setTimeout(() => setToast(null), 2400)
      }, [])

      const refresh = React.useCallback(async () => {
        setError(null)
        try {
          const [statusJson, treeJson] = await Promise.all([api('/status'), api('/tree')])
          setStatus(statusJson)
          setTree(treeJson.tree || null)
          setEntries(Array.isArray(treeJson.entries) ? treeJson.entries : [])
          setDirs(Array.isArray(treeJson.dirs) ? treeJson.dirs : [])
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // 标签云：按出现频次排序，取前 24 个（全量的标签墙反而找不到想要的那个）
      const tagCounts = React.useMemo(() => {
        const counts = new Map()
        for (const entry of entries) {
          for (const tag of entry.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1)
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
      }, [entries])

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        return entries.filter((entry) => {
          if (activeDir !== '') {
            if (entry.dir !== activeDir && !entry.path.startsWith(`${activeDir}/`)) return false
          }
          if (activeTag !== '' && !(entry.tags || []).includes(activeTag)) return false
          if (needle === '') return true
          return (
            entry.title.toLowerCase().includes(needle) ||
            entry.path.toLowerCase().includes(needle) ||
            (entry.excerpt || '').toLowerCase().includes(needle) ||
            (entry.tags || []).some((tag) => tag.toLowerCase().includes(needle))
          )
        })
      }, [entries, query, activeDir, activeTag])

      const openNote = React.useCallback(
        async (path) => {
          setError(null)
          try {
            const note = await api(`/read?path=${encodeURIComponent(path)}`)
            setCurrent(note)
            setDraft(note.content)
          } catch (err) {
            setCurrent(null)
            setDraft(null)
            setError(err && err.message ? err.message : String(err))
          }
        },
        [],
      )

      /**
       * 打开 Obsidian 双链的目标。
       *
       * 双链写法有三种：`[[完整/路径/笔记]]`、`[[笔记标题]]`、`[[标题|显示文字]]`。
       * 前两种要分开处理——只写标题时库里可能有同名文件在任意目录，所以按
       * 「路径完全相等 → 文件名（去扩展名）相等 → 标题相等」三级退让找。
       * 都找不到就明确提示，而不是静默什么都不做（那样用户以为点击没反应）。
       */
      const openWikiLink = React.useCallback(
        (target) => {
          const raw = String(target || '').trim()
          if (raw === '') return
          const wanted = raw.replace(/\.md$/i, '')
          const list = entries || []
          const direct = list.find((entry) => entry.path === raw || entry.path === `${wanted}.md`)
          if (direct !== undefined) {
            void openNote(direct.path)
            return
          }
          const byName = list.find((entry) => {
            const name = entry.path.split('/').pop().replace(/\.md$/i, '')
            return name === wanted
          })
          if (byName !== undefined) {
            void openNote(byName.path)
            return
          }
          const lowered = wanted.toLowerCase()
          const byTitle = list.find((entry) => String(entry.title || '').toLowerCase() === lowered)
          if (byTitle !== undefined) {
            void openNote(byTitle.path)
            return
          }
          setError(t('note.wikilinkMissing').replace('{name}', wanted))
        },
        [entries, openNote, t],
      )

      const dirty = current !== null && draft !== null && draft !== current.content

      const saveNote = React.useCallback(async () => {
        if (current === null || draft === null) return
        setBusy(true)
        try {
          await api('/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: current.path, content: draft }),
          })
          setCurrent({ ...current, content: draft })
          showToast(t('note.saved'))
          void refresh()
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [current, draft, refresh, showToast, t])

      const newNote = React.useCallback(async () => {
        setBusy(true)
        try {
          const created = await api('/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              dir: activeDir,
              title: t('action.new'),
              content: '',
            }),
          })
          showToast(t('note.created'))
          await refresh()
          await openNote(created.path)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [activeDir, openNote, refresh, showToast, t])

      const deleteNote = React.useCallback(async () => {
        if (current === null) return
        setBusy(true)
        try {
          await api('/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: current.path }),
          })
          setCurrent(null)
          setDraft(null)
          showToast(t('note.deleted'))
          void refresh()
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [current, refresh, showToast, t])

      const copyReference = React.useCallback(async () => {
        if (current === null || status === null) return
        const abs = `${status.vaultRoot}${status.vaultRoot.endsWith('/') || status.vaultRoot.endsWith('\\') ? '' : '/'}${current.path}`
        const text = /[\s"]/.test(abs) ? `@"${abs}"` : `@${abs}`
        try {
          await navigator.clipboard.writeText(text)
          showToast(t('action.copied'))
        } catch {
          showToast(text)
        }
      }, [current, status, showToast, t])

      const vaultReady = status !== null && status.vaultMissing === false

      const tabButton = (id, label) =>
        h(
          'button',
          { type: 'button', className: 'dshgn_tab', 'data-on': tab === id ? 'true' : 'false', onClick: () => setTab(id) },
          label,
        )

      const head = h(
        'div',
        { className: 'dshgn_head' },
        h(
          'div',
          { className: 'dshgn_headMain' },
          h('div', { className: 'dshgn_title' }, t('panel.title')),
          h(
            'div',
            { className: 'dshgn_sub', title: status ? status.vaultRoot : '' },
            status === null ? '' : status.vaultMissing ? t('empty.noVault') : status.vaultRoot,
          ),
        ),
        h('div', { className: 'dshgn_tabs' }, tabButton('notes', t('tab.notes')), tabButton('cloud', t('tab.cloud')), tabButton('sync', t('tab.sync')), tabButton('settings', t('tab.settings')), tabButton('trash', t('tab.trash'))),
        h(
          'div',
          { className: 'dshgn_actions' },
          tab === 'notes' || tab === 'cloud'
            ? h(
                React.Fragment,
                null,
                h(
                  'button',
                  { type: 'button', className: 'dshgn_iconBtn', title: t('action.new'), onClick: newNote, disabled: busy || !vaultReady },
                  h(Icon, { name: 'plus' }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshgn_iconBtn', title: t('action.refresh'), onClick: refresh, disabled: busy },
                  h(Icon, { name: 'refresh' }),
                ),
              )
            : null,
        ),
      )

      let body
      if (tab === 'cloud') {
        body = h(CloudPane, {
          t,
          status,
          showToast,
          onError: (message) => setError(message),
          onSynced: () => {
            void refresh()
          },
        })
      } else if (tab === 'sync') {
        body = h(SyncPane, {
          t,
          status,
          onChanged: async () => {
            await refresh()
          },
          onError: (message) => setError(message),
          showToast,
        })
      } else if (tab === 'settings') {
        body = h(SettingsPane, {
          t,
          status,
          onSaved: async (message) => {
            showToast(message)
            await refresh()
          },
          onError: (message) => setError(message),
          showToast,
        })
      } else if (tab === 'trash') {
        body = h(TrashPane, {
          t,
          status,
          onChanged: async () => {
            await refresh()
          },
          onError: (message) => setError(message),
          showToast,
        })
      } else {
        body = h(
          'div',
          { className: 'dshgn_body' },
          h(TreePane, {
            t,
            tree,
            dirs,
            entries,
            activeDir,
            activeTag,
            tagCounts,
            onPickDir: (dir) => {
              setActiveDir(dir)
              setActiveTag('')
            },
            onPickTag: (tag) => {
              setActiveTag(tag)
              setActiveDir('')
            },
          }),
          h(
            'div',
            { className: 'dshgn_list' },
            h(
              'div',
              { className: 'dshgn_searchWrap' },
              h(Icon, { name: 'search', size: 14, className: 'dshgn_searchIcon' }),
              h('input', {
                className: 'dshgn_search',
                type: 'search',
                value: query,
                placeholder: t('search.placeholder'),
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'dshgn_listBody' },
              visible.length === 0
                ? h(
                    'div',
                    { className: 'dshgn_empty', style: { padding: '24px 12px' } },
                    h('div', { className: 'dshgn_emptyTitle' }, query.trim() !== '' ? t('empty.search') : t('empty.noNotes')),
                  )
                : visible.map((entry) =>
                    h(
                      'div',
                      {
                        key: entry.path,
                        className: 'dshgn_card',
                        'data-on': current !== null && current.path === entry.path ? 'true' : 'false',
                        onClick: () => {
                          if (dirty && !window.confirm(t('note.unsaved'))) return
                          void openNote(entry.path)
                        },
                        title: entry.path,
                      },
                      h('div', { className: 'dshgn_cardTitle' }, entry.title),
                      h(
                        'div',
                        { className: 'dshgn_cardMeta' },
                        entry.date ? h('span', null, entry.date) : null,
                        entry.dir ? h('span', null, entry.dir) : null,
                      ),
                      entry.excerpt ? h('div', { className: 'dshgn_cardExcerpt' }, entry.excerpt) : null,
                    ),
                  ),
            ),
          ),
          h(NotePane, {
            t,
            status,
            current,
            draft,
            setDraft,
            dirty,
            busy,
            onSave: saveNote,
            onDelete: deleteNote,
            onCopyReference: copyReference,
            onOpenWikiLink: openWikiLink,
            onError: (message) => setError(message),
          }),
        )
      }

      return h(
        'div',
        { className: 'dshgn_rel' },
        h('div', { className: 'dshgn_root' }, head, error !== null ? h('div', { className: 'dshgn_error', role: 'alert' }, `${t('error.prefix')}: ${error}`) : null, body),
        toast !== null ? h('div', { className: 'dshgn_toast' }, h(Icon, { name: 'check', size: 13 }), toast) : null,
      )
    }

    // ── 音频播放器 ────────────────────────────────────────────────────────────

    /**
     * 录音播放器。
     *
     * 关键设计：`<audio src>` **不直接指向云端的签名 URL**，而是指向本插件的
     * `/getnote/audio?url=...` 代理。三个原因：
     *   1. 云端 play_url 是短期签名，面板开着放二十分钟就会 403；
     *   2. 那个 URL 是拿用户凭证签出来的，直接暴露在 DOM 里不合适；
     *   3. 部分 CDN 不给跨源 audio 加载，代理能绕开。
     *
     * 用原生 <audio> 而不是自绘波形：原生有系统级的播放能力、支持 Range 拖动、
     * 有键盘可达性，自绘只会更差。
     */
    function AudioPlayer(props) {
      const { t, track, onTimeChange } = props
      const audioRef = React.useRef(null)
      const [playing, setPlaying] = React.useState(false)
      const [current, setCurrent] = React.useState(0)
      const [duration, setDuration] = React.useState(track && track.duration ? track.duration : 0)
      const [failed, setFailed] = React.useState(false)
      // 拖动进度条时，拇指要跟手走。以前直接把 value 绑到 current，用户一拖
      // 就 setCurrent，紧接着 audio 的 timeupdate 又拿旧时间把它打回去，
      // 拇指原地弹回——表现就是「进度条拖不动」。所以拖动期间单独存一份值，
      // timeupdate 不再覆盖它，松手才真正落定。
      const [dragging, setDragging] = React.useState(false)
      const [dragValue, setDragValue] = React.useState(0)

      // 云端的 track 是 CDN 上的签名 URL，必须过 host 侧代理（会过期、会漏凭证）；
      // 本地附件的 track 已经是 `/getnote/asset?...` 这种本站路径，原样用即可。
      const src = track
        ? track.url.startsWith('/getnote/')
          ? track.url
          : `/getnote/audio?url=${encodeURIComponent(track.url)}`
        : null

      // 换音轨时重置播放状态（否则进度条会停在上一首的位置）
      React.useEffect(() => {
        setPlaying(false)
        setCurrent(0)
        setDuration(track && track.duration ? track.duration : 0)
        setFailed(false)
        const el = audioRef.current
        if (el) {
          try {
            el.pause()
            el.currentTime = 0
          } catch {
            /* 还没加载好，忽略 */
          }
        }
      }, [src])

      const toggle = React.useCallback(() => {
        const el = audioRef.current
        if (!el) return
        if (el.paused) {
          const p = el.play()
          // 浏览器可能因为「无用户手势」拒绝播放，这里必须接住，否则控制台一片红
          if (p && typeof p.catch === 'function') p.catch(() => setFailed(true))
        } else {
          el.pause()
        }
      }, [])

      // ── 进度条：自绘 div + 指针捕获 ─────────────────────────────────────
      // 不用 <input type=range>：实测在这套面板里「怎么拖都没反应」。两个原因叠加：
      //   1) 元素只有 4px 高时鼠标抓不住拇指；撑到 18px 也只是提高命中率。
      //   2) 受控 value 绑在 current 上，timeupdate 每秒多次把它打回播放位置，
      //      拇指一拖就弹回——看起来完全没反应。
      // 现在整条 18px 都是命中区，按下即抓；拖动中只改 dragValue（不动 audio），
      // 松手才写 currentTime，避免每动一像素 seek 一次把流式代理拖到反复重新缓冲。
      const barRef = React.useRef(null)

      const valueFromPointer = React.useCallback(
        (clientX) => {
          const el = barRef.current
          if (!el) return 0
          const rect = el.getBoundingClientRect()
          if (!rect.width) return 0
          const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
          return Math.round(ratio * Math.max(1, Math.round(duration)))
        },
        [duration],
      )

      const commitSeek = React.useCallback((target) => {
        const value = Math.max(0, Number(target) || 0)
        const el = audioRef.current
        if (el) {
          try {
            el.currentTime = value
          } catch {
            /* 尚未可 seek：忽略 */
          }
        }
        setCurrent(value)
      }, [])

      const onSeekDown = React.useCallback(
        (event) => {
          // 只响应主键（触屏/触控板的 pointerdown button 是 0 或 undefined）
          if (typeof event.button === 'number' && event.button !== 0) return
          const target = valueFromPointer(event.clientX)
          setDragging(true)
          setDragValue(target)
          // 捕获指针：拖出进度条外面也继续收 move/up，否则在元素外松手就丢事件，
          // 拖动态会永久卡住（这正是原生 input 的老毛病）。
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* 老浏览器没有 pointer capture：退化为普通拖动 */
          }
        },
        [valueFromPointer],
      )

      const onSeekMove = React.useCallback(
        (event) => {
          if (!dragging) return
          setDragValue(valueFromPointer(event.clientX))
        },
        [dragging, valueFromPointer],
      )

      const onSeekUp = React.useCallback(
        (event) => {
          if (!dragging) return
          const target = valueFromPointer(event.clientX)
          setDragging(false)
          setDragValue(target)
          commitSeek(target)
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            /* 没捕获过就忽略 */
          }
        },
        [dragging, valueFromPointer, commitSeek],
      )

      // 键盘可达性：左右方向键 ±5 秒，Home/End 到首尾。
      const onSeekKey = React.useCallback(
        (event) => {
          const max = Math.max(1, Math.round(duration))
          const base = dragging ? dragValue : current
          let next = null
          if (event.key === 'ArrowLeft') next = Math.max(0, base - 5)
          else if (event.key === 'ArrowRight') next = Math.min(max, base + 5)
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = max
          if (next === null) return
          event.preventDefault()
          setDragValue(next)
          commitSeek(next)
        },
        [dragging, dragValue, current, duration, commitSeek],
      )

      const mmss = (sec) => {
        const s = Math.max(0, Math.floor(Number(sec) || 0))
        const m = Math.floor(s / 60)
        const r = s % 60
        return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
      }

      if (!track) return null

      // 拇指/填充的横向位置。时长未知（duration 还是 0）时按 0 处理，避免除以 0。
      const maxValue = Math.max(1, Math.round(duration))
      const shown = Math.min(Math.round(dragging ? dragValue : current), maxValue)
      const percent = maxValue > 0 ? Math.max(0, Math.min(100, (shown / maxValue) * 100)) : 0

      return h(
        'div',
        { className: 'dshgn_audioCard' },
        h(
          'div',
          { className: 'dshgn_audioLabel' },
          h(Icon, { name: 'audio', size: 13 }),
          h('span', null, track.kind === 'local' ? t('note.localAudio') : t('cloud.audio')),
          track.title ? h('span', { className: 'dshgn_treeCount' }, track.title) : null,
        ),
        h(
          'div',
          { className: 'dshgn_audioBar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshgn_audioBtn',
              onClick: toggle,
              title: playing ? t('cloud.pause') : t('cloud.play'),
              'aria-label': playing ? t('cloud.pause') : t('cloud.play'),
            },
            h(Icon, { name: playing ? 'pause' : 'play', size: 14 }),
          ),
          h(
            'div',
            {
              ref: barRef,
              className: 'dshgn_audioSeek',
              role: 'slider',
              tabIndex: 0,
              'aria-label': t('cloud.audio'),
              'aria-valuemin': 0,
              'aria-valuemax': Math.max(1, Math.round(duration)),
              'aria-valuenow': Math.round(dragging ? dragValue : current),
              onPointerDown: onSeekDown,
              onPointerMove: onSeekMove,
              onPointerUp: onSeekUp,
              onPointerCancel: onSeekUp,
              onKeyDown: onSeekKey,
            },
            h(
              'div',
              { className: 'dshgn_audioTrack' },
              h('div', { className: 'dshgn_audioFill', style: { width: `${percent}%` } }),
              h('div', { className: 'dshgn_audioThumb', style: { left: `${percent}%` } }),
            ),
          ),
          h('span', { className: 'dshgn_audioTime' }, `${mmss(dragging ? dragValue : current)} / ${mmss(duration)}`),
        ),
        failed ? h('div', { className: 'dshgn_fieldHint', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, track.url) : null,
        h('audio', {
          ref: audioRef,
          src,
          preload: 'metadata',
          style: { display: 'none' },
          onPlay: () => setPlaying(true),
          onPause: () => setPlaying(false),
          onEnded: () => {
            setPlaying(false)
            setCurrent(0)
          },
          onError: () => setFailed(true),
          onLoadedMetadata: (event) => {
            const d = event.target.duration
            if (Number.isFinite(d) && d > 0) setDuration(d)
          },
          onTimeUpdate: (event) => {
            const c = event.target.currentTime
            setCurrent(c)
            if (typeof onTimeChange === 'function') onTimeChange(c)
          },
        }),
      )
    }

    // ── 云端面板 ──────────────────────────────────────────────────────────────

    /**
     * 云端视图：直接读得到大脑，不经过本地文件。
     *
     * 和「笔记」页签的分工：本地页签永远是离线的、快的、可读写的；云端页签是
     * 在线的、能播放录音和改云端内容的。两个都保留，因为用户在不同场景下需要
     * 不同的东西（断网时读本地，想改云端时用云端）。
     */
    function CloudPane(props) {
      const { t, status, showToast, onError, onSynced } = props
      const configured = status !== null && status.api !== undefined && status.api.configured === true

      const [list, setList] = React.useState([])
      const [cursor, setCursor] = React.useState(null)
      const [hasMore, setHasMore] = React.useState(false)
      const [loading, setLoading] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailLoading, setDetailLoading] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [draftTitle, setDraftTitle] = React.useState('')
      const [draftBody, setDraftBody] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [recallHits, setRecallHits] = React.useState(null)
      const [recalling, setRecalling] = React.useState(false)
      const [shareUrl, setShareUrl] = React.useState(null)
      const [tagDraft, setTagDraft] = React.useState('')
      const [topics, setTopics] = React.useState(null)
      const [activeTopic, setActiveTopic] = React.useState(null)
      const [composing, setComposing] = React.useState(false)
      const [newTitle, setNewTitle] = React.useState('')
      const [newBody, setNewBody] = React.useState('')

      const loadFirst = React.useCallback(async () => {
        if (!configured) return
        setLoading(true)
        onError(null)
        try {
          const page = await api('/cloud/list?limit=20')
          setList(Array.isArray(page.notes) ? page.notes : [])
          setCursor(page.cursor ?? null)
          setHasMore(page.hasMore === true)
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setLoading(false)
        }
      }, [configured, onError])

      const loadMore = React.useCallback(async () => {
        if (!hasMore || loading) return
        setLoading(true)
        try {
          const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
          const page = await api(`/cloud/list?limit=20${q}`)
          setList((prev) => [...prev, ...(Array.isArray(page.notes) ? page.notes : [])])
          setCursor(page.cursor ?? null)
          setHasMore(page.hasMore === true)
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setLoading(false)
        }
      }, [cursor, hasMore, loading, onError])

      React.useEffect(() => {
        void loadFirst()
      }, [loadFirst])

      // 知识库列表：进来就拉一次，之后基本不变（用户很少改知识库结构）
      React.useEffect(() => {
        if (!configured) return undefined
        let alive = true
        void (async () => {
          try {
            const result = await api('/cloud/topics')
            if (alive) setTopics(Array.isArray(result.topics) ? result.topics : [])
          } catch {
            // 知识库拉不到不影响看笔记，静默即可
          }
        })()
        return () => {
          alive = false
        }
      }, [configured])

      /** 切到某个知识库：拉库内笔记，替换列表。传 null 回到全部。 */
      const pickTopic = React.useCallback(
        async (topic) => {
          setActiveTopic(topic)
          setRecallHits(null)
          if (topic === null) {
            await loadFirst()
            return
          }
          setLoading(true)
          onError(null)
          try {
            const page = await api(`/cloud/topic-notes?topicId=${encodeURIComponent(topic.topicId || topic.id)}&page=1`)
            setList(Array.isArray(page.notes) ? page.notes : [])
            setCursor(null)
            setHasMore(false)
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setLoading(false)
          }
        },
        [loadFirst, onError],
      )

      /** 在云端新建一篇笔记。 */
      const createCloudNote = React.useCallback(async () => {
        const title = newTitle.trim()
        if (title === '') return
        setBusy(true)
        onError(null)
        try {
          const result = await api('/cloud/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title,
              content: newBody,
              topicId: activeTopic !== null ? activeTopic.topicId || activeTopic.id : undefined,
            }),
          })
          showToast(t('cloud.created'))
          setComposing(false)
          setNewTitle('')
          setNewBody('')
          await loadFirst()
          if (result && result.noteId) {
            await openCloudNote({ noteId: String(result.noteId), title })
          }
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [activeTopic, loadFirst, newBody, newTitle, onError, showToast, t])

      // 打开一篇云端笔记：列表里没有 audio/timeline，必须拉详情
      const openCloudNote = React.useCallback(
        async (note) => {
          setSelected(note)
          setDetail(null)
          setEditing(false)
          setDetailLoading(true)
          onError(null)
          try {
            const result = await api(`/cloud/read?id=${encodeURIComponent(note.noteId)}`)
            // localPath 挂在响应顶层（host 从同步状态里查的），但界面上它属于这篇笔记，
            // 所以合并进去，免得每处判断都要同时看 detail 与外部状态。
            setDetail({ ...result.note, localPath: result.localPath || '' })
            setDraftTitle(result.note.title || '')
            setDraftBody(result.note.content || result.note.original || '')
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setDetailLoading(false)
          }
        },
        [onError],
      )

      const saveCloud = React.useCallback(async () => {
        if (!detail) return
        setBusy(true)
        try {
          await api('/cloud/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ noteId: detail.noteId, title: draftTitle, content: draftBody }),
          })
          showToast(t('cloud.savedCloud'))
          setEditing(false)
          // 云端改完 host 侧已顺手刷新本地镜像，这里重拉一次保证显示的是新值
          await openCloudNote(detail)
          if (typeof onSynced === 'function') onSynced()
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [detail, draftTitle, draftBody, openCloudNote, onError, onSynced, showToast, t])

      const deleteCloud = React.useCallback(async () => {
        if (!detail) return
        if (!window.confirm(`${t('cloud.deleteCloud')}：${detail.title || detail.noteId}？`)) return
        setBusy(true)
        try {
          await api('/cloud/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ noteId: detail.noteId }),
          })
          showToast(t('cloud.deletedCloud'))
          setSelected(null)
          setDetail(null)
          await loadFirst()
          if (typeof onSynced === 'function') onSynced()
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [detail, loadFirst, onError, onSynced, showToast, t])

      const pullOne = React.useCallback(async () => {
        if (!detail) return
        setBusy(true)
        try {
          const result = await api('/cloud/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ noteId: detail.noteId, title: detail.title, content: detail.content || detail.original || '' }),
          })
          showToast(result.local && result.local.path ? result.local.path : t('cloud.localCopy'))
          if (typeof onSynced === 'function') onSynced()
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [detail, onError, onSynced, showToast, t])

      // 语义召回：和本地子串搜索是两套东西，所以单独一个按钮
      const doRecall = React.useCallback(async () => {
        const q = query.trim()
        if (q === '') return
        setRecalling(true)
        onError(null)
        try {
          const result = await api('/cloud/recall', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: q, topK: 8 }),
          })
          setRecallHits(Array.isArray(result.results) ? result.results : [])
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setRecalling(false)
        }
      }, [query, onError])

      // ── 标签 ────────────────────────────────────────────────────────────────
      // 云端标签是服务端的数据，加/删都要回写；本地镜像由 host 侧顺手刷新，
      // 所以这里改完重拉详情，而不是乐观更新（乐观更新一旦失败界面就是假的）。
      const addCloudTag = React.useCallback(
        async (tag) => {
          const name = String(tag || '').trim()
          if (name === '' || !detail) return
          setBusy(true)
          try {
            await api('/cloud/tags-add', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ noteId: detail.noteId, tags: [name] }),
            })
            showToast(t('cloud.tagAdded'))
            await openCloudNote(detail)
            await loadFirst()
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [detail, loadFirst, onError, openCloudNote, showToast, t],
      )

      const removeCloudTag = React.useCallback(
        async (tag) => {
          if (!detail || !tag) return
          // 服务端删标签要 tag_id，不是名字；列表里可能只有名字，那就先按名字找
          const tagId = tag.id !== undefined && tag.id !== null ? tag.id : tag.name
          setBusy(true)
          try {
            await api('/cloud/tags-delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ noteId: detail.noteId, tagId }),
            })
            showToast(t('cloud.tagRemoved'))
            await openCloudNote(detail)
            await loadFirst()
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [detail, loadFirst, onError, openCloudNote, showToast, t],
      )

      // ── 分享链接 ────────────────────────────────────────────────────────────
      const shareCloud = React.useCallback(
        async (excludeAudio) => {
          if (!detail) return
          setBusy(true)
          try {
            const result = await api('/cloud/share', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ noteId: detail.noteId, excludeAudio: excludeAudio === true }),
            })
            const url = String(result.url || '')
            if (url !== '') {
              setShareUrl(url)
              // 复制到剪贴板：失败不算错误（有些环境没有剪贴板权限），
              // 链接已经显示在卡片上，用户仍能手动选。
              try {
                await navigator.clipboard.writeText(url)
                showToast(t('cloud.copied'))
              } catch {
                showToast(t('cloud.shareCreated'))
              }
            } else {
              showToast(t('cloud.shareCreated'))
            }
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [detail, onError, showToast, t],
      )

      // ── 把这一篇的本地版本推到云端 ──────────────────────────────────────────
      // 危险动作：会覆盖云端正文。所以走「确认 + 明确说明改的是云端」。
      const pushLocalOne = React.useCallback(async () => {
        if (!detail) return
        const localPath = detail.localPath || ''
        if (localPath === '') {
          onError(t('cloud.noLocalCopy'))
          return
        }
        if (!window.confirm(`${t('cloud.pushLocal')}\n\n${t('cloud.pushHint')}`)) return
        setBusy(true)
        try {
          await api('/sync/push', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: localPath }),
          })
          showToast(t('cloud.pushed'))
          await openCloudNote(detail)
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [detail, onError, openCloudNote, showToast, t])

      if (!configured) {
        return h(
          'div',
          { className: 'dshgn_pane' },
          h(
            'div',
            { className: 'dshgn_banner' },
            h(Icon, { name: 'cloud', size: 26 }),
            h('div', { className: 'dshgn_emptyTitle' }, t('cloud.notConfigured')),
            h('div', { className: 'dshgn_emptyDesc' }, t('cloud.notConfiguredDesc')),
          ),
        )
      }

      const shown = recallHits !== null ? recallHits : list

      const listPane = h(
        'div',
        { className: 'dshgn_list' },
        h(
          'div',
          { className: 'dshgn_searchWrap' },
          h(Icon, { name: 'search', size: 14, className: 'dshgn_searchIcon' }),
          h('input', {
            className: 'dshgn_search',
            type: 'search',
            value: query,
            placeholder: t('search.placeholder'),
            onChange: (event) => {
              setQuery(event.target.value)
              // 输入清空就退回普通列表，避免用户以为列表没了
              if (event.target.value.trim() === '') setRecallHits(null)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') void doRecall()
            },
          }),
        ),
        // 知识库筛选：云端笔记是按知识库归档的，不提供筛选就只能一路翻页找
        topics !== null && topics.length > 0
          ? h(
              'div',
              { className: 'dshgn_topicRow' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgn_chip' + (activeTopic === null ? ' dshgn_chipOn' : ''),
                  onClick: () => void pickTopic(null),
                },
                t('cloud.allTopics'),
              ),
              topics.map((topic) =>
                h(
                  'button',
                  {
                    key: topic.topicId || topic.id,
                    type: 'button',
                    className:
                      'dshgn_chip' +
                      (activeTopic !== null && (activeTopic.topicId || activeTopic.id) === (topic.topicId || topic.id)
                        ? ' dshgn_chipOn'
                        : ''),
                    onClick: () => void pickTopic(topic),
                    title: topic.description || topic.name,
                  },
                  topic.name,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshgn_rowLine', style: { padding: '4px 10px 8px' } },
          h(
            'button',
            { type: 'button', className: 'dshgn_btn', onClick: doRecall, disabled: recalling || query.trim() === '' },
            recalling ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'search', size: 12 }),
            recallHits !== null ? `语义搜索 (${recallHits.length})` : '语义搜索',
          ),
          h(
            'button',
            { type: 'button', className: 'dshgn_btn', onClick: () => setComposing(true), disabled: busy },
            h(Icon, { name: 'plus', size: 12 }),
            t('cloud.newNote'),
          ),
          recallHits !== null
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshgn_btn',
                  onClick: () => {
                    setRecallHits(null)
                    void loadFirst()
                  },
                },
                t('action.cancel'),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dshgn_listBody' },
          loading && shown.length === 0
            ? h('div', { className: 'dshgn_empty' }, h('span', { className: 'dshgn_spin' }), h('span', null, t('cloud.loading')))
            : shown.length === 0
              ? h('div', { className: 'dshgn_empty' }, h('div', { className: 'dshgn_emptyTitle' }, t('cloud.empty')))
              : shown.map((note) =>
                  h(
                    'div',
                    {
                      key: note.noteId,
                      className: 'dshgn_card',
                      'data-on': selected !== null && selected.noteId === note.noteId ? 'true' : 'false',
                      onClick: () => void openCloudNote(note),
                      title: note.noteId,
                    },
                    h(
                      'div',
                      { className: 'dshgn_cardTitle' },
                      note.hasAudio ? h(Icon, { name: 'audio', size: 11 }) : null,
                      note.title || '(无标题)',
                    ),
                    h(
                      'div',
                      { className: 'dshgn_cardMeta' },
                      note.updatedAt || note.createdAt ? h('span', null, String(note.updatedAt || note.createdAt).slice(0, 10)) : null,
                      note.topics && note.topics[0] ? h('span', null, note.topics[0].name) : null,
                      typeof note.score === 'number' ? h('span', null, note.score.toFixed(2)) : null,
                    ),
                    note.tags.length > 0 ? h('div', { className: 'dshgn_cardExcerpt' }, note.tags.map((x) => x.name).join(' · ')) : null,
                  ),
                ),
        ),
        hasMore && recallHits === null
          ? h(
              'div',
              { style: { padding: '6px 10px 10px' } },
              h('button', { type: 'button', className: 'dshgn_btn', onClick: loadMore, disabled: loading }, loading ? h('span', { className: 'dshgn_spin' }) : null, t('cloud.loadMore')),
            )
          : null,
      )

      const readerPane = h(
        'div',
        { className: 'dshgn_note' },
        composing
          ? h(
              'div',
              { className: 'dshgn_pane' },
              h(
                'div',
                { className: 'dshgn_cardBox' },
                h(
                  'div',
                  { className: 'dshgn_sectionHead' },
                  h('span', { className: 'dshgn_sectionTitle' }, t('cloud.newNote')),
                  activeTopic !== null
                    ? h('span', { className: 'dshgn_badge' }, activeTopic.name)
                    : null,
                ),
                h(
                  'div',
                  { className: 'dshgn_field' },
                  h('span', { className: 'dshgn_fieldLabel' }, t('cloud.newNoteTitle')),
                  h('input', {
                    className: 'dshgn_input',
                    value: newTitle,
                    autoFocus: true,
                    onChange: (event) => setNewTitle(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dshgn_field' },
                  h('span', { className: 'dshgn_fieldLabel' }, t('cloud.newNoteBody')),
                  h('textarea', {
                    className: 'dshgn_textarea',
                    value: newBody,
                    onChange: (event) => setNewBody(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dshgn_rowLine' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshgn_btn dshgn_btnPri',
                      onClick: createCloudNote,
                      disabled: busy || newTitle.trim() === '',
                    },
                    busy ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'check', size: 12 }),
                    t('cloud.create'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshgn_btn',
                      onClick: () => {
                        setComposing(false)
                        setNewTitle('')
                        setNewBody('')
                      },
                      disabled: busy,
                    },
                    t('action.cancel'),
                  ),
                ),
              ),
            )
          : selected === null
          ? h('div', { className: 'dshgn_empty' }, h(Icon, { name: 'cloud', size: 26 }), h('div', { className: 'dshgn_emptyTitle' }, t('cloud.title')), h('div', { className: 'dshgn_emptyDesc' }, t('cloud.desc')))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dshgn_noteHead' },
                h('div', { className: 'dshgn_notePath' }, selected.title || selected.noteId),
                detail !== null && !editing
                  ? h(
                      React.Fragment,
                      null,
                      h('button', { type: 'button', className: 'dshgn_iconBtn', title: t('action.edit'), onClick: () => setEditing(true), disabled: busy }, h(Icon, { name: 'edit' })),
                      h('button', { type: 'button', className: 'dshgn_iconBtn', title: t('cloud.pullOne'), onClick: pullOne, disabled: busy }, h(Icon, { name: 'up' })),
                      // 把本地改动推到云端：以前只能单向「云端 → 本地」，用户在本地
                      // 改完笔记就没有任何办法把它送回云端，只能去得到大脑里重写一遍。
                      h('button', { type: 'button', className: 'dshgn_iconBtn', title: t('cloud.pushLocal'), onClick: pushLocalOne, disabled: busy }, h(Icon, { name: 'cloud' })),
                      h('button', { type: 'button', className: 'dshgn_iconBtn', title: t('cloud.deleteCloud'), onClick: deleteCloud, disabled: busy }, h(Icon, { name: 'trash' })),
                    )
                  : null,
              ),
              detailLoading
                ? h('div', { className: 'dshgn_emptyState' }, h('span', { className: 'dshgn_spin' }), h('span', { style: { marginLeft: 8 } }, t('cloud.polling')))
                : detail === null
                  ? h('div', { className: 'dshgn_emptyState' }, t('cloud.polling'))
                  : editing
                    ? h(
                        'div',
                        { className: 'dshgn_pane' },
                        h(
                          'div',
                          { className: 'dshgn_cardBox' },
                          h(
                            'div',
                            { className: 'dshgn_field' },
                            h('span', { className: 'dshgn_fieldLabel' }, t('cloud.editTitle')),
                            h('input', { className: 'dshgn_input', value: draftTitle, onChange: (e) => setDraftTitle(e.target.value) }),
                          ),
                          h(
                            'div',
                            { className: 'dshgn_field' },
                            h('span', { className: 'dshgn_fieldLabel' }, t('cloud.editBody')),
                            h('textarea', { className: 'dshgn_textarea', value: draftBody, onChange: (e) => setDraftBody(e.target.value) }),
                          ),
                          h(
                            'div',
                            { className: 'dshgn_rowLine' },
                            h('button', { type: 'button', className: 'dshgn_btn dshgn_btnPri', onClick: saveCloud, disabled: busy }, busy ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'check', size: 12 }), t('cloud.saveCloud')),
                            h('button', { type: 'button', className: 'dshgn_btn', onClick: () => setEditing(false), disabled: busy }, t('action.cancel')),
                          ),
                        ),
                      )
                    : h(
                        'div',
                        { className: 'dshgn_scroll' },
                        h(
                          'div',
                          { className: 'dshgn_md' },
                          h('h1', { className: 'dshgn_h dshgn_h1' }, detail.title || '(无标题)'),
                          detail.tags.length > 0
                            ? h(
                                'div',
                                { className: 'dshgn_rowLine', style: { gap: 6, marginBottom: 12 } },
                                detail.tags.map((tag) =>
                                  h(
                                    'span',
                                    { key: tag.name || tag.id, className: 'dshgn_tagPill' },
                                    tag.name,
                                    // 云端标签可删：用一个极小的 × 而不是整块可点，
                                    // 否则用户想选文字复制时会被误删掉标签。
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dshgn_tagX',
                                        title: t('cloud.removeTag'),
                                        disabled: busy,
                                        onClick: () => void removeCloudTag(tag),
                                      },
                                      '×',
                                    ),
                                  ),
                                ),
                              )
                            : null,
                          // 加标签：输入框 + 回车。标签是云端的一等数据，能加不能删很别扭，
                          // 所以两个动作都要有。
                          h(
                            'div',
                            { className: 'dshgn_rowLine', style: { gap: 6, marginBottom: 12 } },
                            h('input', {
                              className: 'dshgn_input',
                              style: { maxWidth: 180, height: 26 },
                              value: tagDraft,
                              placeholder: t('cloud.addTagHint'),
                              onChange: (event) => setTagDraft(event.target.value),
                              onKeyDown: (event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  const value = tagDraft
                                  setTagDraft('')
                                  void addCloudTag(value)
                                }
                              },
                            }),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dshgn_btn',
                                disabled: busy || tagDraft.trim() === '',
                                onClick: () => {
                                  const value = tagDraft
                                  setTagDraft('')
                                  void addCloudTag(value)
                                },
                              },
                              h(Icon, { name: 'plus', size: 12 }),
                              t('cloud.tags'),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dshgn_btn',
                                disabled: busy,
                                onClick: () => void shareCloud(false),
                              },
                              h(Icon, { name: 'link', size: 12 }),
                              t('cloud.shareLink'),
                            ),
                          ),
                          // 分享出来的链接直接显示出来，用户能选中复制（剪贴板可能被拒）
                          shareUrl !== null
                            ? h(
                                'div',
                                { className: 'dshgn_section', style: { marginBottom: 12 } },
                                h('div', { className: 'dshgn_sectionTitle' }, t('cloud.shareCreated')),
                                h(
                                  'div',
                                  { className: 'dshgn_rowLine', style: { gap: 6 } },
                                  h('code', { className: 'dshgn_code', style: { wordBreak: 'break-all' } }, shareUrl),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'dshgn_btn',
                                      onClick: () => {
                                        void navigator.clipboard.writeText(shareUrl).then(
                                          () => showToast(t('cloud.copied')),
                                          () => showToast(t('cloud.shareCreated')),
                                        )
                                      },
                                    },
                                    t('cloud.copyLink'),
                                  ),
                                ),
                              )
                            : null,
                          // 录音优先：用户要的就是「听原声」，所以放在正文之前
                          detail.audio.length > 0
                            ? detail.audio.map((track, index) => h(AudioPlayer, { key: `${track.url}-${index}`, t, track }))
                            : null,
                          detail.audio.length > 0 ? h('div', { style: { height: 12 } }) : null,
                          detail.moments.length > 0
                            ? h(
                                'div',
                                { className: 'dshgn_section', style: { marginTop: 12 } },
                                h('div', { className: 'dshgn_sectionTitle' }, t('cloud.moments')),
                                h(
                                  'div',
                                  null,
                                  detail.moments.map((moment, index) =>
                                    h(
                                      'div',
                                      { key: `m-${index}`, className: 'dshgn_moment' },
                                      h('span', { className: 'dshgn_momentAt' }, formatMoment(moment.startMs)),
                                      h('span', null, moment.text),
                                    ),
                                  ),
                                ),
                              )
                            : null,
                          detail.todos.length > 0
                            ? h(
                                'div',
                                { className: 'dshgn_section', style: { marginTop: 12 } },
                                h('div', { className: 'dshgn_sectionTitle' }, t('cloud.todos')),
                                h(
                                  'ul',
                                  { className: 'dshgn_mdList' },
                                  detail.todos.map((todo, index) =>
                                    h(
                                      'li',
                                      { key: `t-${index}`, className: 'dshgn_li' },
                                      h('span', { className: 'dshgn_check' + (todo.completed ? ' dshgn_checkOn' : ''), style: { marginRight: 6 } }),
                                      todo.text,
                                    ),
                                  ),
                                ),
                              )
                            : null,
                          h('div', { style: { height: 12 } }),
                          // 云端正文常常自己就以 `# 同一个标题` 开头，上面已经渲染过 h1 了，
                          // 留着就是「# 时间线」两行一样的大标题。
                          detail.content ? renderBlocks(stripLeadingHeading(detail.content, detail.title)) : null,
                          detail.hasTranscript && detail.original !== detail.content
                            ? h(
                                React.Fragment,
                                null,
                                h('h2', { className: 'dshgn_h dshgn_h2' }, t('cloud.transcript')),
                                h(TranscriptBlock, { text: detail.original }),
                              )
                            : null,
                        ),
                      ),
            ),
      )

      return h('div', { className: 'dshgn_body' }, listPane, readerPane)
    }

    /**
     * 逐字稿：中文口语长文，按「一段一句」排开，时间戳单独占一列。
     *
     * 以前直接塞进 <pre><code>，等宽字体对中文没用（全部回落成宋体），
     * white-space:pre 又不折行，长句被横向裁掉——用户看到的就是「字体太丑」。
     * 这里拆成段落：时间戳固定宽度靠左、说话人跟着、内容自动折行，
     * 段与段之间一条细分隔线，扫起来像剧本，不像日志。
     *
     * 两种来源都要吃得下：
     *   · 云端 note.original 是一行一句 `🟢 说话人1 [00:00:00] 内容`
     *   · 本地归档里的围栏是「时间戳一行、内容下一行」
     * 所以「只有时间戳没有内容」的行要把后面几行收进同一段，否则时间戳会和
     * 它的正文被拆成两个段落，读起来完全对不上。
     */
    function TranscriptBlock(props) {
      const text = String((props && props.text) || '')
      if (text.trim() === '') return null
      const entries = []
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+$/, '')
        if (line.trim() === '') continue
        const match = /^([^\[]*?)\s*\[([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\]\s*(.*)$/.exec(line)
        if (match) {
          entries.push({ speaker: match[1].trim(), stamp: match[2], body: match[3] })
          continue
        }
        const last = entries.length > 0 ? entries[entries.length - 1] : null
        if (last !== null && last.stamp !== null) {
          last.body = last.body === '' ? line : `${last.body} ${line}`
        } else {
          entries.push({ speaker: '', stamp: null, body: line })
        }
      }
      if (entries.length === 0) return null
      const children = entries.map((entry, index) =>
        h(
          'p',
          { key: `t${index}` },
          h('span', { className: 'dshgn_ts' }, entry.stamp === null ? '' : entry.stamp),
          entry.speaker === '' ? null : h('span', { className: 'dshgn_speaker' }, entry.speaker),
          entry.body,
        ),
      )
      return h('div', { className: 'dshgn_transcript' }, children)
    }

    /** 围栏里的内容看起来像不像逐字稿：至少两行带 [mm:ss] 时间戳。 */
    function looksLikeTranscript(text) {
      const hits = String(text || '').match(/^\s*[^\[]*\[[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\]/gm)
      return hits !== null && hits.length >= 2
    }

    /** 毫秒 → mm:ss，给时间轴用。 */
    function formatMoment(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }

    // ── 同步面板 ──────────────────────────────────────────────────────────────

    /**
     * 自动同步设置 + 手动触发 + 结果展示。
     *
     * 这里的原则：**默认关**。装个插件就偷偷每 15 分钟联网、吃配额，不是用户
     * 显式点的。打开之后才由 host 侧的定时器跑，关掉时把定时器停掉。
     */
    /**
     * 回收站。
     *
     * 删除笔记一直是「移进 .trash/」，但以前面板上没有任何入口能看见它、更没法恢复——
     * 用户点错删除就只剩下去文件管理器里翻 `.trash` 这一条路。这里把回收站摆出来，
     * 恢复就是把文件搬回库里，清空才是真删。
     */
    function TrashPane(props) {
      const { t, status, onChanged, onError, showToast } = props
      const [items, setItems] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const result = await api('/trash/list')
          setItems(Array.isArray(result.items) ? result.items : [])
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setLoading(false)
        }
      }, [onError])

      React.useEffect(() => {
        void load()
      }, [load])

      const restore = React.useCallback(
        async (item) => {
          setBusy(true)
          try {
            const result = await api('/trash/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: item.path }),
            })
            showToast(`${t('trash.restored')}${result && result.path ? '：' + result.path : ''}`)
            await load()
            if (typeof onChanged === 'function') await onChanged()
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [load, onChanged, onError, showToast, t],
      )

      const purgeOne = React.useCallback(
        async (item) => {
          if (!window.confirm(t('trash.purgeOneConfirm'))) return
          setBusy(true)
          try {
            await api('/trash/purge', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: item.path }),
            })
            showToast(t('trash.purged'))
            await load()
            if (typeof onChanged === 'function') await onChanged()
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [load, onChanged, onError, showToast, t],
      )

      const purgeAll = React.useCallback(async () => {
        if (!window.confirm(t('trash.purgeConfirm'))) return
        setBusy(true)
        try {
          await api('/trash/purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          showToast(t('trash.purged'))
          await load()
          if (typeof onChanged === 'function') await onChanged()
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [load, onChanged, onError, showToast, t])

      const list = items === null ? [] : items

      return h(
        'div',
        { className: 'dshgn_pane' },
        h(
          'div',
          { className: 'dshgn_section' },
          h(
            'div',
            { className: 'dshgn_sectionHead' },
            h('div', { className: 'dshgn_sectionTitle' }, t('tab.trash')),
            h(
              'div',
              { className: 'dshgn_rowLine', style: { gap: 6 } },
              h(
                'button',
                { type: 'button', className: 'dshgn_btn', onClick: () => void load(), disabled: loading || busy },
                loading ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'refresh', size: 12 }),
                t('action.refresh'),
              ),
              h(
                'button',
                { type: 'button', className: 'dshgn_btn dshgn_btnDanger', onClick: purgeAll, disabled: busy || list.length === 0 },
                h(Icon, { name: 'trash', size: 12 }),
                t('trash.purgeAll'),
              ),
            ),
          ),
          h('div', { className: 'dshgn_sectionDesc' }, t('trash.desc')),
        ),
        loading && list.length === 0
          ? h('div', { className: 'dshgn_emptyState' }, h('span', { className: 'dshgn_spin' }))
          : list.length === 0
            ? h(
                'div',
                { className: 'dshgn_empty' },
                h(Icon, { name: 'trash', size: 24 }),
                h('div', { className: 'dshgn_emptyTitle' }, t('trash.empty')),
                h('div', { className: 'dshgn_emptyDesc' }, t('trash.emptyHint')),
              )
            : h(
                'div',
                { className: 'dshgn_cardBox' },
                list.map((item) =>
                  h(
                    'div',
                    { key: item.path, className: 'dshgn_rowLine', style: { justifyContent: 'space-between', padding: '7px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l1)' } },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h('div', { className: 'dshgn_cardTitle', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.originalName),
                      h(
                        'div',
                        { className: 'dshgn_cardMeta' },
                        `${t('trash.deletedAt')} ${formatTime(item.trashedAt)} · ${formatBytes(item.bytes)}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dshgn_rowLine', style: { gap: 6, flex: 'none' } },
                      h(
                        'button',
                        { type: 'button', className: 'dshgn_btn dshgn_btnPri', onClick: () => void restore(item), disabled: busy },
                        h(Icon, { name: 'up', size: 12 }),
                        t('trash.restore'),
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'dshgn_btn dshgn_btnDanger', onClick: () => void purgeOne(item), disabled: busy },
                        t('trash.purgeOne'),
                      ),
                    ),
                  ),
                ),
              ),
      )
    }

    function SyncPane(props) {
      const { t, status, onChanged, onError, showToast } = props
      const configured = status !== null && status.api !== undefined && status.api.configured === true
      const auto = status !== null && status.autoSync ? status.autoSync : { enabled: false, minutes: 15, incremental: true }

      const [enabled, setEnabled] = React.useState(auto.enabled === true)
      const [minutes, setMinutes] = React.useState(auto.minutes || 15)
      const [incremental, setIncremental] = React.useState(auto.incremental !== false)
      const [fullScan, setFullScan] = React.useState(false)
      const [running, setRunning] = React.useState(auto.running === true)
      const [lastResult, setLastResult] = React.useState(auto.lastResult || null)
      const [lastError, setLastError] = React.useState(auto.lastError || null)
      const [busy, setBusy] = React.useState(false)

      // 同步是一个后台任务：开跑之后轮询到结束，用户就不用自己刷新
      React.useEffect(() => {
        if (!running) return undefined
        const timer = window.setInterval(async () => {
          try {
            const state = await api('/sync/status')
            if (state.running !== true) {
              setRunning(false)
              setLastResult(state.lastResult || null)
              setLastError(state.lastError || null)
              if (typeof onChanged === 'function') await onChanged()
            }
          } catch {
            // 轮询失败就等下一轮，不要因为一次网络抖动就把界面报错
          }
        }, 1200)
        return () => window.clearInterval(timer)
      }, [running, onChanged])

      const persist = React.useCallback(
        async (next) => {
          try {
            await api('/sync/auto', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(next),
            })
            if (typeof onChanged === 'function') await onChanged()
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          }
        },
        [onChanged, onError],
      )

      const toggle = React.useCallback(() => {
        const next = !enabled
        setEnabled(next)
        void persist({ enabled: next, minutes, incremental })
        showToast(next ? `${t('sync.enabled')} · ${minutes}${t('sync.minutes')}` : t('sync.enabled'))
      }, [enabled, minutes, incremental, persist, showToast, t])

      const changeMinutes = React.useCallback(
        (value) => {
          const parsed = Number(value)
          if (!Number.isFinite(parsed)) return
          const clamped = Math.min(Math.max(Math.round(parsed), 5), 720)
          setMinutes(clamped)
          if (enabled) void persist({ enabled: true, minutes: clamped, incremental })
        },
        [enabled, incremental, persist],
      )

      const runNow = React.useCallback(async () => {
        setBusy(true)
        setLastError(null)
        try {
          await api('/sync/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ full: fullScan }),
          })
          setRunning(true)
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [fullScan, onError])

      const resultStats = lastResult
        ? [
            { label: t('sync.pulled'), num: lastResult.pulled ?? 0 },
            { label: t('sync.skipped'), num: lastResult.skipped ?? 0 },
            { label: t('sync.adopted'), num: lastResult.adopted ?? 0 },
            { label: t('sync.conflicts'), num: lastResult.conflicts ?? 0 },
            { label: t('sync.deleted'), num: lastResult.deleted ?? 0 },
            { label: t('sync.errors'), num: lastResult.errors ?? 0 },
          ]
        : []

      return h(
        'div',
        { className: 'dshgn_pane' },
        h(
          'div',
          { className: 'dshgn_cardBox' },
          h(
            'div',
            { className: 'dshgn_section' },
            h('div', { className: 'dshgn_sectionTitle' }, t('sync.title')),
            h('div', { className: 'dshgn_sectionDesc' }, t('sync.desc')),
            h(
              'div',
              { className: 'dshgn_toggleRow' },
              h(
                'div',
                { className: 'dshgn_toggleLabel' },
                h('span', { className: 'dshgn_toggleTitle' }, t('sync.enabled')),
                h(
                  'span',
                  { className: 'dshgn_toggleDesc' },
                  status !== null && status.api && status.api.lastRunAt ? `${t('sync.lastRun')}: ${formatTime(status.api.lastRunAt)}` : `${t('sync.lastRun')}: ${t('sync.never')}`,
                ),
              ),
              h('button', {
                type: 'button',
                className: 'dshgn_toggle',
                'data-on': enabled ? 'true' : 'false',
                onClick: toggle,
                disabled: !configured,
                'aria-label': t('sync.enabled'),
              }),
            ),
            h(
              'div',
              { className: 'dshgn_rowLine' },
              h('span', { className: 'dshgn_fieldLabel' }, t('sync.interval')),
              h('input', {
                className: 'dshgn_input',
                style: { flex: 'none', width: 76 },
                type: 'number',
                min: 5,
                max: 720,
                step: 5,
                value: minutes,
                onChange: (e) => changeMinutes(e.target.value),
                disabled: !configured,
              }),
              h('span', { className: 'dshgn_fieldHint' }, t('sync.minutes')),
              [5, 15, 60].map((preset) =>
                h(
                  'button',
                  {
                    key: preset,
                    type: 'button',
                    className: 'dshgn_chip' + (minutes === preset ? ' dshgn_chipOn' : ''),
                    onClick: () => changeMinutes(preset),
                    disabled: !configured,
                  },
                  `${preset}${t('sync.minutes')}`,
                ),
              ),
            ),
            h(
              'label',
              { className: 'dshgn_rowLine', style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
              h('input', {
                type: 'checkbox',
                checked: incremental,
                onChange: (e) => {
                  setIncremental(e.target.checked)
                  void persist({ enabled, minutes, incremental: e.target.checked })
                },
                disabled: !configured,
              }),
              t('sync.incremental'),
            ),
            h('div', { className: 'dshgn_fieldHint' }, t('sync.quotaHint')),
          ),
          h(
            'div',
            { className: 'dshgn_section' },
            h(
              'div',
              { className: 'dshgn_rowLine' },
              h('button', { type: 'button', className: 'dshgn_btn dshgn_btnPri', onClick: runNow, disabled: busy || running || !configured }, running ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'sync', size: 12 }), running ? t('sync.running') : t('sync.now')),
              h(
                'label',
                { className: 'dshgn_rowLine', style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
                h('input', { type: 'checkbox', checked: fullScan, onChange: (e) => setFullScan(e.target.checked), disabled: !configured }),
                t('sync.fullScan'),
              ),
            ),
            !configured ? h('div', { className: 'dshgn_fieldHint' }, t('cloud.notConfiguredDesc')) : null,
            lastError !== null ? h('div', { className: 'dshgn_error' }, lastError) : null,
            resultStats.length > 0 ? h('div', { className: 'dshgn_statGrid' }, resultStats.map((s) => h('div', { key: s.label, className: 'dshgn_stat' }, h('span', { className: 'dshgn_statNum' }, String(s.num)), h('span', { className: 'dshgn_statLabel' }, s.label)))) : null,
            lastResult !== null && lastResult.at ? h('div', { className: 'dshgn_fieldHint' }, `${t('sync.result')}: ${formatTime(lastResult.at)}`) : null,
          ),
          h(LegacyImport),
        ),
      )

      /** 旧的一次性导入：只在没配 API Key 时作为兜底暴露出来。 */
      function LegacyImport() {
        const [open, setOpen] = React.useState(false)
        if (configured || !open) {
          return h(
            'div',
            { className: 'dshgn_rowLine', style: { justifyContent: 'center' } },
            h('button', { type: 'button', className: 'dshgn_btn', onClick: () => setOpen(true) }, t('sync.legacy')),
            h('span', { className: 'dshgn_fieldHint' }, t('sync.legacyHint')),
          )
        }
        return h(ImportPane, {
          t,
          status,
          onRefresh: async () => {
            if (typeof onChanged === 'function') await onChanged()
          },
          onDone: () => {
            if (typeof onChanged === 'function') void onChanged()
          },
        })
      }
    }


    function TreePane(props) {
      const { t, tree, dirs, entries, activeDir, activeTag, tagCounts, onPickDir, onPickTag } = props
      const total = Array.isArray(entries) ? entries.length : 0

      // 扁平化目录树（缩进按层级），比折叠树更适合窄侧栏：一屏看全库结构
      const flat = React.useMemo(() => {
        const list = []
        const walk = (node, depth) => {
          for (const child of node.children || []) {
            if (child.kind !== 'dir') continue
            list.push({ path: child.path, name: child.name, depth, count: child.count })
            walk(child, depth + 1)
          }
        }
        if (tree) walk(tree, 0)
        // 兜底：树为空但条目有目录（扫描被截断时）
        if (list.length === 0 && Array.isArray(dirs)) {
          for (const dir of dirs) {
            if (dir === '') continue
            list.push({ path: dir, name: dir, depth: 0, count: entries.filter((e) => e.path.startsWith(`${dir}/`)).length })
          }
        }
        return list
      }, [tree, dirs, entries])

      return h(
        'aside',
        { className: 'dshgn_tree' },
        h(
          'div',
          { className: 'dshgn_treeRow', 'data-on': activeDir === '' && activeTag === '' ? 'true' : 'false', onClick: () => onPickDir('') },
          h(Icon, { name: 'brain', size: 14 }),
          h('span', { className: 'dshgn_treeName' }, t('tree.all')),
          h('span', { className: 'dshgn_treeCount' }, String(total)),
        ),
        flat.length > 0 ? h('div', { className: 'dshgn_treeHead' }, h('span', null, t('tree.dirs'))) : null,
        flat.map((node) =>
          h(
            'div',
            {
              key: node.path,
              className: 'dshgn_treeRow',
              'data-on': activeDir === node.path ? 'true' : 'false',
              style: { paddingLeft: `${7 + node.depth * 11}px` },
              onClick: () => onPickDir(node.path),
              title: node.path,
            },
            h(Icon, { name: 'folder', size: 13 }),
            h('span', { className: 'dshgn_treeName' }, node.name),
            h('span', { className: 'dshgn_treeCount' }, String(node.count)),
          ),
        ),
        tagCounts.length > 0 ? h('div', { className: 'dshgn_treeHead' }, h('span', null, t('tree.tags'))) : null,
        tagCounts.length > 0
          ? h(
              'div',
              { className: 'dshgn_treeTags' },
              tagCounts.map(([tag, count]) =>
                h(
                  'button',
                  {
                    key: tag,
                    type: 'button',
                    className: 'dshgn_tagRow',
                    'data-on': activeTag === tag ? 'true' : 'false',
                    onClick: () => onPickTag(activeTag === tag ? '' : tag),
                  },
                  `${tag} ${count}`,
                ),
              ),
            )
          : null,
      )
    }

    // ── 阅读 / 编辑 ───────────────────────────────────────────────────────────

    function NotePane(props) {
      const { t, status, current, draft, setDraft, dirty, busy, onSave, onDelete, onCopyReference, onOpenWikiLink } = props
      const [editing, setEditing] = React.useState(false)

      React.useEffect(() => {
        // 换笔记时退出编辑态：留着编辑态会让用户以为新笔记也是可编辑草稿
        setEditing(false)
      }, [current !== null ? current.path : null])

      if (current === null) {
        return h(
          'section',
          { className: 'dshgn_note' },
          h(
            'div',
            { className: 'dshgn_empty' },
            h(Icon, { name: 'brain', size: 26 }),
            h('div', { className: 'dshgn_emptyTitle' }, t('empty.select')),
            h('div', { className: 'dshgn_emptyDesc' }, t('empty.selectDesc')),
          ),
        )
      }

      const absolute = status !== null ? `${status.vaultRoot}/${current.path}` : current.path

      return h(
        'section',
        { className: 'dshgn_note' },
        h(
          'div',
          { className: 'dshgn_noteHead' },
          h('div', { className: 'dshgn_notePath', title: absolute }, current.path),
          dirty ? h('span', { className: 'dshgn_badge' }, t('note.unsaved')) : null,
          editing
            ? h(
                React.Fragment,
                null,
                h(
                  'button',
                  { type: 'button', className: 'dshgn_btn dshgn_btnPrimary', onClick: onSave, disabled: busy || !dirty },
                  h(Icon, { name: 'check', size: 13 }),
                  t('action.save'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshgn_btn', onClick: () => { setDraft(current.content); setEditing(false) }, disabled: busy },
                  t('action.cancel'),
                ),
              )
            : h(
                React.Fragment,
                null,
                h(
                  'button',
                  { type: 'button', className: 'dshgn_iconBtn', title: t('action.edit'), onClick: () => setEditing(true) },
                  h(Icon, { name: 'edit', size: 15 }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshgn_iconBtn', title: t('action.copyRef'), onClick: onCopyReference },
                  h(Icon, { name: 'link', size: 15 }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshgn_iconBtn', title: t('action.delete'), onClick: onDelete, disabled: busy },
                  h(Icon, { name: 'trash', size: 15 }),
                ),
              ),
        ),
        editing
          ? h('textarea', {
              className: 'dshgn_editor',
              value: draft === null ? '' : draft,
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
            })
          : h(
              'div',
              { className: 'dshgn_scroll' },
              // 附件里的录音直接放播放器：合并两套体系时把这些 mp3 搬进来了，
              // 如果只留 markdown 里那条外链，用户还得跳浏览器才能听。
              (current.assets || [])
                .filter((asset) => asset.kind === 'audio')
                .map((asset, index) =>
                  h(AudioPlayer, {
                    key: `${asset.path}-${index}`,
                    t,
                    track: {
                      url: `/getnote/asset?path=${encodeURIComponent(asset.path)}`,
                      duration: 0,
                      kind: 'local',
                      title: assetLabel(asset.name),
                    },
                  }),
                ),
              // 附件里的图片也画出来。以前只筛 audio，`kind:'image'` 的附件在面板里
              // 完全看不见——用户明明存了图，却以为没同步下来。
              (current.assets || []).some((asset) => asset.kind === 'image')
                ? h(
                    'div',
                    { className: 'dshgn_imgRow' },
                    (current.assets || [])
                      .filter((asset) => asset.kind === 'image')
                      .map((asset, index) =>
                        h('img', {
                          key: `${asset.path}-${index}`,
                          className: 'dshgn_img',
                          src: `/getnote/asset?path=${encodeURIComponent(asset.path)}`,
                          alt: asset.name,
                          title: asset.name,
                          loading: 'lazy',
                        }),
                      ),
                  )
                : null,
              // 阅读时只渲染正文：`content` 带 YAML frontmatter，直接 renderBlocks 会把
              // `title: xxx` / `note_id: "..."` 当成正文段落一条条铺出来。编辑时仍用
              // `content`，这样保存不会把 frontmatter 丢掉。
              h(
                'div',
                { className: 'dshgn_md' },
                renderBlocks(
                  current.body !== undefined && current.body !== null ? current.body : current.content,
                  { assets: current.assets || [], onOpenWikiLink },
                ),
              ),
            ),
      )
    }

    // ── 导入 ──────────────────────────────────────────────────────────────────

    function ImportPane(props) {
      const { t, status, onRefresh, onDone } = props
      const [state, setState] = React.useState(null)
      const [authUrl, setAuthUrl] = React.useState(null)
      const [waiting, setWaiting] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const loadStatus = React.useCallback(async () => {
        try {
          const json = await api('/import/status')
          setState(json)
          return json
        } catch {
          return null
        }
      }, [])

      React.useEffect(() => {
        void loadStatus()
      }, [loadStatus])

      // 导入在 host 侧跑，面板这边轮询进度（关掉面板也不影响它继续）
      const running = state !== null && state.running === true
      React.useEffect(() => {
        if (!running) return undefined
        const timer = window.setInterval(() => {
          void loadStatus().then((json) => {
            if (json && json.running === false) onDone()
          })
        }, 900)
        return () => window.clearInterval(timer)
      }, [running, loadStatus, onDone])

      const loggedIn = status !== null && status.cloud !== null && status.cloud.loggedIn === true

      const startLogin = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const json = await api('/oauth/start', { method: 'POST' })
          setAuthUrl(json.url)
          setWaiting(true)
          // 桌面版里 window.open 可能被拦：不依赖它的返回值，面板上始终给可点的链接
          try {
            window.open(json.url, '_blank', 'noopener,width=520,height=760')
          } catch {
            // 拦截了也没关系，下面有手动链接
          }
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [])

      // 等待授权回跳：每 2 秒看一次 host 有没有拿到令牌
      React.useEffect(() => {
        if (!waiting) return undefined
        const timer = window.setInterval(async () => {
          try {
            const json = await api('/oauth/status')
            if (json && json.loggedIn === true) {
              setWaiting(false)
              setAuthUrl(null)
              await onRefresh()
            }
          } catch {
            // 授权未完成：继续等
          }
        }, 2000)
        return () => window.clearInterval(timer)
      }, [waiting, onRefresh])

      const startImport = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const json = await api('/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          if (json && json.ok === false) setError(json.error || 'import failed')
          setState((previous) => ({ ...(previous || {}), running: json.ok === true }))
          await loadStatus()
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [loadStatus])

      const logout = React.useCallback(async () => {
        setBusy(true)
        try {
          await api('/logout', { method: 'POST' })
          await onRefresh()
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [onRefresh])

      const lines = state !== null && Array.isArray(state.lines) ? state.lines : []
      const result = state !== null ? state.result : null

      return h(
        'div',
        { className: 'dshgn_pane' },
        h(
          'div',
          { className: 'dshgn_cardBox' },
          h(
            'div',
            { className: 'dshgn_section' },
            h('div', { className: 'dshgn_sectionTitle' }, t('import.title')),
            h('div', { className: 'dshgn_sectionDesc' }, t('import.desc')),
            h(
              'div',
              { className: 'dshgn_rowLine' },
              h(
                'span',
                { className: loggedIn ? 'dshgn_badge dshgn_badgeOk' : 'dshgn_badge' },
                h(Icon, { name: 'cloud', size: 11 }),
                loggedIn ? t('import.loggedIn') : t('import.notLoggedIn'),
              ),
              status !== null && status.lastSyncAt
                ? h('span', { className: 'dshgn_badge' }, `${t('import.lastSync')}: ${formatTime(status.lastSyncAt)}`)
                : h('span', { className: 'dshgn_badge' }, `${t('import.lastSync')}: ${t('import.never')}`),
              status !== null && status.notes > 0 ? h('span', { className: 'dshgn_badge' }, `${status.notes} ${t('meta.notes')}`) : null,
            ),
            h(
              'div',
              { className: 'dshgn_rowLine' },
              loggedIn
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'button',
                      { type: 'button', className: 'dshgn_btn dshgn_btnPrimary', onClick: startImport, disabled: busy || running },
                      running ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'cloud', size: 13 }),
                      running ? t('import.running') : t('import.start'),
                    ),
                    h('button', { type: 'button', className: 'dshgn_btn', onClick: logout, disabled: busy || running }, t('import.logout')),
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      'button',
                      { type: 'button', className: 'dshgn_btn dshgn_btnPrimary', onClick: startLogin, disabled: busy },
                      h(Icon, { name: 'cloud', size: 13 }),
                      t('import.login'),
                    ),
                    h('span', { className: 'dshgn_sectionDesc' }, t('import.loginHint')),
                  ),
            ),
            !loggedIn ? h('div', { className: 'dshgn_sectionDesc' }, t('import.cloudHint')) : null,
            authUrl !== null
              ? h(
                  'div',
                  { className: 'dshgn_sectionDesc' },
                  waiting ? `${t('import.authorizeWait')} ` : '',
                  h('a', { className: 'dshgn_link', href: authUrl, target: '_blank', rel: 'noreferrer noopener' }, t('import.openLink')),
                )
              : null,
          ),
          error !== null ? h('div', { className: 'dshgn_error', role: 'alert' }, error) : null,
          result !== null
            ? h(
                'div',
                { className: 'dshgn_section' },
                h('div', { className: 'dshgn_sectionTitle' }, t('import.result')),
                h(
                  'div',
                  { className: 'dshgn_rowLine' },
                  h('span', { className: 'dshgn_badge dshgn_badgeOk' }, `${t('import.newNotes')} ${result.created}`),
                  h('span', { className: 'dshgn_badge' }, `${t('import.skipped')} ${result.skipped}`),
                  h('span', { className: 'dshgn_badge' }, `${t('import.failed')} ${result.failed}`),
                  h('span', { className: 'dshgn_badge' }, `${Math.round((result.durationMs || 0) / 1000)}s`),
                ),
                h('div', { className: 'dshgn_sectionDesc' }, result.root),
              )
            : null,
          lines.length > 0
            ? h('div', { className: 'dshgn_log' }, lines.map((line, index) => h('div', { key: index }, `${formatTime(line.at)}  ${line.text}`)))
            : null,
        ),
      )
    }

    // ── 设置 ──────────────────────────────────────────────────────────────────

    function SettingsPane(props) {
      const { t, status, onSaved, onError } = props
      const [input, setInput] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [touched, setTouched] = React.useState(false)

      React.useEffect(() => {
        if (!touched && status !== null) setInput(status.settingsPath ? status.vaultRoot || '' : '')
      }, [status, touched])

      const save = React.useCallback(
        async (path) => {
          setBusy(true)
          try {
            await api('/settings', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ vaultPath: path }),
            })
            setTouched(false)
            await onSaved(t('settings.saved'))
          } catch (err) {
            onError(err && err.message ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
        [onError, onSaved, t],
      )

      const suggestions = status !== null && Array.isArray(status.suggestions) ? status.suggestions : []
      const cloudApi = status !== null && status.api ? status.api : null
      // 登录态三态：没有 auth.json / 有但过期 / 有效。只看 loggedIn 会把
      // 「过期了但文件还在」误报成已登录。
      const loginState =
        status === null || status.cloud === null || status.cloud.loggedIn !== true
          ? 'none'
          : status.cloud.expired === true
            ? 'expired'
            : 'ok'

      return h(
        'div',
        { className: 'dshgn_pane' },
        h(
          'div',
          { className: 'dshgn_cardBox' },
          h(
            'div',
            { className: 'dshgn_section' },
            h('div', { className: 'dshgn_sectionTitle' }, t('settings.vault')),
            h('div', { className: 'dshgn_sectionDesc' }, t('settings.vaultHint')),
            h(
              'div',
              { className: 'dshgn_rowLine' },
              h('input', {
                className: 'dshgn_input',
                value: input,
                spellCheck: false,
                placeholder: status !== null ? status.vaultRoot : '',
                onChange: (event) => {
                  setTouched(true)
                  setInput(event.target.value)
                },
              }),
              h('button', { type: 'button', className: 'dshgn_btn dshgn_btnPrimary', onClick: () => save(input), disabled: busy }, t('settings.save')),
            ),
            status !== null && status.vaultMissing ? h('div', { className: 'dshgn_error' }, `✕ ${status.vaultMissing}`) : null,
            status !== null ? h('div', { className: 'dshgn_sectionDesc' }, `${status.notes} ${t('meta.notes')} · ${status.dirs} ${t('meta.dirs')} · ${formatBytes(status.bytes)}`) : null,
          ),
          suggestions.length > 0
            ? h(
                'div',
                { className: 'dshgn_section' },
                h('div', { className: 'dshgn_sectionTitle' }, t('settings.suggest')),
                suggestions.map((item) =>
                  h(
                    'div',
                    { key: item.path, className: 'dshgn_rowLine' },
                    h('div', { className: 'dshgn_sectionDesc', style: { flex: 1, minWidth: 0, wordBreak: 'break-all' } }, `${item.path} — ${item.notes} ${t('meta.notes')}`),
                    h('button', { type: 'button', className: 'dshgn_btn', onClick: () => save(item.path), disabled: busy }, t('settings.use')),
                  ),
                ),
              )
            : null,
          h(CloudCredCard, { t, api: cloudApi, onSaved, onError }),
          h(
            'div',
            { className: 'dshgn_section' },
            h(
              'div',
              { className: 'dshgn_sectionHead' },
              h('div', { className: 'dshgn_sectionTitle' }, t('settings.authFile')),
              h(
                'span',
                {
                  // auth.json 存在只说明「登录过」，令牌过期后它还在文件里。
                  // 这时仍显示「已登录」会骗人：用户以为登录有效，其实云端操作
                  // 走的是 API Key 那条通道。所以按 expiresAt 分三态。
                  className:
                    'dshgn_badge' +
                    (loginState === 'ok' ? ' dshgn_badgeOk' : loginState === 'expired' ? ' dshgn_badgeWarn' : ''),
                },
                loginState === 'ok'
                  ? t('settings.loggedIn')
                  : loginState === 'expired'
                    ? t('settings.loginExpired')
                    : t('settings.loggedOut'),
              ),
            ),
            h('div', { className: 'dshgn_sectionDesc' }, status !== null ? status.authPath : ''),
            h('div', { className: 'dshgn_sectionDesc' }, t('settings.storeHint')),
          ),
        ),
      )
    }

    // ── 云端凭证卡片 ──────────────────────────────────────────────────────────

    /**
     * 填 API Key / Client ID 的卡片。
     *
     * 两个安全点：
     *   1. 保存后输入框立刻清空，只显示打码值 —— 不要在 DOM 里留着明文 Key，
     *      截图、录屏、共享屏幕都会漏。
     *   2. 「只写不回」：host 侧 `/api/credentials` 的响应里永远不含明文，
     *      这样即便前端被 XSS 也偷不到。
     */
    function CloudCredCard(props) {
      const { t, api: apiInfo, onSaved, onError } = props
      const configured = apiInfo !== null && apiInfo.configured === true

      const [apiKey, setApiKey] = React.useState('')
      const [clientId, setClientId] = React.useState('')
      const [grantId, setGrantId] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [testing, setTesting] = React.useState(false)
      const [probe, setProbe] = React.useState(null)

      const save = React.useCallback(async () => {
        if (apiKey.trim() === '' || clientId.trim() === '') {
          onError(t('api.needKey'))
          return
        }
        setBusy(true)
        setProbe(null)
        try {
          await api('/api/credentials', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: apiKey.trim(), clientId: clientId.trim(), grantId: grantId.trim() }),
          })
          // 立刻清空输入框，界面上只留打码值
          setApiKey('')
          setClientId('')
          setGrantId('')
          await onSaved(t('api.saved'))
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [apiKey, clientId, grantId, onSaved, onError, t])

      const test = React.useCallback(async () => {
        setTesting(true)
        setProbe(null)
        try {
          const result = await api('/api/probe')
          setProbe({ ok: true, text: `${t('api.ok')}${result.total !== undefined ? ` · ${result.total}` : ''}` })
        } catch (err) {
          setProbe({ ok: false, text: err && err.message ? err.message : String(err) })
          onError(err && err.message ? err.message : String(err))
        } finally {
          setTesting(false)
        }
      }, [onError, t])

      const clear = React.useCallback(async () => {
        if (!window.confirm(t('api.clear'))) return
        setBusy(true)
        setProbe(null)
        try {
          await api('/api/clear', { method: 'POST' })
          await onSaved(t('api.cleared'))
        } catch (err) {
          onError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [onSaved, onError, t])

      return h(
        'div',
        { className: 'dshgn_section' },
        h(
          'div',
          { className: 'dshgn_rowLine' },
          h('div', { className: 'dshgn_sectionTitle' }, t('api.title')),
          h('span', { className: 'dshgn_badge' + (configured ? ' dshgn_badgeOk' : '') }, configured ? t('api.ready') : t('api.notReady')),
          configured && apiInfo.apiKeyMasked ? h('span', { className: 'dshgn_treeCount' }, `${apiInfo.apiKeyMasked} · ${apiInfo.clientIdMasked || ''}`) : null,
        ),
        h('div', { className: 'dshgn_sectionDesc' }, t('api.desc')),
        // Key 被服务端拒过：这条必须显眼。用户填完 Key 看到「已接入」，然后云端每个
        // 操作都失败，却不知道为什么——那是这个插件最糟的体验。
        apiInfo !== null && apiInfo.keyRejected === true
          ? h(
              'div',
              { className: 'dshgn_banner dshgn_bannerWarn' },
              h('div', { className: 'dshgn_bannerTitle' }, t('api.keyRejected')),
              h('div', { className: 'dshgn_bannerDesc' }, apiInfo.keyError || ''),
              apiInfo.fallbackAvailable === true
                ? h('div', { className: 'dshgn_bannerDesc' }, t('api.usingFallback'))
                : null,
            )
          : null,
        // 走的是登录通道（不是 Key）：说明清楚，省得用户以为 Key 没存住
        apiInfo !== null && apiInfo.effectiveTransport === 'mcp' && apiInfo.keyRejected !== true
          ? h('div', { className: 'dshgn_fieldHint' }, t('api.viaLogin'))
          : null,
        h(
          'div',
          { className: 'dshgn_field' },
          h('span', { className: 'dshgn_fieldLabel' }, t('api.apiKey')),
          h('input', {
            className: 'dshgn_input',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            value: apiKey,
            placeholder: configured ? '••••••••（已保存，重新填可替换）' : t('api.keyPlaceholder'),
            onChange: (event) => setApiKey(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dshgn_field' },
          h('span', { className: 'dshgn_fieldLabel' }, t('api.clientId')),
          h('input', {
            className: 'dshgn_input',
            spellCheck: false,
            value: clientId,
            placeholder: configured ? '••••••••（已保存，重新填可替换）' : t('api.idPlaceholder'),
            onChange: (event) => setClientId(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dshgn_field' },
          h('span', { className: 'dshgn_fieldLabel' }, t('api.grantId')),
          h('input', {
            className: 'dshgn_input',
            spellCheck: false,
            value: grantId,
            placeholder: configured && apiInfo.hasGrantId ? '••••••••' : t('api.grantPlaceholder'),
            onChange: (event) => setGrantId(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dshgn_rowLine' },
          h('button', { type: 'button', className: 'dshgn_btn dshgn_btnPrimary', onClick: save, disabled: busy }, busy ? h('span', { className: 'dshgn_spin' }) : h(Icon, { name: 'check', size: 12 }), t('api.save')),
          configured ? h('button', { type: 'button', className: 'dshgn_btn', onClick: test, disabled: testing }, testing ? h('span', { className: 'dshgn_spin' }) : null, testing ? t('api.testing') : t('api.test')) : null,
          configured ? h('button', { type: 'button', className: 'dshgn_btn dshgn_btnDanger', onClick: clear, disabled: busy }, t('api.clear')) : null,
        ),
        probe !== null ? h('div', { className: probe.ok ? 'dshgn_fieldHint' : 'dshgn_error', style: probe.ok ? { color: 'var(--dsw-alias-state-success-primary)' } : undefined }, `${probe.ok ? '✓' : '✕'} ${probe.text}`) : null,
        h('div', { className: 'dshgn_fieldHint' }, t('api.consoleHint')),
        h('div', { className: 'dshgn_fieldHint' }, t('api.neverEcho')),
        apiInfo !== null && apiInfo.credentialsPath ? h('div', { className: 'dshgn_fieldHint' }, `${t('api.file')}: ${apiInfo.credentialsPath}`) : null,
      )
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────────

    const inject = ['slots', 'locale']

    function apply(ctx) {
      setLocaleCtx(ctx)
      const disposeCss = injectCss()
      ctx.effect(() => disposeCss, 'dsh-getnote: panel styles')

      const t = getT()
      ctx.effect(
        () => {
          if (!ctx.locale || typeof ctx.locale.register !== 'function') return () => {}
          return ctx.locale.register(NS, LEX)
        },
        'dsh-getnote: locale dictionaries',
      )

      // 中央面板：key 与侧栏入口的 id 必须一致，侧栏点按钮时 main 才能被选中
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, GetnotePage),
      )

      // 左侧栏入口：id 与上面的 key 对应；label 跟着语言走
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => t('panel.title'),
            locale: NS,
          },
          PanelIcon,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // 渲染器没有 React 也能跑，导出给 test/client.test.mjs 直接验 Markdown 结构；
    // 宿主只读 apply/inject，这个字段对运行时无影响。
    exports.__internals = {
      renderBlocks,
      renderInline,
      stripLeadingHeading,
      LEX,
      ICONS,
      AudioPlayer,
      CloudPane,
      SyncPane,
      CloudCredCard,
      SettingsPane,
      GetnotePage,
      NotePane,
      TranscriptBlock,
      looksLikeTranscript,
      formatMoment,
      TrashPane,
      renderEmbed,
      assetLabel,
    }
    return module.exports
  },
})
