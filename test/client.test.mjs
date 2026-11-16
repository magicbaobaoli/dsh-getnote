/**
 * 客户端产物冒烟测试。
 *
 * lib/client.js 不是普通 ES 模块，而是一个 `window.__ModuleLoader__.load` 工厂 ——
 * 由宿主的模块表加载，React 也从模块表拿。本地没有 react 可以 require，
 * 所以这里用 vm 造一个最小沙箱 + 一个够用的 React 桩，验证：
 *   1. 文件能被当成脚本求值（语法/顶层引用没问题）
 *   2. id 是包名，工厂返回带 apply/inject 的 exports
 *   3. apply() 真的往两个 slot 注册了东西，且 id/key 对得上（错一个就没有左侧栏入口）
 *   4. 主面板能渲染出第一屏而不抛异常
 */
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── 最小 React 桩 ────────────────────────────────────────────────────────────
// 只实现本插件用到的接口。hooks 不跑副作用：useEffect 直接跳过，
// 面板因此停在校验期（不发起 fetch），正好用来测「首屏能画出来」。
const Fragment = Symbol('Fragment')
const React = {
  Fragment,
  createElement(type, props, ...children) {
    const flat = children.length === 1 ? children[0] : children
    return { type, props: props || {}, children: flat }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial === undefined ? null : initial }
  },
  useEffect() {
    return undefined
  },
  // 错误边界必须是 class 组件（React 只允许 class 声明 getDerivedStateFromError），
  // 所以桩必须提供 Component，否则 client.js 会走它的兜底替身、测不到真实路径。
  Component: class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
  },
}
const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return { jsx: {}, jsxs: {}, Fragment }
  throw new Error(`unexpected require: ${name}`)
}

// ── 沙箱 ────────────────────────────────────────────────────────────────────
let loaded = null
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, factory }
      },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    confirm: () => true,
    open: () => null,
  },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  },
  fetch: async () => {
    throw new Error('network disabled in test')
  },
  navigator: { clipboard: { writeText: async () => {} } },
  URL,
  URLSearchParams,
  Date,
  Math,
  JSON,
  Map,
  Set,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Promise,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
}
sandbox.globalThis = sandbox
createContext(sandbox)

try {
  runInContext(source, sandbox, { filename: 'client.js' })
  check('文件作为脚本求值', true)
} catch (error) {
  check('文件作为脚本求值', false, String(error && error.message))
}

check('调用了 __ModuleLoader__.load', loaded !== null)
check('模块 id 等于包名', loaded !== null && loaded.id === 'dsh-getnote', loaded && loaded.id)

let exported = null
try {
  exported = loaded.factory(requireStub)
  check('工厂返回 exports', exported !== null && typeof exported === 'object')
} catch (error) {
  check('工厂返回 exports', false, String(error && error.message))
}

check('导出了 apply', exported !== null && typeof exported.apply === 'function')
check('导出了 inject', exported !== null && Array.isArray(exported.inject), exported && JSON.stringify(exported.inject))
check(
  'inject 只要 slots 与 locale',
  exported !== null && JSON.stringify(exported.inject) === JSON.stringify(['slots', 'locale']),
  exported && JSON.stringify(exported.inject),
)

// ── 跑 apply()，捕获它注册了什么 ────────────────────────────────────────────
const registered = []
const injectedInto = []
const localeRegistrations = []
const effects = []

const fakeCtx = {
  slots: {
    inject(slotName, callback) {
      injectedInto.push(slotName)
      return callback()
    },
    register(spec, component) {
      registered.push({ spec, component })
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
}

try {
  exported.apply(fakeCtx)
  check('apply() 执行无异常', true)
} catch (error) {
  check('apply() 执行无异常', false, String(error && error.message))
}

check('往 main 注入', injectedInto.includes('main'), JSON.stringify(injectedInto))
check('往 sidebar.panellist 注入', injectedInto.includes('sidebar.panellist'), JSON.stringify(injectedInto))
check('注册了 2 个贡献', registered.length === 2, String(registered.length))

const main = registered.find((r) => r.spec.name === 'main')
const panel = registered.find((r) => r.spec.name === 'sidebar.panellist')

check('main 用 key 而不是 id', main !== undefined && typeof main.spec.key === 'string' && main.spec.id === undefined, main && JSON.stringify(main.spec))
check('main.key === dsh-getnote', main !== undefined && main.spec.key === 'dsh-getnote', main && main.spec.key)
check('panellist 用 id', panel !== undefined && panel.spec.id === 'dsh-getnote', panel && JSON.stringify(panel.spec))
check('侧栏 id 与 main.key 一致（少了这个就没有入口）', main !== undefined && panel !== undefined && main.spec.key === panel.spec.id)
check('侧栏 order 是数字', panel !== undefined && typeof panel.spec.order === 'number', panel && String(panel.spec.order))
check('侧栏 label 是个函数', panel !== undefined && typeof panel.spec.label === 'function')
let labelText = null
try {
  labelText = panel.spec.label()
} catch (error) {
  labelText = `threw: ${error && error.message}`
}
check('侧栏 label 能求出文字', typeof labelText === 'string' && labelText.length > 0, String(labelText))
check('注册了 locale 字典', localeRegistrations.length === 1 && localeRegistrations[0].namespace === 'dsh-getnote', JSON.stringify(localeRegistrations.map((r) => r.namespace)))
check(
  'locale 字典含 zh 与 en',
  localeRegistrations.length === 1 && localeRegistrations[0].dictionaries.zh !== undefined && localeRegistrations[0].dictionaries.en !== undefined,
)

// ── 把渲染结果走一遍，确认首屏不炸 ──────────────────────────────────────────
// 桩里的 createElement 不做组件展开，所以这里递归展开函数组件（深度有限，防自引用）
function textOf(node, out = [], depth = 0) {
  if (depth > 24) return out
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out, depth + 1)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') {
      textOf(expandComponent(node.type, node.props || {}, node.children), out, depth + 1)
    } else {
      textOf(node.children, out, depth + 1)
    }
  }
  return out
}

// 展开一个组件节点。类组件（错误边界）不能当函数调用，必须 new 出来再 render，
// 否则会抛 "Class constructor cannot be invoked without 'new'"。
//
// children 必须并进 props：桩的 createElement 把 children 单独存着，而真实 React
// 是放在 props.children 里的。错误边界 render() 正是返回 this.props.children，
// 不合并的话它会渲染出 undefined，整棵子树就「消失」了。
function expandComponent(type, props, children) {
  const merged = { ...(props || {}) }
  if (merged.children === undefined && children !== undefined) merged.children = children
  const isClass = type.prototype && typeof type.prototype.render === 'function'
  if (!isClass) return type(merged)
  const instance = new type(merged)
  if (!instance.props) instance.props = merged
  if (!instance.state) instance.state = {}
  return instance.render()
}

// 与 textOf 同源，但返回元素节点本身（用于断言 class / 结构）
function flatNodes(node, out = [], depth = 0) {
  if (depth > 24 || node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) flatNodes(child, out, depth + 1)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') flatNodes(expandComponent(node.type, node.props || {}, node.children), out, depth + 1)
    else {
      out.push(node)
      flatNodes(node.children, out, depth + 1)
    }
  }
  return out
}

let rendered = null
try {
  rendered = main.component({})
  check('主面板渲染无异常', true)
} catch (error) {
  check('主面板渲染无异常', false, `${error && error.message}`)
}

if (rendered !== null) {
  const text = textOf(rendered).join(' ')
  check('渲染出标题「得到大脑」', text.includes('得到大脑'), text.slice(0, 80))
  check(
    '渲染出四个 tab（笔记/云端/同步/设置）',
    text.includes('笔记') && text.includes('云端') && text.includes('同步') && text.includes('设置'),
    text.slice(0, 120),
  )
  // 首屏 status 还没回来时给的是骨架屏（D4），不是「这个目录还没有笔记」——
  // 后者会让用户以为库真的是空的，而其实只是还没读完。
  const skNodes = flatNodes(rendered).filter((n) => typeof n.props.className === 'string' && n.props.className.indexOf('dshgn_skRow') >= 0)
  check('首屏（status 未回）渲染骨架屏而不是空库文案', skNodes.length > 0, String(skNodes.length))
  check('首屏不误报「还没有笔记」', !text.includes('这个目录还没有笔记'), text.slice(0, 160))
}

// 侧栏图标：PanelIcon 返回的是 <Icon ...> 元素，要再走一层才是 <svg>
let iconEl = null
try {
  iconEl = panel.component({ size: 18, active: true })
  check('侧栏图标组件渲染无异常', iconEl !== null && typeof iconEl === 'object', iconEl && String(iconEl.type && iconEl.type.name))
} catch (error) {
  check('侧栏图标组件渲染无异常', false, String(error && error.message))
}

let svg = null
try {
  // 桩里的 createElement 不做函数组件展开，这里手动调用工厂函数那一层
  svg = iconEl !== null && typeof iconEl.type === 'function' ? iconEl.type(iconEl.props) : iconEl
  check('侧栏图标最终是 svg', svg !== null && svg.type === 'svg', svg && String(svg.type))
  check('侧栏图标有 viewBox', svg !== null && svg.props && svg.props.viewBox === '0 0 24 24', svg && svg.props && svg.props.viewBox)
  check('侧栏图标尺寸取自 ownerProps', svg !== null && svg.props && svg.props.width === 18, svg && svg.props && String(svg.props.width))
  check('激活态带 className', svg !== null && svg.props && typeof svg.props.className === 'string' && svg.props.className.includes('On'), svg && svg.props && svg.props.className)
} catch (error) {
  check('侧栏图标最终是 svg', false, String(error && error.message))
}

// 卸载路径：effect 的 dispose 都应该是函数（否则热重载会残留 style）
const badDispose = effects.filter((e) => typeof e.dispose !== 'function')
check('所有 effect 都返回清理函数', badDispose.length === 0, JSON.stringify(badDispose.map((e) => e.label)))

// ── 第二轮：音频播放器 / 云端 / 同步 / 凭证 ─────────────────────────────────
const internals = exported.__internals
check('导出了渲染器给测试用', internals !== undefined && typeof internals.renderBlocks === 'function')

// 这一批组件是「直接接入得到大脑」的界面部分，最容易出问题的是：
//   · 音频 src 有没有走代理（直连签名 URL 会过期、会漏凭证）
//   · 没配凭证时会不会白屏而不是给引导
//   · 同步开关默认是不是关的（默认开就会偷偷吃配额）
if (internals) {
  const { AudioPlayer, CloudPane, SyncPane, CloudCredCard, formatMoment } = internals
  const tKey = (key) => key

  // ── 音频播放器 ──
  check('导出了 AudioPlayer', typeof AudioPlayer === 'function')
  if (typeof AudioPlayer === 'function') {
    const track = { url: 'https://cdn.example.com/a.mp3?sign=abc&t=1', duration: 1830, kind: 'primary', title: '录音' }
    let player = null
    try {
      player = AudioPlayer({ t: tKey, track })
      check('AudioPlayer 渲染无异常', player !== null && typeof player === 'object')
    } catch (error) {
      check('AudioPlayer 渲染无异常', false, String(error && error.message))
    }

    const flat = (node, out = [], depth = 0) => {
      if (depth > 24 || node === null || node === undefined) return out
      if (Array.isArray(node)) {
        for (const child of node) flat(child, out, depth + 1)
        return out
      }
      if (typeof node === 'object' && node.type !== undefined) {
        if (typeof node.type === 'function') flat(node.type(node.props || {}), out, depth + 1)
        else {
          out.push(node)
          flat(node.children, out, depth + 1)
        }
      }
      return out
    }

    const nodes = player === null ? [] : flat(player)
    const audioEl = nodes.find((n) => n.type === 'audio')
    check('AudioPlayer 里有 audio 元素', audioEl !== undefined)
    // 关键断言：src 必须是本插件的代理，不能是云端原始签名 URL
    check(
      '音频走 /getnote/audio 代理而不是直连',
      audioEl !== undefined && typeof audioEl.props.src === 'string' && audioEl.props.src.startsWith('/getnote/audio?url='),
      audioEl && String(audioEl.props.src).slice(0, 70),
    )
    check(
      '代理 URL 里带原始地址（编码后）',
      audioEl !== undefined && String(audioEl.props.src).includes(encodeURIComponent(track.url)),
    )
    // 进度条是自绘 div，不是 <input type=range>：原生 range 在这套面板里
    // 「怎么拖都没反应」（4px 高抓不住拇指 + 受控 value 被 timeupdate 打回）。
    // 这里验的是三件缺一不可的事：整条 18px 可点、按下即抓、拖动/松手都接了事件。
    const seek = nodes.find((n) => typeof n.props.className === 'string' && n.props.className.includes('audioSeek'))
    check('有自绘进度条', seek !== undefined)
    check(
      '不再使用原生 range 输入',
      nodes.find((n) => n.type === 'input' && n.props.type === 'range') === undefined,
      '原生 range 的拇指在这套面板里抓不住，必须自绘',
    )
    check('进度条可聚焦（键盘可达）', seek !== undefined && seek.props.tabIndex === 0)
    check('进度条声明 role=slider', seek !== undefined && seek.props.role === 'slider')
    check('进度条 max 取时长', seek !== undefined && Number(seek.props['aria-valuemax']) === 1830, seek && String(seek.props['aria-valuemax']))
    const timeText = nodes
      .filter((n) => n.type === 'span' && typeof n.props.className === 'string' && n.props.className.includes('audioTime'))
      .map((n) => textOf(n).join(''))
      .join('|')
    check('时间显示为 mm:ss / mm:ss', timeText.includes('00:00') && timeText.includes('30:30'), timeText)

    check('进度条挂了按下事件', seek !== undefined && typeof seek.props.onPointerDown === 'function')
    check('进度条挂了拖动移动事件', seek !== undefined && typeof seek.props.onPointerMove === 'function')
    check('进度条挂了松手事件', seek !== undefined && typeof seek.props.onPointerUp === 'function')
    check('进度条挂了键盘事件', seek !== undefined && typeof seek.props.onKeyDown === 'function')
    check(
      '拖动期间的值与播放进度分开存',
      /dragging\s*\?\s*dragValue\s*:\s*current/.test(source),
      '进度条位置必须用 dragging 三元，否则 timeupdate 会把拇指弹回去',
    )
    check(
      '按下时捕获指针',
      /setPointerCapture\(/.test(source),
      '不捕获指针，拖出进度条外面就丢事件，拖动态会永久卡住',
    )
    check(
      '进度条禁用浏览器手势',
      /\.dshgn_audioSeek\{[^}]*touch-action:none/.test(source),
      '缺 touch-action:none 时触摸/触控板手势会抢走 pointermove，表现同样是拖不动',
    )
    check(
      '进度条轨道由 div 绘制',
      nodes.find((n) => typeof n.props.className === 'string' && n.props.className.includes('audioTrack')) !== undefined,
    )

    // 本地附件（用户自己库里的录音）不走 CDN 代理：url 已经是本站路径，原样用。
    // 若这里被错误地再包一层 /getnote/audio?url=...，播放器会请求一个「代理代理」
    // 的地址，看起来像在转圈其实永远放不出来。
    const localTrack = { url: '/getnote/asset?path=' + encodeURIComponent('随手记/asset/x_1_audio.mp3'), duration: 0, kind: 'local', title: 'x_1_audio.mp3' }
    let localPlayer = null
    try {
      localPlayer = AudioPlayer({ t: tKey, track: localTrack })
    } catch (error) {
      check('本地音轨渲染无异常', false, String(error && error.message))
    }
    const localNodes = localPlayer === null ? [] : flat(localPlayer)
    const localAudio = localNodes.find((n) => n.type === 'audio')
    check('本地音轨的 src 原样使用本站路径', localAudio !== undefined && localAudio.props.src === localTrack.url, localAudio && String(localAudio.props.src).slice(0, 80))
    const localLabel = localNodes
      .filter((n) => n.type === 'span')
      .map((n) => textOf(n).join(''))
      .join('|')
    check('本地音轨标注为本地录音而不是云端录音', localLabel.includes('note.localAudio'), localLabel.slice(0, 60))

    // 没有音轨时不该崩，也不该渲染空壳
    let noTrack = 'threw'
    try {
      noTrack = AudioPlayer({ t: tKey, track: null })
    } catch (error) {
      noTrack = `threw: ${error && error.message}`
    }
    check('AudioPlayer 无音轨时返回 null', noTrack === null, String(noTrack))
  }

  // ── 毫秒 → mm:ss ──
  check('formatMoment 0 → 00:00', formatMoment(0) === '00:00', formatMoment(0))
  check('formatMoment 75000 → 01:15', formatMoment(75000) === '01:15', formatMoment(75000))
  check('formatMoment 处理非法输入', formatMoment(undefined) === '00:00', formatMoment(undefined))

  // ── 云端面板：没配凭证要给引导，不能白屏 ──
  check('导出了 CloudPane', typeof CloudPane === 'function')
  if (typeof CloudPane === 'function') {
    let pane = null
    try {
      pane = CloudPane({ t: tKey, status: { api: { configured: false } }, showToast: () => {}, onError: () => {}, onSynced: () => {} })
      check('CloudPane 未配置时渲染无异常', true)
    } catch (error) {
      check('CloudPane 未配置时渲染无异常', false, String(error && error.message))
    }
    const text = pane === null ? '' : textOf(pane).join(' ')
    check('未配置时提示去设置填凭证', text.includes('cloud.notConfigured') && text.includes('cloud.notConfiguredDesc'), text.slice(0, 90))
  }

  // ── 同步面板：默认必须关 ──
  check('导出了 SyncPane', typeof SyncPane === 'function')
  if (typeof SyncPane === 'function') {
    const status = {
      api: { configured: true, lastRunAt: null },
      autoSync: { enabled: false, minutes: 15, incremental: true, running: false, lastResult: null, lastError: null },
    }
    let pane = null
    try {
      pane = SyncPane({ t: tKey, status, onChanged: async () => {}, onError: () => {}, showToast: () => {} })
      check('SyncPane 渲染无异常', true)
    } catch (error) {
      check('SyncPane 渲染无异常', false, String(error && error.message))
    }
    const nodes = pane === null ? [] : (function walk(node, out = [], depth = 0) {
      if (depth > 24 || node === null || node === undefined) return out
      if (Array.isArray(node)) {
        for (const child of node) walk(child, out, depth + 1)
        return out
      }
      if (typeof node === 'object' && node.type !== undefined) {
        if (typeof node.type === 'function') walk(node.type(node.props || {}), out, depth + 1)
        else {
          out.push(node)
          walk(node.children, out, depth + 1)
        }
      }
      return out
    })(pane)
    const toggle = nodes.find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.includes('dshgn_toggle'))
    check('同步开关存在', toggle !== undefined)
    // 这条是安全线：装上插件就偷偷联网不是用户要的
    check('自动同步默认关（data-on=false）', toggle !== undefined && toggle.props['data-on'] === 'false', toggle && String(toggle.props['data-on']))
    const text = pane === null ? '' : textOf(pane).join(' ')
    check('同步页说明不会覆盖本地修改', text.includes('sync.desc'), text.slice(0, 80))
    check('同步页给出配额提示', text.includes('sync.quotaHint'))
  }

  // ── 凭证卡片：只写不回 ──
  check('导出了 CloudCredCard', typeof CloudCredCard === 'function')
  if (typeof CloudCredCard === 'function') {
    let card = null
    try {
      card = CloudCredCard({
        t: tKey,
        api: { configured: true, apiKeyMasked: 'gk_live_abc…1234', clientIdMasked: 'cli_abc…', hasGrantId: false, credentialsPath: 'C:/x/cloud.json' },
        onSaved: async () => {},
        onError: () => {},
      })
      check('CloudCredCard 渲染无异常', true)
    } catch (error) {
      check('CloudCredCard 渲染无异常', false, String(error && error.message))
    }
    const nodes = card === null ? [] : (function walk(node, out = [], depth = 0) {
      if (depth > 24 || node === null || node === undefined) return out
      if (Array.isArray(node)) {
        for (const child of node) walk(child, out, depth + 1)
        return out
      }
      if (typeof node === 'object' && node.type !== undefined) {
        if (typeof node.type === 'function') walk(node.type(node.props || {}), out, depth + 1)
        else {
          out.push(node)
          walk(node.children, out, depth + 1)
        }
      }
      return out
    })(card)
    const keyInput = nodes.find((n) => n.type === 'input' && n.props.type === 'password')
    check('API Key 输入框是 password 类型', keyInput !== undefined)
    check('API Key 输入框回填为空（不回显明文）', keyInput !== undefined && keyInput.props.value === '', keyInput && JSON.stringify(keyInput.props.value))
    const text = textOf(card).join(' ')
    check('显示打码后的 Key', text.includes('gk_live_abc…1234'), text.slice(0, 100))
    check('显示凭证文件路径', text.includes('C:/x/cloud.json'))
    check('提示 Key 不会再回显', text.includes('api.neverEcho'))
  }

  // ── 设置页：登录态必须分三态 ──
  // auth.json 存在只说明「登录过」，令牌过期后文件还在。这时显示「已登录」
  // 会骗人——用户以为登录有效，其实云端走的是 API Key 那条通道。
  check('导出了 SettingsPane', typeof internals.SettingsPane === 'function')
  if (typeof internals.SettingsPane === 'function') {
    const baseStatus = {
      settingsPath: 'C:/x/dsh-getnote.json',
      vaultRoot: 'D:/vault',
      suggestions: [],
      api: { configured: true },
      vaultMissing: null,
      notes: 3,
      dirs: 1,
      bytes: 100,
      authPath: 'C:/x/auth.json',
    }
    const badgeOf = (cloud) => {
      let pane = null
      try {
        pane = internals.SettingsPane({
          t: tKey,
          status: { ...baseStatus, cloud },
          onSaved: async () => {},
          onError: () => {},
          showToast: () => {},
        })
      } catch (error) {
        return { error: String(error && error.message) }
      }
      const nodes = (function walk(node, out = [], depth = 0) {
        if (depth > 24 || node === null || node === undefined) return out
        if (Array.isArray(node)) {
          for (const child of node) walk(child, out, depth + 1)
          return out
        }
        if (typeof node === 'object' && node.type !== undefined) {
          if (typeof node.type === 'function') walk(node.type(node.props || {}), out, depth + 1)
          else {
            out.push(node)
            walk(node.children, out, depth + 1)
          }
        }
        return out
      })(pane)
      // 设置页有两个徽章：云端接入卡的「已接入」和凭证文件卡的登录态。
      // 只认后者——按文案挑，别按位置挑（顺序一改测试就假失败）。
      const loginTexts = ['settings.loggedIn', 'settings.loginExpired', 'settings.loggedOut']
      const badges = nodes.filter(
        (n) =>
          n.type === 'span' &&
          typeof n.props.className === 'string' &&
          n.props.className.includes('dshgn_badge') &&
          loginTexts.some((key) => (Array.isArray(n.children) ? n.children : [n.children]).includes(key)),
      )
      return { badge: badges[0], text: textOf(pane).join(' ') }
    }
    const ok = badgeOf({ loggedIn: true, expired: false })
    check('登录有效时徽章是 ok 态', ok.badge !== undefined && ok.badge.props.className.includes('dshgn_badgeOk'), ok.error || (ok.badge && ok.badge.props.className))
    const expired = badgeOf({ loggedIn: true, expired: true })
    check('登录过期时徽章是警告态', expired.badge !== undefined && expired.badge.props.className.includes('dshgn_badgeWarn'), expired.error || (expired.badge && expired.badge.props.className))
    check('登录过期时文案是「已过期」而不是「已登录」', expired.text.includes('settings.loginExpired') && !expired.text.includes('settings.loggedIn'), expired.text.slice(0, 120))
    const none = badgeOf({ loggedIn: false, expired: false })
    check('未登录时徽章不带 ok/warn', none.badge === undefined || (!none.badge.props.className.includes('dshgn_badgeOk') && !none.badge.props.className.includes('dshgn_badgeWarn')), none.error || (none.badge && none.badge.props.className))
    check('未登录时文案是「未登录」', none.text.includes('settings.loggedOut'))
  }
}

// ── Markdown 渲染 ───────────────────────────────────────────────────────────
// 归档笔记里最典型的东西都过一遍：表格、章节时间轴、逐字稿围栏
if (internals) {
  const { renderBlocks, renderInline } = internals

  function kinds(nodes, out = []) {
    for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
      if (node === null || node === undefined) continue
      if (typeof node === 'object' && node.type !== undefined) {
        out.push(typeof node.type === 'string' ? node.type : 'component')
        kinds(node.children, out)
      }
    }
    return out
  }

  const md = `# 示例录音笔记

> 一段摘要

## 基本信息

| 项目 | 内容 |
| --- | --- |
| 时长 | 12:30 |

## 章节

- 00:00 开场
- 02:10 第一个问题
  - 追问一下

1. 有序一
2. 有序二

- [x] 已完成的事
- [ ] 还没做的事

### 逐字稿

\`\`\`
🟢 说话人1 [00:00:00] 你好。
\`\`\`

正文里的 \`inline code\` 和 **粗体** 还有 [链接](https://www.biji.com/note/1)。

---

（源自得到大脑 · 归档于 2026-11-13）
`

  const blocks = renderBlocks(md)
  const tagList = kinds(blocks)
  check('渲染出 h1', tagList.includes('h1'), tagList.slice(0, 12).join(','))
  check('渲染出 h2', tagList.includes('h2'))
  check('渲染出 blockquote', tagList.includes('blockquote'))
  check('渲染出 table', tagList.includes('table'))
  check('渲染出 ul 与 ol 两种列表', tagList.includes('ul') && tagList.includes('ol'))
  check('渲染出 pre 代码块', tagList.includes('pre'))
  check('渲染出 hr 分隔线', tagList.includes('hr'))

  // 章节里的时间轴不能被吞掉或误判成链接
  const text = JSON.stringify(blocks)
  check('时间轴文本保留', text.includes('00:00 开场') || text.includes('"00:00 开场"'))
  check('时间轴没被当成链接', !text.includes('http') || text.includes('www.biji.com'))

  // 表格结构
  const table = blocks.find((b) => b && b.type === 'div' && b.props.className === 'dshgn_tableWrap')
  check('表格包在可横向滚动的容器里', table !== undefined)
  if (table) {
    const inner = table.children
    check('表格是 table 元素', inner && inner.type === 'table', inner && String(inner.type))
  }

  // 任务列表要有勾选标记
  const taskItems = JSON.stringify(blocks).match(/dshgn_task/g)
  check('任务列表识别 [x] / [ ]', taskItems !== null && taskItems.length === 2, String(taskItems && taskItems.length))

  // 代码围栏不能把后面的正文一起吞掉（未闭合围栏是常见的手写错误）
  const unclosed = renderBlocks('```\nabc\n')
  check('未闭合围栏不抛异常', Array.isArray(unclosed) && unclosed.length === 1, String(unclosed.length))

  // 行内渲染
  const inline = renderInline('前 `代码` 中 **粗** 后 [文字](https://x.test) 尾', 'k')
  const inlineKinds = kinds(inline)
  check('行内 code/strong/a 都渲染', inlineKinds.includes('code') && inlineKinds.includes('strong') && inlineKinds.includes('a'), inlineKinds.join(','))
  const banner = JSON.stringify(inline)
  check('链接带 target=_blank', banner.includes('_blank'))
  check('链接带 noopener', banner.includes('noopener'))

  // 空的/异常输入
  check('renderBlocks 处理空串', Array.isArray(renderBlocks('')) && renderBlocks('').length === 0)
  check('renderBlocks 处理 undefined', Array.isArray(renderBlocks(undefined)))

  // 同名一级标题去重：阅读区外面已经渲染了 h1，正文再以 `# 同名` 开头就会出现两个大标题
  const strip = internals.stripLeadingHeading
  check('去重函数存在', typeof strip === 'function')
  check('剥掉同名一级标题', strip('# 时间线\n\n正文', '时间线') === '正文')
  check('前导空行也剥', strip('\n\n# 时间线\n\n正文', '时间线') === '正文')
  check('不同名不剥', strip('# 别的标题\n\n正文', '时间线') === '# 别的标题\n\n正文')
  check('二级标题不剥', strip('## 时间线\n\n正文', '时间线') === '## 时间线\n\n正文')
  check('空标题不动', strip('# 时间线\n\n正文', '') === '# 时间线\n\n正文')
  check('标题含正则字符不炸', strip('# a.b(c)\n\n正文', 'a.b(c)') === '正文')

  // 本地阅读区不能把 frontmatter 当正文铺出来
  // 断言用 `\s*` 而不是直接接 `current`：这处调用带 options 参数后换了行，
  // 死抠字面量会把「只是格式化」误判成「功能丢了」。
  check(
    '本地阅读区渲染 body 而不是 content',
    /renderBlocks\(\s*current\.body/.test(source),
    /renderBlocks\(\s*current\.body/.test(source) ? 'body' : 'content',
  )
  check('云端阅读区也剥同名标题', /stripLeadingHeading\(detail\.content/.test(source))

  // 逐字稿：以前塞进 <pre><code>，等宽字体对中文没用（回落成宋体）、
  // white-space:pre 又不折行，长句被横向裁掉——用户看到的就是「字体太丑」。
  const { TranscriptBlock } = internals
  check('导出了 TranscriptBlock', typeof TranscriptBlock === 'function')
  if (typeof TranscriptBlock === 'function') {
    const raw = '🟢 说话人1 [00:00:00] 今天天气不错\n🟢 说话人2 [00:00:15] 是的呢\n[00:01:02] 没有说话人的一行'
    let block = null
    try {
      block = TranscriptBlock({ text: raw })
      check('逐字稿渲染无异常', block !== null)
    } catch (error) {
      check('逐字稿渲染无异常', false, String(error && error.message))
    }
    const inner = block === null ? [] : flatNodes(block)
    check(
      '逐字稿不再是 pre/code 等宽块',
      inner.find((n) => n.type === 'pre' || n.type === 'code') === undefined,
    )
    check(
      '逐字稿按段落渲染',
      inner.filter((n) => n.type === 'p').length === 3,
      String(inner.filter((n) => n.type === 'p').length),
    )
    const stamps = inner
      .filter((n) => typeof n.props.className === 'string' && n.props.className.includes('dshgn_ts'))
      .map((n) => textOf(n).join(''))
    check('时间戳单独成列', stamps.join('|') === '00:00:00|00:00:15|00:01:02', stamps.join('|'))
    const speakers = inner
      .filter((n) => typeof n.props.className === 'string' && n.props.className.includes('dshgn_speaker'))
      .map((n) => textOf(n).join(''))
    check('说话人单独成列', speakers.join('|') === '🟢 说话人1|🟢 说话人2', speakers.join('|'))
    check('逐字稿容器挂了 dshgn_transcript 类', block !== null && String(block.props.className).includes('dshgn_transcript'))
    check('逐字稿空文本返回 null', TranscriptBlock({ text: '' }) === null)
    check('逐字稿 undefined 返回 null', TranscriptBlock({ text: undefined }) === null)
    // 样式必须换掉等宽西文字体、允许折行，否则中文照样丑、长句照样被裁
    check('逐字稿用正文字体栈', /\.dshgn_transcript\{[^}]*PingFang SC/.test(source), '中文必须有自己的字体栈')
    check('逐字稿允许自动折行', /\.dshgn_transcript\{[^}]*white-space:pre-wrap/.test(source))
    check('逐字稿行距放宽', /\.dshgn_transcript\{[^}]*line-height:1\.9/.test(source))

    // 本地归档的围栏是「时间戳一行、正文下一行」，两种来源都得吃得下，
    // 否则时间戳和它的内容会被拆成两段，读起来完全对不上。
    const stacked = '🟢 说话人1 [00:00:00]\nOK，这将是我以我这个。\n\n🟢 说话人1 [00:00:07]\n第一次给这个录音卡进行录音。'
    const stackedBlock = TranscriptBlock({ text: stacked })
    const stackedPs = flatNodes(stackedBlock).filter((n) => n.type === 'p')
    check('时间戳独占一行时仍合成一段', stackedPs.length === 2, String(stackedPs.length))
    check(
      '时间戳下面的正文被收进同一段',
      stackedPs.length === 2 && textOf(stackedPs[0]).join('').includes('OK，这将是我以我这个。'),
      stackedPs.length === 2 ? textOf(stackedPs[0]).join('') : '',
    )

    // 围栏里的内容像不像逐字稿：普通代码块不能被误判成逐字稿
    const { looksLikeTranscript } = internals
    check('导出 looksLikeTranscript', typeof looksLikeTranscript === 'function')
    check('带时间戳的围栏认作逐字稿', looksLikeTranscript(stacked) === true)
    check('普通代码块不认作逐字稿', looksLikeTranscript('const a = 1\nconsole.log(a)') === false)
    check('只有一行时间戳不认（可能只是偶然）', looksLikeTranscript('[00:00:00] 只有一行') === false)
    check('空串不认作逐字稿', looksLikeTranscript('') === false)

    // ── 新增：图片附件 / 双链 / 知识库 / 回收站 ─────────────────────────────
    const { renderEmbed, assetLabel, TrashPane } = internals

    // 图片附件以前完全被丢掉：listAssets 明明返回 kind:'image'，客户端只 filter audio。
    check('导出 renderEmbed', typeof renderEmbed === 'function')
    const imgOptions = { assets: [{ kind: 'image', name: '照片.png', path: '随手记/asset/照片.png' }] }
    const imgEl = renderEmbed('照片.png', 'k1', imgOptions)
    const imgFlat = imgEl === null ? [] : flatNodes(imgEl)
    const imgNode = imgFlat.find((n) => n.type === 'img')
    check('嵌入图片渲染成 img', imgNode !== undefined, JSON.stringify(imgFlat.map((n) => n.type)))
    check(
      '图片走本站 asset 端点而不是外链',
      imgNode !== undefined && String(imgNode.props.src).startsWith('/getnote/asset?path='),
      imgNode === undefined ? '' : String(imgNode.props.src),
    )
    check('图片懒加载', imgNode !== undefined && imgNode.props.loading === 'lazy')

    // 嵌入非图片附件不要渲染成坏图
    const poorOptions = { assets: [{ kind: 'transcript', name: '转写.md', path: 'x/asset/转写.md' }] }
    const poorEl = renderEmbed('转写.md', 'k2', poorOptions)
    check('嵌入非图片文件不渲染成 img', poorEl !== null && !flatNodes(poorEl).some((n) => n.type === 'img'))

    // 找不到附件时也不能炸
    let embedMissing = null
    try {
      embedMissing = renderEmbed('不存在的文件.png', 'k3', { assets: [] })
    } catch (error) {
      check('嵌入找不到附件时不抛错', false, String(error && error.message))
    }
    check('嵌入找不到附件时不抛错', true)

    // 播放器标题去掉 _<note_id>_audio 这种长串，否则卡片上是一串数字
    check('assetLabel 去掉 note_id', assetLabel('云端标题_1200000000000000001_audio.mp3') === '云端标题.mp3', assetLabel('云端标题_1200000000000000001_audio.mp3'))
    check('assetLabel 去掉 transcript 后缀', assetLabel('云端标题_1200000000000000001_transcript.md') === '云端标题.md', assetLabel('云端标题_1200000000000000001_transcript.md'))
    check('assetLabel 对普通名字不动', assetLabel('普通照片.png') === '普通照片.png', assetLabel('普通照片.png'))
    check('assetLabel 空值安全', assetLabel('') === '' && assetLabel(undefined) === '')

    // 双链：正文里的 [[目标]] 必须是可点按钮，而不是原样吐出来
    const wl = renderInline('参见 [[另一篇笔记]] 和 [[目标|显示文字]]', 'k4', { onOpenWikiLink: () => {} })
    const wlFlat = flatNodes(wl)
    const wlButtons = wlFlat.filter((n) => n.type === 'button' && String(n.props.className).includes('dshgn_wikilink'))
    check('双链渲染成按钮', wlButtons.length === 2, String(wlButtons.length))
    check('双链按钮带目标文本', wlButtons.length === 2 && textOf(wlButtons[0]).join('').includes('另一篇笔记'), wlButtons.length ? textOf(wlButtons[0]).join('') : '')
    check('双链支持 | 显示文字', wlButtons.length === 2 && textOf(wlButtons[1]).join('').includes('显示文字'), wlButtons.length === 2 ? textOf(wlButtons[1]).join('') : '')

    // 点击要真的把目标传出去（而不是渲染成死链接）
    let clickedTarget = null
    const wlClickable = renderInline('[[被点的笔记]]', 'k5', { onOpenWikiLink: (name) => { clickedTarget = name } })
    const wlBtn = flatNodes(wlClickable).find((n) => n.type === 'button')
    if (wlBtn !== undefined && typeof wlBtn.props.onClick === 'function') wlBtn.props.onClick({ preventDefault() {}, stopPropagation() {} })
    check('双链点击回传目标名', clickedTarget === '被点的笔记', String(clickedTarget))

    // 普通 markdown 链接不能被双链逻辑吃掉
    const plainLink = renderInline('[普通链接](https://example.com)', 'k6', {})
    const plainAnchor = flatNodes(plainLink).find((n) => n.type === 'a')
    check('普通链接仍是 a 标签', plainAnchor !== undefined && plainAnchor.props.href === 'https://example.com', JSON.stringify(flatNodes(plainLink).map((n) => n.type)))

    // 回收站面板：能渲染，且请求的是 /trash/list
    check('导出 TrashPane', typeof TrashPane === 'function')
    let trashRendered = null
    try {
      trashRendered = TrashPane({ t: (key) => key, status: { trash: 0 }, onChanged: () => {}, onError: () => {}, showToast: () => {} })
    } catch (error) {
      check('回收站面板渲染无异常', false, String(error && error.message))
    }
    check('回收站面板渲染无异常', trashRendered !== null)
    check('回收站面板有恢复与永久删除文案', /trash\.restore/.test(source) && /trash\.purgeOne/.test(source))
    check('回收站面板请求 /trash/list', /api\('\/trash\/list'\)/.test(source))
    check('回收站面板请求 /trash/restore', /\/trash\/restore/.test(source))
    check('回收站面板请求 /trash/purge', /\/trash\/purge/.test(source))

    // 云端：标签增删、分享、新建、知识库、把本地改动推回云端
    check('云端接上 /cloud/tags-add', /\/cloud\/tags-add/.test(source))
    check('云端接上 /cloud/tags-delete', /\/cloud\/tags-delete/.test(source))
    check('云端接上 /cloud/share', /\/cloud\/share/.test(source))
    check('云端接上 /cloud/create', /\/cloud\/create/.test(source))
    check('云端接上 /cloud/topics', /\/cloud\/topics/.test(source))
    check('云端接上 /cloud/topic-notes', /\/cloud\/topic-notes/.test(source))
    check('本地改动能推回云端 /sync/push', /\/sync\/push/.test(source))

    // 新增的样式类必须都真的存在，否则「加了 UI 但看不见」
    for (const cls of ['dshgn_topicRow', 'dshgn_topicChip', 'dshgn_tagX', 'dshgn_imgRow', 'dshgn_img', 'dshgn_wikilink', 'dshgn_embed', 'dshgn_embedFile']) {
      check(`样式 .${cls} 已定义`, source.includes(`.${cls}{`), cls)
    }

    // ── 顶栏：动作按钮在页签左边 ─────────────────────────────────────────────
    // 位置断言只能查源码顺序：head 里 actions 的 h(...) 必须出现在 tabs 之前。
    const actionsIdx = source.indexOf("className: 'dshgn_actions'")
    const tabsIdx = source.indexOf("className: 'dshgn_tabs'")
    check('顶栏里动作按钮排在页签之前', actionsIdx !== -1 && tabsIdx !== -1 && actionsIdx < tabsIdx, `${actionsIdx} < ${tabsIdx}`)

    // ── 页签数字角标 ─────────────────────────────────────────────────────────
    // 数字要单独成节点排在文字右边，不能拼进 label 字符串里（那样数字和文字同色同字号，
    // 挤在一起像标签的一部分），也不能做成骑在页签右上角的角标（会压掉右内边距）。
    check('页签数字是独立角标节点', /className: 'dshgn_tabBadge'/.test(source))
    check('页签文字包在 tabLabel 里', /className: 'dshgn_tabLabel'/.test(source))
    check(
      '冲突页签把数字当参数传',
      /tabButton\(\s*'conflict',\s*t\('tab\.conflict'\),\s*status !== null && status\.conflicts > 0 \? status\.conflicts : undefined,?\s*\)/.test(source),
    )
    check('不再把数字拼进文案', !/\$\{t\('tab\.conflict'\)\} \$\{status\.conflicts\}/.test(source))
    // 页签常驻：早先是「有冲突才出现」，但入口凭空消失会让人以为功能被删了，
    // 而且处理过的留档也想随时翻回去看。数字没有时不传 badge（渲染成无角标）。
    check('冲突页签无条件渲染（不再被 status.conflicts > 0 整段包住）', !/status !== null && status\.conflicts > 0\s*\?\s*tabButton\('conflict'/.test(source))
    check('冲突页签在页签行里始终存在', /tabButton\('sync'[\s\S]{0,600}tabButton\(\s*'conflict'[\s\S]{0,600}tabButton\('settings'/.test(source))
    check('没有待处理时不显示角标数字', /status\.conflicts > 0 \? status\.conflicts : undefined/.test(source))
    check('角标样式已定义', /\.dshgn_tabBadge\{/.test(source))
    // 页签本身要改成 flex，否则 span 角标和文字会按 baseline 错位
    check('页签是 flex 布局', /\.dshgn_tab\{[^}]*display:inline-flex/.test(source))

    // ── 冲突页：未处理/已处理分区 ────────────────────────────────────────────
    // 处理完的东西是归档不是待办，默认收起；未处理的直接铺开。
    check('冲突按 resolved 分成两区', /pendingItems\s*=/.test(source) && /resolvedItems\s*=/.test(source))
    check('已处理区默认折叠', /useState\(false\)[\s\S]{0,80}resolvedOpen|resolvedOpen[\s\S]{0,40}useState\(false\)/.test(source))
    check('折叠标题行可点开合', /className: 'dshgn_foldHead'/.test(source))
    check('折叠箭头按开合旋转', /\.dshgn_foldArrow\[data-open="true"\]\{transform:rotate\(90deg\)\}/.test(source))
    check('已处理区显示条数', /className: 'dshgn_foldCount'/.test(source))
    check('已处理条目显示当初选了哪边', /conflict\.pickedLocal/.test(source) && /conflict\.pickedCloud/.test(source))
    check('已处理条目的按钮文案是「查看」', /conflict\.review/.test(source))

    // ── 冲突页：采纳按钮的红框与填充态 ───────────────────────────────────────
    // 未处理时两个都红框（谁都不像默认选项），选过的那边填浅色。
    check('红框按钮样式已定义', /\.dshgn_btnWarn\{[^}]*state-error-primary/.test(source))
    check('浅填充按钮样式已定义', /\.dshgn_btnPale\{[^}]*btnFillPale/.test(source))
    check('未处理时两个按钮都是红框', /detail\.keptLocal === true[\s\S]{0,200}dshgn_btnPale[\s\S]{0,400}dshgn_btnWarn/.test(source))
    check('选过本地版时该按钮填浅色', /detail\.keptLocal === true[\s\S]{0,120}dshgn_btnPale/.test(source))
    check('选过云端版时该按钮填浅色', /detail\.keptLocal === false[\s\S]{0,120}dshgn_btnPale/.test(source))
    check('浅填充色由主题色推导', /--dshgn-btnFillPale':\s*hslToHex\(hue/.test(source))
    check('浅填充比 btnFillSoft 更浅', (() => {
      const pale = /'--dshgn-btnFillPale':\s*hslToHex\(hue,\s*([\d.]+),\s*([\d.]+)\)/.exec(source)
      const soft = /'--dshgn-btnFillSoft':\s*hslToHex\(hue,\s*([\d.]+),\s*([\d.]+)\)/.exec(source)
      if (pale === null || soft === null) return false
      return Number(pale[2]) > Number(soft[2])
    })())
    check('采纳后不关详情页（要看到填充态）', /const fresh = await api\(`\/conflict\/read/.test(source))
    check('已处理可退回未处理', /\/conflict\/unresolve/.test(source))

    // ── 切换动画 ─────────────────────────────────────────────────────────────
    check('切页签有入场动画 keyframes', /@keyframes dshgn_tabIn\s*\{/.test(source))
    check('动画绑在 .dshgn_body 上', /\.dshgn_body\{[^}]*animation:dshgn_tabIn/.test(source))
    check('body 以 tab 作 key（否则动画不重播）', /key:\s*tab,\s*className:\s*'dshgn_body'/.test(source))
    check('尊重 prefers-reduced-motion', /@media \(prefers-reduced-motion:reduce\)/.test(source))

    // ── 主题色推导 ───────────────────────────────────────────────────────────
    if (typeof internals.parseHex === 'function') {
      check('parseHex 认六位', JSON.stringify(internals.parseHex('#0a2a52')) === '{"r":10,"g":42,"b":82}')
      check('parseHex 大小写无关', JSON.stringify(internals.parseHex('#0A2A52')) === JSON.stringify(internals.parseHex('#0a2a52')))
      check('parseHex 拒绝非颜色', internals.parseHex('blue') === null && internals.parseHex('#12345') === null && internals.parseHex(null) === null)
    } else {
      check('导出了 parseHex', false)
    }

    if (typeof internals.rgbToHsl === 'function' && typeof internals.hslToHex === 'function') {
      const back = internals.parseHex(internals.hslToHex(0.5, 0.6, 0.4))
      check('hsl→hex→rgb 往返稳定', back !== null && back.g > back.r && back.b > back.r, JSON.stringify(back))
    }

    if (typeof internals.themeVars === 'function') {
      const accent = internals.themeVars('#c0392b')
      check('themeVars 返回一整套变量', accent !== null && Object.keys(accent).length >= 18)
      check('themeVars 非法输入返回 null（回落到内置配色）', internals.themeVars('nope') === null && internals.themeVars(null) === null)
      if (accent !== null) {
        check('推导出了 tintRgb 分量（18 处半透明色靠它）', /^\d+,\d+,\d+$/.test(accent['--dshgn-tintRgb']), accent['--dshgn-tintRgb'])
        // 最重要的产品规则：无论用户选什么色，明度必须左深 → 中浅 → 右近白
        const lum = (hex) => {
          const c = internals.parseHex(hex)
          return (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255
        }
        check(
          '层次锁定：左栏最深 < 中栏 < 右栏最浅',
          lum(accent['--dshgn-deep']) < lum(accent['--dshgn-mid2']) && lum(accent['--dshgn-mid2']) < lum(accent['--dshgn-light2']),
          `${lum(accent['--dshgn-deep']).toFixed(3)} < ${lum(accent['--dshgn-mid2']).toFixed(3)} < ${lum(accent['--dshgn-light2']).toFixed(3)}`,
        )
        check('左栏字是浅色（深底浅字）+ 中栏字是深色', lum(accent['--dshgn-deepFg']) > 0.8 && lum(accent['--dshgn-midFg']) < 0.3)

        // 淡一档的强调按钮：必须由色相推导，不能写死蓝。
        // 否则换到墨绿/酒红主题时，「用我的本地版」会突然跳出一块亮蓝，比不淡更难看。
        check(
          '淡色按钮变量由主题推导',
          typeof accent['--dshgn-btnFillSoft'] === 'string' && /^#[0-9a-f]{6}$/.test(accent['--dshgn-btnFillSoft']),
          accent['--dshgn-btnFillSoft'],
        )
        check(
          '淡色按钮确实比主按钮浅',
          lum(accent['--dshgn-btnFillSoft']) > lum(accent['--dshgn-btnFill']),
          `${lum(accent['--dshgn-btnFillSoft']).toFixed(3)} > ${lum(accent['--dshgn-btnFill']).toFixed(3)}`,
        )
      }
      // 灰色主题不能被硬拗成彩色，也不能炸
      const grey = internals.themeVars('#808080')
      check('选纯灰也能推导出整套变量', grey !== null && typeof grey['--dshgn-deep'] === 'string')
      // 纯灰主题下淡色按钮不能变成纯白（那样按钮就看不见了）
      check(
        '纯灰主题下淡色按钮仍有可辨色',
        grey !== null && grey['--dshgn-btnFillSoft'] !== '#ffffff',
        grey === null ? 'null' : grey['--dshgn-btnFillSoft'],
      )
    } else {
      check('导出了 themeVars', false)
    }

    // ── 主题色卡片 UI ────────────────────────────────────────────────────────
    check('设置页挂上主题色卡片', /h\(ThemeCard,\s*\{/.test(source))
    check('主题色卡片有预设色板', /dshgn_swatch/.test(source))
    check('主题色卡片有原生取色器', /type:\s*'color'/.test(source))
    check('主题色回写 /settings', /JSON\.stringify\(\{\s*themeColor:\s*value\s*\}\)/.test(source))
    check('主题色不合法时才不回显（null = 恢复默认）', /save\(null\)/.test(source))
    for (const cls of ['dshgn_themeRow', 'dshgn_swatch', 'dshgn_swatchOn', 'dshgn_colorInput']) {
      check(`样式 .${cls} 已定义`, source.includes(`.${cls}{`) || source.includes(`.${cls},`) || source.includes(`.${cls}:`), cls)
    }
    for (const key of ['theme.title', 'theme.desc', 'theme.custom', 'theme.preset', 'theme.apply', 'theme.reset', 'theme.saved']) {
      check(`主题色文案 ${key} 中英都有`, internals.LEX.zh[key] !== undefined && internals.LEX.en[key] !== undefined)
    }

    // ── 主题色实时预览链路 ───────────────────────────────────────────────────
    // 卡片里的草稿必须能传到面板根节点，否则用户选色时整面板不动、只有保存后才变，
    // 那就不叫预览了。这三条盯的正是这条链路是否还连着。
    check('ThemeCard 接收 onPreview 回调', /const\s*\{\s*t,\s*themeColor,\s*onSaved,\s*onError,\s*onPreview\s*\}\s*=\s*props/.test(source))
    check('草稿变化时调用 onPreview', /onPreview\(draft\)/.test(source))
    check('离开设置页清掉预览色', /onPreview\(null\)/.test(source))
    check('SettingsPane 把预览回调传下去', /onThemePreview/.test(source))
    check('面板根节点状态里有 themePreview', /const\s*\[themePreview,\s*setThemePreview\]\s*=\s*React\.useState\(null\)/.test(source))
    check(
      '预览色优先于已保存色',
      /themeVars\(\s*themePreview\s*!==\s*null\s*\?\s*themePreview\s*:\s*status\s*!==\s*null\s*\?\s*status\.themeColor\s*:\s*null\s*\)/.test(source),
    )
    // 保存顺序：先刷新 status 再清草稿，否则会闪一下旧的已保存色
    check('保存后先刷新再清草稿', /await onSaved\(t\('theme\.saved'\)\)\s*\n\s*setDraft\(null\)/.test(source))

    // ── 三栏布局不能被动画规则顶成竖排 ───────────────────────────────────────
    // 曾经踩过：给 .dshgn_body 加动画时顺手写了 flex-direction:column，
    // 结果目录树/列表/正文从横向三栏变成纵向一列叠起来。
    const bodyRules = [...source.matchAll(/\.dshgn_body\{([^}]*)\}/g)].map((m) => m[1])
    check('存在 .dshgn_body 规则', bodyRules.length >= 1)
    check(
      '没有任何 .dshgn_body 规则把方向改成纵向',
      bodyRules.every((rule) => !/flex-direction\s*:\s*column/.test(rule)),
      bodyRules.join(' | '),
    )
    check('三栏横排布局仍在（flex:1;display:flex）', /\.dshgn_body\{flex:1;display:flex;min-height:0\}/.test(source))

    // ── 三栏效果预览条 ───────────────────────────────────────────────────────
    // 设置页主体是白卡片，用户在那儿看不到三栏，所以卡片里要画一条三格预览，
    // 否则选颜色只能靠想象。
    check('主题色卡片有三栏预览条', /dshgn_previewBar/.test(source))
    check('预览条三格各用对应变量', /dshgn-previewCell|dshgn_previewCell/.test(source))
    check('预览条用了三档底色变量', /--dshgn-deep/.test(source) && /--dshgn-mid/.test(source) && /--dshgn-light/.test(source))
    check('预览条走 themeVars(active) 实时算色', /themeVars\(active\)/.test(source))
    for (const key of ['theme.previewLeft', 'theme.previewMid', 'theme.previewRight']) {
      check(`预览条文案 ${key} 中英都有`, internals.LEX.zh[key] !== undefined && internals.LEX.en[key] !== undefined)
    }
  }
}

// ── 13 项新功能（A1–D4）─────────────────────────────────────────────────────
{
  const lex = internals.LEX

  // A1 大纲导航
  check('A1 大纲按标题序号跳转（不依赖行号）', /querySelectorAll\('\.dshgn_h'\)/.test(source))
  check('A1 大纲缩进随层级', /Math\.max\(0, item\.level - 1\) \* 12/.test(source))

  // A2 关联笔记
  check('A2 关联笔记单独打 /backlinks', /\/backlinks\?path=/.test(source))
  check('A2 关联笔记失败静默不打断阅读', /hits: \[\]/.test(source))

  // A3 搜索增强
  check('A3 搜索有防抖', /220/.test(source))
  check('A3 搜索显示命中次数', /dshgn_hitCount/.test(source))
  check('A3 搜索显示命中行号', /dshgn_matchNo/.test(source))
  check('A3 搜索限定语法有提示', lex.zh['search.hint'] !== undefined && lex.zh['search.hint'].indexOf('tag:') >= 0)

  // A4 快捷新建模板
  check('A4 新建有模板菜单', /dshgn_menu/.test(source) && /templatesOpen/.test(source))
  check('A4 四种模板', /id: 'daily'/.test(source) && /id: 'book'/.test(source) && /id: 'meeting'/.test(source) && /id: 'note'/.test(source))
  // 模板日期必须走本地时区：toISOString 按 UTC，晚上八点后会给成「明天」
  check('A4 模板日期用本地时区', !/toISOString\(\)\.slice\(0, 10\)/.test(source))

  // B1 单篇同步
  check('B1 单篇推云端', /\/sync\/push-one/.test(source))
  check('B1 单篇拉云端', /\/sync\/pull-one/.test(source))
  check('B1 只对有 note_id 的笔记显示', /current\.noteId/.test(source))

  // B2 冲突比对
  check('B2 冲突页签按需出现', /status\.conflicts > 0/.test(source))
  check('B2 冲突左右并排', /dshgn_diffRow/.test(source) && /dshgn_diffCol/.test(source))
  // 比对默认渲染成 markdown（和笔记/云端页一致），裸文本读起来像配置文件。
  // 想抠空格差异时切「原文」，所以两条路径都必须存在。
  check('B2 比对默认渲染 markdown', /dshgn_diffMd/.test(source) && /diffMode === 'rendered'/.test(source))
  check('B2 比对可切原文', /dshgn_diffBody/.test(source) && /diffMode === 'raw'/.test(source))
  // 留档正文必须优先用 body（已剥掉 frontmatter），否则渲染出一堆 `title: xxx`
  check('B2 优先用剥过 frontmatter 的 body', /detail\.body !== undefined/.test(source) && /detail\.local\.body !== undefined/.test(source))
  // 左右两列的来源必须由 host 的 archiveIsCloud 决定，不能靠名字硬套。
  // 两种留档都真实存在：不带 cloud- 的装本地版，带 cloud- 的装云端版。
  check(
    'B2 用 archiveIsCloud 判断留档是哪一边',
    /detail\.archiveIsCloud === true/.test(source),
  )
  check(
    'B2 左右两列按 archiveIsCloud 分配来源',
    /const localBody = archiveIsCloud \? liveText : archiveText/.test(source) &&
      /const cloudBody = archiveIsCloud \? archiveText : liveText/.test(source),
  )
  check(
    'B2 两侧空态文案与来源对应',
    /sideBlock\(localBody, t\('conflict\.noLocal'\)\)/.test(source) &&
      /sideBlock\(cloudBody, t\('conflict\.noCloud'\)\)/.test(source),
  )

  // B3 仅前台运行
  check('B3 有仅前台运行开关', /foregroundOnly/.test(source))
  // 心跳是承重的：没有它 host 永远认为面板不可见，同步永不触发
  check('B3 面板发心跳', /ping: true/.test(source))
  check('B3 心跳间隔 20 秒', /20000/.test(source))

  // C1 整库导出导入
  check('C1 导出用 a[download] 而非 window.open', /archive\/export/.test(source) && /anchor\.download/.test(source) && !/window\.open\('\/getnote\/archive/.test(source))
  check('C1 导入带模式头', /x-getnote-import-mode/.test(source))
  check('C1 导入两种模式', /rename/.test(source) && /skip/.test(source))

  // C2 版本历史
  check('C2 历史列表与恢复', /\/history\/list/.test(source) && /\/history\/restore/.test(source))
  check('C2 恢复前保留当前版', /keepCurrent/.test(source))
  check('C2 换笔记时清空历史面板', /setHistoryItems\(\[\]\)/.test(source))

  // D1 键盘快捷键
  check('D1 监听 keydown', /addEventListener\('keydown'/.test(source))
  check('D1 Ctrl+K 聚焦搜索', /toLowerCase\(\) === 'k'/.test(source))
  check('D1 Ctrl+N 新建', /toLowerCase\(\) === 'n'/.test(source))
  check('D1 J/K 上下移', /event\.key === 'j'/.test(source) && /event\.key === 'k'/.test(source))
  // 在输入框里按 j 是要打字母，不能当成翻页
  check('D1 输入态不触发快捷键', /isContentEditable/.test(source))

  // D2 批量操作
  check('D2 多选集合用 path 不用索引', /new Set\(\)/.test(source) && /togglePick/.test(source))
  check('D2 批量请求走 /batch', /\/batch/.test(source))
  check('D2 批量删除要确认', /batch\.confirmDelete/.test(source))
  for (const key of ['batch.picked', 'batch.addTag', 'batch.move', 'batch.delete']) {
    check(`D2 文案 ${key} 中英都有`, lex.zh[key] !== undefined && lex.en[key] !== undefined)
  }

  // D3 字号三档
  check('D3 三档字号', /dshgn_mdS/.test(source) && /dshgn_mdL/.test(source))
  check('D3 字号持久化', /dshgn\.textScale/.test(source))
  // 标题字号必须是 em：写死 px 的话正文调到 15px 时二级标题会比正文还小
  check('D3 标题用 em 不用 px', /\.dshgn_h1\{font-size:1\.48em/.test(source) && !/\.dshgn_h2\{font-size:\d+px/.test(source))

  // D4 骨架屏
  check('D4 有骨架屏组件', /dshgn_skRow/.test(source))
  check('D4 骨架屏尊重减少动效', /@media \(prefers-reduced-motion:reduce\)\{\s*\.dshgn_skRow\{animation:none/.test(source))
  check('D4 空列表给新建入口', /empty\.noNotes/.test(source))
}

// ── 刷新按钮的旋转反馈 ────────────────────────────────────────────────────
// 这段踩过一个坑：动画最初绑在「正在请求」这个状态上，而刷新只要几十毫秒，
// 请求一回来动画就被拆掉，用户看到的就是「按钮根本不转」。所以断言分两层：
// ① 动画时长是独立常量、和 CSS 对得上；② 结果揭晓发生在动画结束之后，不是请求返回时。
check('刷新动画有独立的时长常量', /const SPIN_MS = 1400/.test(source))
check('SPIN_MS 与 CSS 动画时长一致', /dshgn_spin 1400ms/.test(source))
check('旋转角度是顺时针 5 圈（1800deg，正角度）', /to\{transform:rotate\(1800deg\)\}/.test(source))
check('旋转角度不是逆时针', !/rotate\(-1800deg\)/.test(source))
check('缓动是先快后慢（ease-out 型）', /cubic-bezier\(\.16,\.84,\.24,1\)/.test(source))
check('转圈状态与请求状态分开（spinning 而不是 running）', /setRefreshState\('spinning'\)/.test(source))
check('请求结果先存进 ref 不直接上色', /refreshOutcome\.current = 'ok'/.test(source) && /refreshOutcome\.current = 'fail'/.test(source))
check('结果在动画播完后才揭晓', /refreshSpinTimer\.current = window\.setTimeout\(\(\) => \{[\s\S]{0,400}setRefreshState\(outcome\)/.test(source))
check('成功色与失败色都已定义', /\.dshgn_iconBtnOk\{color:var\(--dsw-alias-state-success-primary\)\}/.test(source) && /\.dshgn_iconBtnFail\{color:var\(--dsw-alias-state-error-primary\)\}/.test(source))
check('平时与「+」同色（中性灰）', /\.dshgn_head \.dshgn_iconBtn\{color:var\(--dsw-alias-label-tertiary\)\}/.test(source))
check('成功/失败色 5 秒后复原', /setRefreshState\('idle'\)[\s\S]{0,200}\}, 5000\)/.test(source))

// ── 云端知识库筛选行与笔记标题首字对齐 ──────────────────────────────────────
// 卡片标题的左边距 = listBody 6px + 卡片左边框 2px + 卡片内边距 8px = 16px。
// 筛选行不补这个值就会比下面的标题往左凸出，看着像没对齐的悬挂缩进。
check('知识库筛选行左内边距对齐卡片标题', /\.dshgn_topicRow\{[^}]*padding:2px 10px 6px 16px/.test(source))

// 中栏卡片：勾选框绝对定位停在左侧留白里，标题/日期/正文左端对齐。
check('勾选框改为绝对定位不占行内', /\.dshgn_card\[data-pick="true"\] \.dshgn_pickBox\{position:absolute/.test(source))
check('带勾选框的卡片统一留左内边距', /\.dshgn_card\[data-pick="true"\]\{position:relative;padding-left:28px\}/.test(source))
check('笔记卡标注了 data-pick', /'data-pick': 'true'/.test(source))

// 目录与标签排序互不干扰：点标签的排序按钮不能改到目录的顺序。
check('目录排序按钮只写 dirSort 的 setter', /headActions\('dir'/.test(source) && /setDirSort\(next\)/.test(source))
check('标签排序按钮只写 tagSort 的 setter', /headActions\('tag'/.test(source) && /setTagSort\(next\)/.test(source))
check('两个排序源分别独立持久化', /makeSortPref\('dshgn\.sortDir'\)\.write/.test(source) && /makeSortPref\('dshgn\.sortTag'\)\.write/.test(source))

// ── 左栏：排序 / 右键删除 / 新建（第七批）──────────────────────────────────
check('目录与标签各有一套排序状态', /const \[dirSort, setDirSort\] = React\.useState/.test(source) && /const \[tagSort, setTagSort\] = React\.useState/.test(source))
check('两套排序分别存各自的 localStorage 键', /dshgn\.sortDir/.test(source) && /dshgn\.sortTag/.test(source))
check('不再共用一个 sortMode 开关', !/const \[sortMode, setSortMode\]/.test(source) && !/dshgn\.sortMode/.test(source))
check('读取时校验取值合法', /saved === 'name' \|\| saved === 'count' \|\| saved === 'time'/.test(source))
check('三种排序都已实现', /dirSort === 'name'/.test(source) && /dirSort === 'count'/.test(source) && /tagSort === 'name'/.test(source) && /tagSort === 'count'/.test(source))
check('目录排序只依赖 dirSort', /\}, \[tree, dirs, entries, dirSort\]\)/.test(source))
check('标签排序只依赖 tagSort', /\}, \[tagCounts, entries, tagSort\]\)/.test(source))
check('按修改时间排序用目录下最新 mtime', /entry\.mtimeMs > max/.test(source))
check('排序按钮在标题行右侧', /\.dshgn_treeHeadRight\{[^}]*margin-left:auto/.test(source))
check('「+」按钮与标题之间留空隙（不紧贴）', /margin-left:auto/.test(source) && /\.dshgn_treeAdd/.test(source))
check('排序按钮按 kind 取各自的模式与 setter', /const mode = kind === 'dir' \? dirSort : tagSort/.test(source) && /const setMode = kind === 'dir' \? onDirSortChange : onTagSortChange/.test(source))
check('排序按钮循环切换三种模式', /const nextMode = mode === 'time' \? 'name' : mode === 'name' \? 'count' : 'time'/.test(source))
check('目录行绑定了右键菜单', /onContextMenu: \(event\) => openMenu\(event, 'dir', node\.path\)/.test(source))
check('标签也绑定了右键菜单', /onContextMenu: \(event\) => openMenu\(event, 'tag', tag\)/.test(source))
check('右键菜单阻止了浏览器默认菜单', /event\.preventDefault\(\)[\s\S]{0,80}setMenu\(/.test(source))
check('删除/取消是行内按钮，不再是浮层', /const rowMenu = \(\) => \{/.test(source))
check('行内菜单里同时有删除与取消', /dshgn_rowBtn dshgn_rowBtnDanger[\s\S]{0,700}tree\.menuCancel/.test(source))
check('行内菜单的取消只关掉菜单', /title: t\('tree\.menuCancel'\)[\s\S]{0,90}onClick: \(\) => setMenu\(null\)/.test(source))
check('旧的 fixed 浮层已删除', !/\.dshgn_ctxMenu\{/.test(source))
check('目录与标签都接上行内菜单', (source.match(/rowMenu\(\)/g) || []).length >= 2)
check('标签项外包 span，避免 button 套 button', /className: 'dshgn_tagWrap'/.test(source))
check('方向键/右键不再记鼠标坐标', !/setMenu\(\{ kind, name, x:/.test(source))
check('入场动画不再从 opacity:0 起（否则深色栏白闪）', !/@keyframes dshgn_tabIn\{[^}]*opacity/.test(source))
check('入场动画仍是横向滑入', /@keyframes dshgn_tabIn\{\s*from\{transform:translateX\(-16px\)\}/.test(source))
check('入场动画不保留结束态，避免留 transform 影响 fixed 定位', !/animation:dshgn_tabIn[^}]*both/.test(source))
check('点空白处或滚动会关闭菜单', /window\.addEventListener\('scroll', close, true\)/.test(source))
check('删除前有二次确认弹窗', /className: 'dshgn_modalMask'/.test(source) && /className: 'dshgn_modal'/.test(source))
check('确认文案带 {name} 占位并替换', /\.replace\(\s*'\{name\}',\s*confirm\.name/.test(source))
check('确认弹窗的删除键是危险色', /dshgn_btn dshgn_btnDanger[\s\S]{0,200}runDelete/.test(source))
check('新建目录走 /dir/create', /api\('\/dir\/create'/.test(source))
check('删除目录走 /dir/delete', /api\('\/dir\/delete'/.test(source))
check('删除标签走 /tag/delete', /api\('\/tag\/delete'/.test(source))
check('新建标签复用批量加标签接口', /action: 'tag', paths: \[current\.path\], tag: name/.test(source))
check('没有打开的笔记时提示先开一篇', /t\('tree\.tagNeedNote'\)/.test(source))
check('删掉当前目录后回到全部笔记', /if \(activeDir === name\) setActiveDir\(''\)/.test(source))
check('删掉当前标签后清空标签筛选', /if \(activeTag === name\) setActiveTag\(''\)/.test(source))
check('非空目录给的是人话而不是原始错误', /t\('tree\.dirNotEmpty'\)/.test(source))
check('新建输入框回车提交、Esc 取消', /event\.key === 'Enter'\) void runCreate\(\)/.test(source) && /event\.key === 'Escape'\) setCreating\(null\)/.test(source))
check('空目录建完会提示暂时看不见', /tree\.dirCreated/.test(source))

// ── 深蓝区一律白字（第七批）─────────────────────────────────────────────────
check('深色区主文字是纯白', /'--dshgn-deepFg': '#ffffff'/.test(source))
check('深色区二级文字是半透明白', /'--dshgn-deepFg2': 'rgba\(255,255,255,\.86\)'/.test(source))
check('深色区三级文字是更淡的白', /'--dshgn-deepFg3': 'rgba\(255,255,255,\.66\)'/.test(source))
check('白字不再随主题色推导（避免偏成淡绿）', !/'--dshgn-deepFg': hslToHex/.test(source))
check('CSS 默认值同样是纯白', /--dshgn-deepFg:#ffffff/.test(source))

// ── 深蓝填充上的字也必须是白（第八批补）─────────────────────────────────────
// 这四个容器都会把「深色填充」用在自己的按钮/chip 上：主按钮、选中的 chip、
// 选中的知识库、音频播放键。只要哪个容器漏了 --dsw-alias-label-primary-foreground，
// 里面的按钮就会用应用默认前景色——深字压深底，几乎读不出来。
for (const sel of ['.dshgn_pane', '.dshgn_note']) {
  const block = new RegExp(
    `${sel.replace('.', '\\.')}\\{[\\s\\S]*?--dsw-alias-label-primary-foreground:#ffffff[\\s\\S]*?\\}`,
  )
  check(`${sel} 内的深色填充用白字`, block.test(source))
}
check('左栏深蓝底也显式定义了前景色', /--dsw-alias-label-primary-foreground:#08182c/.test(source))
check('每个覆盖 token 的栏都写了前景色', source.match(/--dsw-alias-label-primary-foreground:/g).length >= 4)

// ── 冲突页：选完自动返回 + 「返回」键（第七批）──────────────────────────────
check('选完自动回到冲突主列表', /setDetail\(null\)[\s\S]{0,200}await load\(\)/.test(source))
check('「返回」键有独立文案', /'conflict\.back': '返回'/.test(source))
check('详情页的退出键用「返回」而不是「取消」', /setDetail\(null\), disabled: busy \}, t\('conflict\.back'\)/.test(source))
check('「退回未处理」仍然保留', /t\('conflict\.undo'\)/.test(source))

// ── 组件冒烟：13 项里新增的三个组件 ─────────────────────────────────────────
for (const name of ['ConflictPane', 'ArchiveCard', 'SkeletonPane']) {
  const component = internals[name]
  check(`导出了 ${name}`, typeof component === 'function')
  if (typeof component === 'function') {
    let ok = true
    let detail = ''
    try {
      component({ t: (key) => key, status: null, onError: () => {}, showToast: () => {}, onChanged: () => {} })
    } catch (error) {
      ok = false
      detail = error && error.message ? error.message : String(error)
    }
    check(`${name} 渲染无异常`, ok, detail)
  }
}

// ── 第十一批：三语（zh/en/nl）+ 语言切换（m11946）──────────────────────────
{
  const dicts = internals.LEX
  const locales = Object.keys(dicts)
  check('LEX 有三本字典', locales.length === 3 && locales.includes('zh') && locales.includes('en') && locales.includes('nl'))
  const zhKeys = Object.keys(dicts.zh).sort()
  for (const code of ['en', 'nl']) {
    const keys = Object.keys(dicts[code]).sort()
    const missing = zhKeys.filter((k) => keys.indexOf(k) < 0)
    const extra = keys.filter((k) => zhKeys.indexOf(k) < 0)
    check(`${code} 字典与中文键完全一致`, missing.length === 0 && extra.length === 0, `缺 ${missing.join(',')} 多 ${extra.join(',')}`)
  }
  // 荷兰语的确不是英文照抄：抽查几条必须不同
  check('荷兰语不是英文的复制品', dicts.nl['tab.notes'] !== dicts.en['tab.notes'] && dicts.nl['tab.notes'] === 'Notities')
  check('三本字典都有关键入口文案', ['zh', 'en', 'nl'].every((c) => typeof dicts[c]['panel.title'] === 'string' && dicts[c]['panel.title'] !== ''))
}

check('语言状态是模块级变量（t 是模块闭包）', /let uiLocale = null/.test(source))
check(
  'setUiLocale 只接受三种值',
  /function setUiLocale\(value\) \{[\s\S]{0,200}value === 'zh' \|\| value === 'en' \|\| value === 'nl'/.test(source),
)
check('非法语言值一律当自动', /function setUiLocale[\s\S]{0,300}: null/.test(source))
check('显式语言优先于宿主 locale', /if \(uiLocale !== null\) \{[\s\S]{0,200}LEX\[uiLocale\]/.test(source))
check('取不到才回落中文', /return LEX\.zh\[key\] \|\| key/.test(source))
check('导出了 setUiLocale / activeUiLocale', typeof internals.setUiLocale === 'function' && typeof internals.activeUiLocale === 'function')
{
  const before = internals.activeUiLocale()
  internals.setUiLocale('nl')
  check('setUiLocale 生效', internals.activeUiLocale() === 'nl')
  internals.setUiLocale('de')
  check('不支持的语言回落到自动', internals.activeUiLocale() === null)
  internals.setUiLocale(before)
}
check('GetnotePage 有 locale state', /const \[locale, setLocale\] = React\.useState\(/.test(source))
check('t 跟着 locale 重算', /React\.useMemo\(\(\) => makeT\(\), \[locale\]\)/.test(source))
check('status 回来后以 host 的语言为准', /if \('uiLocale' in statusJson\) setLocale\(statusJson\.uiLocale \|\| null\)/.test(source))
check('设置页拿到 locale 与 setter', /onLocaleChange: setLocale/.test(source))
check('设置页解构了 locale', /const \{ t, status, onSaved, onError, onThemePreview, showToast, locale, onLocaleChange \} = props/.test(source))
check('设置了 LanguageCard', /h\(LanguageCard, \{ t, locale, onSaved, onError, onLocaleChange \}\)/.test(source))
check('语言卡排在主题色之后、备份之前', /h\(ThemeCard[\s\S]{0,400}h\(LanguageCard[\s\S]{0,400}h\(ArchiveCard/.test(source))
check('语言卡把 uiLocale 发给 host', /JSON\.stringify\(\{ uiLocale: next \}\)/.test(source))
check('选完立刻切本地语言（不等刷新）', /onLocaleChange\(next\)[\s\S]{0,120}await onSaved/.test(source))
check('语言胶囊可折行（Nederlands 比中文长）', /\.dshgn_langRow\{[^}]*flex-wrap:wrap/.test(source))
check('导出了 LanguageCard', typeof internals.LanguageCard === 'function')
{
  const { LanguageCard } = internals
  const nodes = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    nodes.push(node)
    if (node.children) walk(node.children)
    if (node.props && node.props.children) walk(node.props.children)
  }
  let out = null
  let err = ''
  try { out = LanguageCard({ t: (k) => k, locale: 'nl', onSaved: () => {}, onError: () => {}, onLocaleChange: () => {} }) } catch (e) { err = e.message }
  check('LanguageCard 渲染无异常', err === '', err)
  walk(out)
  const chipTexts = nodes.filter((n) => n.props && typeof n.props.className === 'string' && n.props.className.indexOf('dshgn_chip') >= 0)
  check('语言卡有四个选项（自动/中/英/荷）', chipTexts.length === 4, `实际 ${chipTexts.length}`)
  const onChips = nodes.filter((n) => n.props && typeof n.props.className === 'string' && n.props.className.indexOf('dshgn_chipOn') >= 0)
  check('当前语言那一项被标为选中', onChips.length === 1)
  check('选项里有 Nederlands', nodes.some((n) => n.children === 'Nederlands' || (n.props && n.props.children === 'Nederlands')))
}

// ── 第十一批：同一条再点一次收起（m11946）──────────────────────────────────
check('openNote 支持 toggle', /const openNote = React\.useCallback\([\s\S]{0,400}async \(path, toggle = false\)/.test(source))
check('toggle 命中同一条就清空', /if \(toggle && current !== null && current\.path === path\) \{[\s\S]{0,160}setCurrent\(null\)/.test(source))
check('openNote 依赖 current（否则永远判成没选中）', /setCurrent\(null\)[\s\S]{0,200}\},\n        \[current\],/.test(source))
check('笔记卡点击传 toggle=true', /void openNote\(entry\.path, true\)/.test(source))
check('内部调用（新建/保存/双链）仍是不收起', !/void openNote\(created\.path, true\)/.test(source) && !/void openNote\(target2\.path, true\)/.test(source))
check('openCloudNote 支持 toggle', /async \(note, toggle = false\)/.test(source))
check('云端 toggle 命中同一条就收起', /if \(toggle && selected !== null && selected\.noteId === note\.noteId\)/.test(source))
check('云端卡片点击传 toggle=true', /void openCloudNote\(note, true\)/.test(source))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
