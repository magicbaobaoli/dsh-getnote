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
// host / vault 源码也读进来：有些约定是跨文件的（比如待办序号口径必须两端一致），
// 只测客户端那一半等于没测。
const hostSource = await readFile(join(here, '..', 'lib', 'index.js'), 'utf8')
const vaultSource = await readFile(join(here, '..', 'lib', 'vault.js'), 'utf8')

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
    '渲染出五个 tab（笔记/云端/冲突/录音卡/设置）',
    text.includes('笔记') && text.includes('云端') && text.includes('冲突') && text.includes('录音卡') && text.includes('设置'),
    text.slice(0, 120),
  )
  // 同步不再是独立页签，收进了设置页（自动同步是「设一次就不管」的东西，
  // 不该占一个一级入口）。
  check('「同步」不再是一级页签', !/tabButton\('sync'/.test(source))
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
    // 收进设置页之后不能再自带一层 dshgn_pane / dshgn_cardBox：
    // 外层已经给了内边距和滚动区，重复套会让这张卡看起来不像旁边那一伙的，
    // 而且会多出一条独立的滚动条。
    const ownPane = nodes.filter((n) => typeof n.props.className === 'string' && /dshgn_(pane|cardBox)\b/.test(n.props.className))
    check('同步卡不自带 pane/cardBox（由设置页提供）', ownPane.length === 0, String(ownPane.length))
    check('同步卡自己就是一张 section', nodes.some((n) => n.props.className === 'dshgn_section'))
  }

  // ── 「同步」收进「设置」页 ────────────────────────────────────────────────
  // 自动同步是「设一次就不管」的东西，占一个一级入口不划算。收进设置页后
  // 有两件事必须成立：① 设置页真的把 SyncPane 渲染出来了；② 位置紧跟云端
  // 接入卡——「用哪条通道连云端」和「多久自动拉一次」是同一件事的两半。
  {
    check('设置页挂上 SyncPane', /h\(SyncPane,\s*\{/.test(source))
    const cloudIdx = source.indexOf('h(CloudCredCard,')
    const syncIdx = source.indexOf('h(SyncPane,')
    const themeIdx = source.indexOf('h(ThemeCard,')
    check(
      '同步卡紧跟云端接入卡（在主题色之前）',
      cloudIdx !== -1 && syncIdx !== -1 && themeIdx !== -1 && cloudIdx < syncIdx && syncIdx < themeIdx,
      `${cloudIdx} < ${syncIdx} < ${themeIdx}`,
    )
    check('同步卡的改动走静默刷新（不弹 toast）', /onChanged:\s*onSyncChanged/.test(source))
    check('面板把 onSyncChanged 传给设置页', /onSyncChanged:\s*async\s*\(\)\s*=>\s*\{/.test(source))
    check('body 里不再有 sync 分支', !/tab === 'sync'/.test(source))

    if (typeof internals.SettingsPane === 'function' && typeof SyncPane === 'function') {
      let pane = null
      try {
        pane = internals.SettingsPane({
          t: tKey,
          status: {
            settingsPath: 'C:/x/dsh-getnote.json',
            vaultRoot: 'D:/vault',
            suggestions: [],
            api: { configured: true, lastRunAt: null },
            cloud: { loggedIn: false, expired: false },
            autoSync: { enabled: false, minutes: 15, incremental: true, running: false, lastResult: null, lastError: null },
            vaultMissing: null,
            notes: 3,
            dirs: 1,
            bytes: 100,
            authPath: 'C:/x/auth.json',
          },
          onSaved: async () => {},
          onError: () => {},
          showToast: () => {},
          onSyncChanged: async () => {},
        })
        check('设置页渲染无异常（含同步卡）', true)
      } catch (error) {
        check('设置页渲染无异常（含同步卡）', false, String(error && error.message))
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
      check('设置页里出现了自动同步开关', toggle !== undefined)
      check('收进设置后自动同步仍然默认关', toggle !== undefined && toggle.props['data-on'] === 'false', toggle && String(toggle.props['data-on']))
    }
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
    check('冲突页签在页签行里始终存在', /tabButton\('cloud'[\s\S]{0,600}tabButton\(\s*'conflict'[\s\S]{0,600}tabButton\('settings'/.test(source))
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
      // 深色分支里这两档正好反过来（暗底上 pale 要更沉才浮得出来），
      // 所以只取浅色那一套：取最后一次匹配。
      const pales = [...source.matchAll(/'--dshgn-btnFillPale':\s*hslToHex\(hue,\s*([\d.]+),\s*([\d.]+)\)/g)]
      const softs = [...source.matchAll(/'--dshgn-btnFillSoft':\s*hslToHex\(hue,\s*([\d.]+),\s*([\d.]+)\)/g)]
      if (pales.length === 0 || softs.length === 0) return false
      const pale = pales[pales.length - 1]
      const soft = softs[softs.length - 1]
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
    check(
      'ThemeCard 接收 onPreview 回调',
      /const\s*\{[^}]*\bonPreview\b[^}]*\}\s*=\s*props/.test(source) && /function ThemeCard\b/.test(source),
    )
    check('草稿变化时调用 onPreview', /onPreview\(draft\)/.test(source))
    check('离开设置页清掉预览色', /onPreview\(null\)/.test(source))
    check('SettingsPane 把预览回调传下去', /onThemePreview/.test(source))
    check('面板根节点状态里有 themePreview', /const\s*\[themePreview,\s*setThemePreview\]\s*=\s*React\.useState\(null\)/.test(source))
    check(
      '预览色优先于已保存色',
      /themePreview\s*!==\s*null\s*\?\s*themePreview\s*:\s*status\s*!==\s*null\s*\?\s*status\.themeColor\s*:\s*null/.test(source),
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
    check('预览条走 themeVars(active) 实时算色', /themeVars\(active,\s*dark\s*===\s*true\)/.test(source))
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

  // 自定义模板：内置四个之外，用户能自己攒骨架
  check('自定义模板：新建菜单读 status.templates', /status\.templates/.test(source))
  check('自定义模板：菜单项带 custom 标记', /custom: true/.test(source))
  check('自定义模板：id 用 custom: 前缀区分内置', /custom:\$\{item\.name\}/.test(source) && /id\.startsWith\('custom:'\)/.test(source))
  check('自定义模板：显示用户自己起的名字而不是查译文', /item\.custom \? item\.id\.slice\('custom:'\.length\)/.test(source))
  check('自定义模板：设置页有 TemplateCard', /function TemplateCard\(props\)/.test(source) && /h\(TemplateCard, \{ t, status, onSaved, onError \}\)/.test(source))
  check('自定义模板：草稿模式（改完点保存才提交）', /const dirty = draft !== null/.test(source))
  check('自定义模板：整组替换提交而不是逐项合并', /JSON\.stringify\(\{ templates: draft !== null \? draft : \[\] \}\)/.test(source))
  check('自定义模板：同名覆盖而不是塞两项', /list\.filter\(\(item\) => item\.name !== trimmed\)\.concat/.test(source))
  check('自定义模板：上限 12', /setDraft\(next\.slice\(0, 12\)\)/.test(source) && /list\.length >= 12/.test(source))
  check('自定义模板：删掉一个按钮走 remove', /const remove = React\.useCallback/.test(source))
  check('自定义模板：三语都有 customHint', lex.zh['new.customHint'] !== undefined && lex.en['new.customHint'] !== undefined && lex.nl['new.customHint'] !== undefined)
  check('自定义模板：三语文案键齐全', ['settings.templateTitle', 'settings.templateSave', 'settings.templateEmpty', 'settings.templateRemove'].every((k) => lex.zh[k] !== undefined && lex.en[k] !== undefined && lex.nl[k] !== undefined))

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

// ── P0：首屏合并成一次请求 + 扫描缓存 ──────────────────────────────────────
// 之前一次刷新是 Promise.all([api('/status'), api('/tree')])，两个 handler 各扫
// 一遍全库；篇数上千时刷新会明显卡。现在只打一个 /bootstrap。
check('首屏只打一个 /bootstrap', /api\('\/bootstrap' \+ suffix\)/.test(source))
check('首屏不再同时打 status 和 tree', !/Promise\.all\(\[api\('\/status'\), api\('\/tree'\)\]\)/.test(source))
check('/bootstrap 的 status 从响应的 status 字段取', /bootJson\.status \? bootJson\.status : \{\}/.test(source))
check('树/条目/目录仍从顶层字段取', /setTree\(treeJson\.tree \|\| null\)/.test(source) && /setEntries\(Array\.isArray\(treeJson\.entries\)/.test(source) && /setDirs\(Array\.isArray\(treeJson\.dirs\)/.test(source))

// 只有「用户点刷新」才带 fresh=1：用户点刷新就是因为怀疑看到的是旧的，
// 这时候还给他 1 秒内的缓存等于骗他。其余路径（保存后、删完、同步后）走缓存。
check('刷新按钮带 fresh=1（绕过扫描缓存）', /onClick: \(\) => \{ void refresh\(\{ fresh: true \}\) \}/.test(source))
check('refresh 接受 fresh 选项', /const refresh = React\.useCallback\(async \(options = \{\}\) => \{/.test(source))
check('fresh 只在明确为 true 时生效', /options\.fresh === true/.test(source))
check('内部调用仍走缓存（不传 fresh）', (source.match(/void refresh\(\)/g) || []).length >= 3)

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

// ── 对齐移动端：标签改名 + 写作热力图 ─────────────────────────────────────
{
  // 标签改名：右键标签行 → 行内输入框（不弹窗，因为要边看原名边打字）
  check('标签行右键菜单里有「改名」', /'tree\.menuRename': '改名'/.test(source))
  check('目录不提供改名（目录名就是磁盘文件夹名）',
    /target\.kind === 'tag' && typeof onRenameTag === 'function'/.test(source))
  check('改名用行内输入框而不是弹窗', /const \[renaming, setRenaming\] = React\.useState\(null\)/.test(source))
  check('改名输入框按 Enter 提交', /if \(event\.key === 'Enter'\) void runRename\(\)/.test(source))
  check('改名输入框按 Escape 放弃', /if \(event\.key === 'Escape'\) setRenaming\(null\)/.test(source))
  check('改名调 /tag/rename', /api\('\/tag\/rename'/.test(source))
  check('改名后跟着旧标签筛的那一栏跟过去',
    /if \(activeTag === from\) setActiveTag\(to\)/.test(source))
  check('改名后有反馈文案', /t\('tree\.tagRenamed'\)/.test(source))

  // 写作热力图：挂在左栏「全部笔记」下面
  check('左栏挂了热力图', /h\(HeatmapStrip, \{ t, heatmap/.test(source))
  check('热力图在「全部笔记」之后、目录区之前',
    /t\('tree\.all'\)[\s\S]{0,1600}h\(HeatmapStrip[\s\S]{0,1600}t\('tree\.dirs'\)/.test(source))
  check('热力图只画 16 周（左栏窄）', /const WEEKS = 16/.test(source))
  check('热力图用五档而不是连续色阶', /if \(count <= 4\) return 3/.test(source))
  check('未来日期标出来（不能画成「写了 0 篇」）', /'data-future': day\.future === true/.test(source))
  check('热力图有 title 文案', /'heat\.title': '写作热力图'/.test(source))
  check('热力图有连续天数文案', /'heat\.streak': '天连续'/.test(source))

  // ── P3：热力图可点、保鲜度、关系图、相关推荐 ─────────────────────────────
  check('热力图格子是可点的 button', /days\.map\(\(day\) =>\s*h\('button', \{/.test(source))
  check('空格子与未来日期不可点（点了只会得到空列表）',
    /disabled: day\.future === true \|\| day\.count === 0/.test(source))
  check('点格子回传日期', /onPickDate\(day\.date\)/.test(source))
  check('左栏挂了保鲜度条', /className: 'dshgn_stale'/.test(source))
  check('保鲜度条只在有落灰笔记时出现', /freshness\.staleCount > 0/.test(source))
  check('点保鲜度条进「只看落灰」', /setStaleOnly\(true\)/.test(source))
  check('落灰集合来自 status.freshness.stale', /status\.freshness\.stale/.test(source))
  check('按日期筛走 entry.date', /activeDate !== '' && entry\.date !== activeDate/.test(source))
  check('筛选状态有可关闭的提示条', /className: 'dshgn_filterBar'/.test(source))
  check('清除筛选同时清日期与落灰', /setActiveDate\(''\)[\s\S]{0,80}setStaleOnly\(false\)/.test(source))
  check('有「关系图」页签', /tabButton\('graph', t\('tab\.graph'\)\)/.test(source))
  check('关系图页签在录音卡之前', source.indexOf("tabButton('graph'") < source.indexOf("tabButton('card'"))
  check('body 里有 graph 分支', /tab === 'graph'/.test(source))
  check('关系图点节点会跳回笔记页并打开', /setTab\('notes'\)[\s\S]{0,80}openNote\(path\)/.test(source))
  check('关系图拉 /graph', /\/graph\?limit=400/.test(source))
  check('关系图节点半径按连接数放大', /4 \+ Math\.min\(9,/.test(source))
  check('关系图边高亮跟随悬停', /hover === edge\.source \|\| hover === edge\.target/.test(source))
  // 关系图改成逐帧排版：以前一帧跑完 120 次全对全，节点一多主线程就卡死。
  check('关系图逐帧排版（requestAnimationFrame）', /requestAnimationFrame\(tick\)/.test(source))
  check('关系图排版有进度条', /dshgn_graphProgressBar/.test(source))
  check('关系图滚轮缩放用原生监听（passive:false）', /addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(source))
  check('关系图拖拽平移', /dragRef\.current = \{\s*\r?\n?\s*x: event\.clientX/.test(source))
  // 惯性滑行：松手后视图继续滑一段。这几个断言护住的是「手感」而不是「有没有」——
  // 曾经最容易写错的三处：按帧衰减（帧率一高滑更远）、dt 不夹上限（切窗口回来瞬移）、
  // 松手前按住不动还继续甩。
  check('关系图有惯性滑行 startInertia', /const startInertia = \(vx0, vy0\) =>/.test(source))
  check('惯性按时间指数衰减（不是每帧乘定值）', /Math\.exp\(-dt \/ TAU\)/.test(source))
  check('惯性 dt 夹了上限（切窗口回来不瞬移）', /Math\.min\(48, Math\.max\(1, now - last\)\)/.test(source))
  check('惯性有静止阈值', /Math\.hypot\(vx, vy\) < MIN/.test(source))
  check('惯性帧可被取消', /cancelAnimationFrame\(inertiaRef\.current\)/.test(source))
  check('组件卸载时停掉惯性', /React\.useEffect\(\(\) => stopInertia, \[stopInertia\]\)/.test(source))
  check('按下即停惯性（甩完再按住不窜回去）', /stopInertia\(\)\s*\r?\n\s*movedRef\.current = false/.test(source))
  check('滚轮缩放先停惯性', /event\.preventDefault\(\)[\s\S]{0,200}stopInertia\(\)/.test(source))
  check('拖拽速度走低通滤波', /drag\.vvx = drag\.vvx \* 0\.72 \+/.test(source))
  check('松手前静止会衰减掉惯性', /Math\.exp\(-idle \/ 90\)/.test(source))
  check('惯性速度有上限', /const MAX = 2\.6/.test(source))
  check('轻点一下不启动惯性', /!movedRef\.current \|\| Math\.hypot\(vx, vy\) < 0\.06/.test(source))
  check('拖完松手不误触打开笔记', /if \(movedRef\.current\) return\s*\r?\n\s*onOpenNote\(node\.path\)/.test(source))
  check('拖动态用 state 驱动光标', /cursor: dragging \? 'grabbing' : 'grab'/.test(source))
  check('pointerCancel 不甩出去', /onPointerCancel: \(\) => \{[\s\S]{0,200}setDragging\(false\)/.test(source))
  check('关系图有缩放与复位按钮', /graph\.zoomIn/.test(source) && /graph\.reset/.test(source))
  check('关系图悬停淡出不相邻节点', /'data-dim': dim \? 'true' : 'false'/.test(source))
  check('关系图渲染节点标签', /className: 'dshgn_graphLabel'/.test(source))
  check('关系图标签数受限于节点规模（多了只标枢纽）', /const labelAll = layout !== null && layout\.nodes\.length <= 22/.test(source))
  check('GraphPane 已导出（测试要用）', /\n      GraphPane,/.test(source))
  check('打开笔记时拉相关推荐', /\/related\?path=/.test(source))
  check('相关推荐渲染在反查引用之后',
    source.indexOf("t('note.backlinks')") < source.indexOf("t('related.title')"))
  check('相关推荐失败静默降级', /setRelated\(\{ hits: \[\] \}\)/.test(source))
  for (const key of ['tab.graph', 'filter.date', 'filter.stale', 'filter.clear', 'graph.title', 'graph.desc', 'graph.empty', 'graph.loading', 'graph.nodes', 'graph.edges', 'related.title', 'related.byDir', 'heat.stale', 'heat.staleHint']) {
    const hits = source.split("'" + key + "':").length - 1
    check('文案 ' + key + ' 三语齐全', hits === 3)
  }
  check('热力图数据来自 /status', /heatmap: status !== null && status\.heatmap \? status\.heatmap : null/.test(source))
  check('热力图格子用 grid 按列铺', /\.dshgn_heatGrid\{display:grid;grid-auto-flow:column/.test(source))
  check('热力图有 future 的虚线样式', /\.dshgn_heatCell\[data-future="true"\]/.test(source))

  // 组件冒烟
  const strip = internals.HeatmapStrip
  check('导出了 HeatmapStrip', typeof strip === 'function')
  if (typeof strip === 'function') {
    let ok = true
    let detail = ''
    try {
      strip({ t: (key) => key, heatmap: null })
      strip({
        t: (key) => key,
        heatmap: {
          days: Array.from({ length: 28 }, (_, i) => ({ date: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, count: i % 5, future: false })),
          total: 12,
          streak: 3,
          best: 4,
        },
      })
    } catch (error) {
      ok = false
      detail = error && error.message ? error.message : String(error)
    }
    check('HeatmapStrip 渲染无异常（空数据也不炸）', ok, detail)
  }
}

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

// ── 录音卡直连（本地 BLE）：页签、组件、安全开关 ──────────────────────────
{
  check('有录音卡页签', /tabButton\('card', t\('tab\.card'\)\)/.test(source))
  check('录音卡页签在设置左边', /tabButton\('card'[\s\S]{0,200}tabButton\('settings'/.test(source))
  check('body 有 card 分支', /tab === 'card'[\s\S]{0,120}h\(CardPane/.test(source))
  check('导出了 CardPane', typeof internals.CardPane === 'function')

  const cardKeys = [
    'card.title', 'card.desc', 'card.envOk', 'card.envMissing', 'card.envHint',
    'card.scan', 'card.scanning', 'card.scanFound', 'card.scanNone',
    'card.pending', 'card.refresh', 'card.none', 'card.dir', 'card.dirHint',
    'card.deleteAfter', 'card.deleteAfterHint', 'card.import', 'card.importing',
    'card.imported', 'card.log', 'card.downloaded', 'card.skipped', 'card.failed',
    'card.alreadyRunning', 'card.needPython', 'tab.card',
  ]
  for (const key of cardKeys) {
    check(`录音卡文案 ${key} 三语齐全`, ['zh', 'en', 'nl'].every((loc) => typeof internals.LEX[loc][key] === 'string'))
  }

  // 安全线：删原件必须默认关闭，且开关文案要写明不可恢复。
  check('删原件开关默认关闭', /useState\(false\)[\s\S]{0,80}setDeleteAfter|setDeleteAfter\] = React\.useState\(false\)/.test(source))
  check('删原件前要二次确认', /window\.confirm\([\s\S]{0,80}永久删/.test(source))
  check('删原件提示写了不能恢复', /不能恢复/.test(internals.LEX.zh['card.deleteAfterHint']))
  check('删原件默认不动卡片的说明', /默认不动卡片/.test(internals.LEX.zh['card.deleteAfterHint']))

  // 桥/端点接线
  check('面板打 /card/env', /api\('\/card\/env'\)/.test(source))
  check('面板打 /card/scan', /api\('\/card\/scan\?timeout=8'\)/.test(source))
  check('面板打 /card/list', /api\('\/card\/list'\)/.test(source))
  check('面板打 /card/status 轮询', /api\('\/card\/status'\)/.test(source))
  check('面板打 /card/import', /api\('\/card\/import'/.test(source))
  check('轮询间隔 1200ms', /\}, 1200\)/.test(source))
  check('环境没就绪时禁用导入', /disabled: running \|\| !ready/.test(source))

  let ok = true
  let detail = ''
  try {
    internals.CardPane({ t: (key) => key, status: null, onError: () => {}, showToast: () => {}, onChanged: () => {} })
  } catch (error) {
    ok = false
    detail = error && error.message ? error.message : String(error)
  }
  check('CardPane 渲染无异常', ok, detail)
}

// ── 录音卡热点快传（WiFi 数据面）────────────────────────────────────────────
{
  const cardBlock = source.slice(source.indexOf('function CardPane'), source.indexOf('function ArchiveCard'))

  // 三个端点必须分开接线：激活失败和「连上了但没找到服务」是两种完全不同的
  // 失败，混成一个动作就没法告诉用户该先动哪里。
  check('热点快传走 /card/wifi-activate', /api\('\/card\/wifi-activate'/.test(cardBlock))
  check('热点快传走 /card/wifi-join', /api\('\/card\/wifi-join'/.test(cardBlock))
  check('热点快传走 /card/wifi-leave', /api\('\/card\/wifi-leave'/.test(cardBlock))
  check('热点快传走 /card/wifi-scan', /api\('\/card\/wifi-scan'/.test(cardBlock))

  // 退出热点必须随时可点：卡片热点没有互联网，用户被困在上面会以为断网。
  check(
    '退出热点按钮不受「没连上」限制',
    /t\('card\.wifiOff'\)[\s\S]{0,80}?disabled: wifiBusy \}/.test(cardBlock) ||
      /onClick: \(\) => void wifiOff\(\)[\s\S]{0,120}?disabled: wifiBusy,/.test(cardBlock),
  )

  // 激活按钮要依赖环境自检结果：没有 Python 时点它只会得到一条看不懂的报错。
  check(
    '开热点按钮依赖环境自检',
    /wifiBusy \|\| !ready/.test(cardBlock),
  )

  // 手动连接是最后一条路（热点名/密码拿不到时），必须有输入框。
  check('有手动热点名输入', /placeholder: t\('card\.wifiSsid'\)/.test(cardBlock))
  check('有手动密码输入', /placeholder: t\('card\.wifiPassword'\)/.test(cardBlock))
  check('空热点名先拦下来', /t\('card\.wifiNeedSsid'\)/.test(cardBlock))

  // 连上之后要能看见「现在挂在哪个网上」——不然用户以为断网。
  check('界面显示当前网络', /wifiNet\.current/.test(cardBlock))
  check('界面显示已连热点', /t\('card\.wifiHotspot'\)/.test(cardBlock))
  check('界面显示开放端口', /t\('card\.wifiPorts'\)/.test(cardBlock))

  // 热点卡片必须排在「卡片上的录音」之前：快路先给人看到。
  check(
    '热点快传排在卡片录音之前',
    cardBlock.indexOf("t('card.wifiTitle')") >= 0 &&
      cardBlock.indexOf("t('card.wifiTitle')") < cardBlock.indexOf("t('card.pending')"),
  )

  const wifiKeys = [
    'card.wifiTitle', 'card.wifiDesc', 'card.wifiAvailable', 'card.wifiGo', 'card.wifiBusy',
    'card.wifiRescan', 'card.wifiOff', 'card.wifiSsid', 'card.wifiPassword', 'card.wifiJoin',
    'card.wifiHotspot', 'card.wifiPorts', 'card.wifiOn', 'card.wifiNoHotspot', 'card.wifiFail',
    'card.wifiNeedSsid',
  ]
  for (const key of wifiKeys) {
    check(`热点快传文案 ${key} 三语齐全`, ['zh', 'en', 'nl'].every((loc) => typeof internals.LEX[loc][key] === 'string'))
  }
  check(
    '荷兰语的热点文案不是英文照抄',
    internals.LEX.nl['card.wifiTitle'] !== internals.LEX.en['card.wifiTitle'],
    `${internals.LEX.nl['card.wifiTitle']} / ${internals.LEX.en['card.wifiTitle']}`,
  )
}

// ── 录音卡状态条（P1）：剩余空间 / MTU / 卡上文件数 ────────────────────────
{
  const cardBlock = source.slice(source.indexOf('function CardPane'), source.indexOf('function ArchiveCard'))

  // 状态要真连上卡才拿得到，所以是「点一下才读」，不能自动跑——否则一打开面板
  // 就去抢手机 App 的 BLE 连接，用户会以为是插件把卡连坏了。
  check('卡片状态走 /card/info', /api\('\/card\/info'\)/.test(cardBlock))
  check('读卡片状态有独立按钮', /t\('card\.statusRead'\)/.test(cardBlock))
  check('读卡片状态时按钮显示进行中', /t\('card\.statusBusy'\)/.test(cardBlock))
  check('读卡片状态依赖环境自检', /infoBusy \|\| !ready/.test(cardBlock))
  check('卡片状态不自动加载（没有挂载即调 loadInfo 的 effect）', !/React\.useEffect\(\(\) => \{\s*void loadInfo\(\)/.test(cardBlock))
  check('界面显示卡上文件数', /t\('card\.statusFiles'\)/.test(cardBlock))
  check('界面显示剩余空间', /t\('card\.statusFree'\)/.test(cardBlock))
  check('界面显示 MTU', /t\('card\.statusMtu'\)/.test(cardBlock))
  check('读失败时显示可读错误', /info\.error \|\| t\('card\.statusFail'\)/.test(cardBlock))
  check('状态卡排在环境自检之后', cardBlock.indexOf("t('card.statusTitle')") > cardBlock.indexOf("t('card.envBridge')"))

  const statusKeys = [
    'card.statusTitle', 'card.statusOk', 'card.statusFail', 'card.statusFiles',
    'card.statusFree', 'card.statusMtu', 'card.statusRead', 'card.statusBusy', 'card.statusHint',
  ]
  for (const key of statusKeys) {
    check(`卡片状态文案 ${key} 三语齐全`, ['zh', 'en', 'nl'].every((loc) => typeof internals.LEX[loc][key] === 'string'))
  }
}

// ── 库文件监听（P1）：心跳比对 vaultVersion，外部改动自动刷新 ───────────────
{
  // host 每次心跳都回 vaultVersion，面板比对到变了就重新拉一次。这条链路是
  // 「在 Obsidian 里改了笔记，面板不用手点刷新」的全部依据。
  check('心跳读取 vaultVersion', /pong\.vaultVersion/.test(source))
  check('首次拿到版本号只记下不刷新', /if \(seen !== null && version !== seen\)/.test(source))
  check('版本号变了就重新拉一次', /version !== seen\) void refreshRef\.current\(\)/.test(source))
  check('心跳用 ref 持有 refresh（避免把 effect 绑到会变的回调上）', /const refreshRef = React\.useRef\(refresh\)/.test(source))
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
check('设置页解构了 locale', /const \{ t, status, onSaved, onError, onThemePreview, showToast, locale, onLocaleChange, onSyncChanged \} = props/.test(source))
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

// ── P2：粘贴 / 拖拽图片 ────────────────────────────────────────────────────
check('编辑器有 DOM 引用（光标位置只有元素自己知道）', /const editorRef = React\.useRef\(null\)/.test(source))
check('textarea 挂了 editorRef', /ref: editorRef,/.test(source))
check('粘贴事件接线', /onPaste: \(event\) => \{/.test(source))
check('粘贴只认 image/*，不吃文字', /item\.kind !== 'file' \|\| !String\(item\.type \|\| ''\)\.startsWith\('image\/'\)/.test(source))
check('粘贴命中图片才 preventDefault', /event\.preventDefault\(\)\n\s*void uploadImage\(file\)/.test(source))
check('dragover 必须 preventDefault（否则浏览器直接打开文件）', /onDragOver: \(event\) => \{[\s\S]{0,120}event\.preventDefault\(\)/.test(source))
check('拖拽落点接线', /onDrop: \(event\) => \{/.test(source))
check('拖拽只处理图片', /if \(String\(files\[i\]\.type \|\| ''\)\.startsWith\('image\/'\)\) images\.push\(files\[i\]\)/.test(source))
check('多图按顺序逐张传（并发会打乱光标位置）', /for \(const file of images\) await uploadImage\(file\)/.test(source))
check('插入的是 Obsidian 双链语法', /const token =[^\n]*!\[\[\$\{saved\.name\}/.test(source))
check('插到光标处而不是末尾', /value\.slice\(0, start\) \+ token \+ value\.slice\(end\)/.test(source))
check('插完光标落在插入内容之后', /el\.setSelectionRange\(start \+ token\.length, start \+ token\.length\)/.test(source))
check('上传走原始字节（不经过 JSON 化的 api）', /body: file,/.test(source))
check('上传带上扩展名 header', /'x-getnote-ext': ext/.test(source))
check('上传路径带当前笔记', /\/getnote\/asset\/upload\?path=\$\{encodeURIComponent\(current\.path\)\}/.test(source))
check('NotePane 解构了 onUploadImage', /onToggleTodo, onUploadImage, onLink, notesForLink \} = props/.test(source))
check('NotePane 收到链选择器 props', /onLink: async \(path, target\) => \{/.test(source))
check('面板把 onUploadImage 传给 NotePane', /onUploadImage: async \(file, ext\) => \{/.test(source))
// 「链」功能：编辑与复制引用之间的链图标 + 笔记选择器
check('链图标按钮存在且绑定 action.link', /title: t\('action\.link'\)/.test(source))
check('链图标夹在编辑与复制引用之间', /title: t\('action\.edit'\)[^]*?title: t\('action\.link'\)[^]*?title: t\('action\.copyRef'\)/.test(source))
check('链选择器渲染', /className: 'dshgn_linkPicker'/.test(source))
check('链选择器可搜索候选笔记', /className: 'dshgn_linkQuery'/.test(source))
check('链选择器排除笔记自己', /if \(p2 === owned\) return false/.test(source))
check('链选择器点击调用 onLink', /if \(typeof onLink === 'function'\) await onLink\(current\.path, np\)/.test(source))
check('面板把 notesForLink 传给 NotePane', /notesForLink: entries,/.test(source))
check('链成功后刷新当前笔记', /await api\('\/link\/create'/.test(source) && /await openNote\(path\)/.test(source))
check('链选择器三语齐全', (source.match(/'link\.title':/g) || []).length === 3)
// 录音卡页居中
check('录音卡页用居中容器', /dshgn_paneInner dshgn_cardPane/.test(source))
check('cardPane 有居中样式', /\.dshgn_cardPane\{max-width:760px;margin:0 auto/.test(source))

// ── P2：云端章节跳转 ──────────────────────────────────────────────────────
check('云端详情合并了 chapters', /chapters: Array\.isArray\(result\.chapters\) \? result\.chapters : \[\]/.test(source))
check('章节区块渲染', /detail\.chapters\.map\(\(chapter, index\) =>/.test(source))
check('章节是一整行按钮（能看出可以点）', /className: 'dshgn_chapter'/.test(source))
check('点章节把秒数塞进 seekTo', /setSeekTo\(\{ seconds: chapter\.startMs \/ 1000, nonce: Date\.now\(\) \}\)/.test(source))
check('AudioPlayer 接受 seekTo', /const \{ t, track, onTimeChange, seekTo \} = props/.test(source))
check('seekTo 变化时写 currentTime', /el\.currentTime = target/.test(source))
check('只给第一条音轨传 seekTo（多轨会一起跳）', /seekTo: index === 0 \? seekTo : null/.test(source))
check('章节没有时间点时不显示时间', /typeof chapter\.startMs === 'number'/.test(source))
check('章节文案三语齐全',
  (source.match(/'cloud\.chapters':/g) || []).length === 3,
  String((source.match(/'cloud\.chapters':/g) || []).length))

// ── 第十一批：同一条再点一次收起（m11946）──────────────────────────────────
check('openNote 支持 toggle', /const openNote = React\.useCallback\([\s\S]{0,400}async \(path, toggle = false\)/.test(source))
check('toggle 命中同一条就清空', /if \(toggle && current !== null && current\.path === path\) \{[\s\S]{0,160}setCurrent\(null\)/.test(source))
check('openNote 依赖 current（否则永远判成没选中）', /setCurrent\(null\)[\s\S]{0,200}\},\n        \[current\],/.test(source))
check('笔记卡点击传 toggle=true', /void openNote\(entry\.path, true\)/.test(source))
check('内部调用（新建/保存/双链）仍是不收起', !/void openNote\(created\.path, true\)/.test(source) && !/void openNote\(target2\.path, true\)/.test(source))
check('openCloudNote 支持 toggle', /async \(note, toggle = false\)/.test(source))
check('云端 toggle 命中同一条就收起', /if \(toggle && selected !== null && selected\.noteId === note\.noteId\)/.test(source))
check('云端卡片点击传 toggle=true', /void openCloudNote\(note, true\)/.test(source))

// ── 第十一批之二：三个界面 bug（m13806）────────────────────────────────────
// ① 长标签名撑破胶囊、字跑到圈外
check('标签胶囊自己截断，不会撑出栏外',
  /\.dshgn_tagRow\{[\s\S]{0,400}max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/.test(source))
check('左栏禁止横向溢出（长内容只能在栏内截断）',
  /\.dshgn_tree\{[\s\S]{0,200}overflow-y:auto;overflow-x:hidden/.test(source))
check('标签外层不会把胶囊顶宽', /\.dshgn_tagWrap\{[\s\S]{0,120}max-width:100%;min-width:0/.test(source))
check('标签区里的改名输入行占满一整行', /\.dshgn_treeTags \.dshgn_treeNew\{width:100%/.test(source))

// ② 点大纲跳转时整个面板往左移、变形
check('大纲跳转只改 host 的 scrollTop，不碰横向',
  /const jumpToHeading = React\.useCallback\(\(index\) => \{[\s\S]{0,900}host\.scrollTo\(\{ top: Math\.max\(0, offset\), behavior: 'smooth' \}\)/.test(source))
check('大纲跳转不再调用 scrollIntoView（会连带滚动外层容器）',
  !/\.scrollIntoView\(/.test(source))
check('三栏外层不滚动，横向也不滚',
  /\.dshgn_body\{flex:1;display:flex;min-height:0;min-width:0;overflow:hidden\}/.test(source))

// ── 待办勾选（对齐移动端）────────────────────────────────────────────────
// 阅读态点方框直接落盘。序号口径必须与 host 侧 toggleTodo 完全一致，
// 否则点第一条却勾了第二条——这是这个功能唯一会「看起来能用其实错」的地方。
if (internals) {
  const { renderBlocks } = internals
  const collectChecks = (nodes, out = []) => {
    for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
      if (node === null || node === undefined || typeof node !== 'object') continue
      if (node.type !== undefined && node.props && typeof node.props.className === 'string' && node.props.className.includes('dshgn_check')) {
        out.push(node)
      }
      collectChecks(node.children, out)
    }
    return out
  }

  const md = ['# 待办', '', '- [ ] 第一条', '- [x] 第二条', '- [ ] 第三条', '', '```', '- [ ] 围栏里的示例', '```', ''].join('\n')

  // 不给回调时：方框只展示，不可点（编辑态/冲突比对就是这种渲染）
  const plain = collectChecks(renderBlocks(md))
  check('不传 onToggleTodo 时也画方框', plain.length === 3, `实际 ${plain.length}`)
  check('不可点时没有 onClick', plain.every((n) => n.props.onClick === undefined))
  check('不可点时没有命中区样式', plain.every((n) => !n.props.className.includes('dshgn_checkHit')))

  // 给回调时：三条可点，序号从 0 起，围栏里的那条不计数
  const picked = []
  const clickable = collectChecks(renderBlocks(md, { onToggleTodo: (i, d) => picked.push([i, d]) }))
  check('可点时三条都是命中区', clickable.length === 3 && clickable.every((n) => n.props.className.includes('dshgn_checkHit')))
  check('可点时带 role=checkbox', clickable.every((n) => n.props.role === 'checkbox'))
  check('已勾的那条 aria-checked=true', clickable[1].props['aria-checked'] === 'true')
  check('未勾的那条 aria-checked=false', clickable[0].props['aria-checked'] === 'false')
  check('围栏里的示例不参与编号（否则会与 host 侧错位）', clickable.length === 3)
  clickable[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
  clickable[1].props.onClick({ preventDefault() {}, stopPropagation() {} })
  check('点第一条传 index=0 且要变成已完成', picked[0][0] === 0 && picked[0][1] === true, JSON.stringify(picked[0]))
  check('点已勾的那条传 index=1 且要变成未完成', picked[1][0] === 1 && picked[1][1] === false, JSON.stringify(picked[1]))
}

check('host 侧有待办勾选路由', /action === 'todo' && parts\[2\] === 'toggle'/.test(hostSource || ''))
check('勾选只翻方框那一个字符，不重建整行',
  /lines\[targetLine\] = `\$\{indent\}\$\{bullet\} \[\$\{wasDone \? ' ' : 'x'\}\] \$\{text\}`/.test(vaultSource || ''))
check('勾选跳过代码围栏里的待办', /if \(inFence\) continue[\s\S]{0,200}TASK\.exec\(line\)/.test(vaultSource || ''))
check('勾选前先留版本快照', /await toggleTodo\(root, path, index, \{[\s\S]{0,120}snapshotNote\(root, rel\)/.test(hostSource || ''))
check('编辑态不给点击回调（改内容要走保存）', /onToggleTodo: editing \? undefined : onToggleTodo/.test(source))
check('勾完重读笔记（否则下次保存会冲掉）', /await openNote\(current\.path\)[\s\S]{0,200}t\('todo\.done'\)/.test(source))

// ── 0.7.1：图标对调 ────────────────────────────────────────────────────────
// 用户要求「链」按钮用链子图标、复制引用改成油漆刷。两者相邻，用同一个图标
// 用户根本分不清哪颗是哪个。
check('ICONS 里有油漆刷', typeof internals.ICONS.paintbrush === 'string' && internals.ICONS.paintbrush.length > 10)
check('ICONS 里仍有链子', typeof internals.ICONS.link === 'string')
check(
  '链按钮用链子图标',
  /title:\s*t\('action\.link'\)[\s\S]{0,400}?name:\s*'link'/.test(source),
)
check(
  '复制引用用油漆刷图标',
  /title:\s*t\('action\.copyRef'\)[\s\S]{0,400}?name:\s*'paintbrush'/.test(source),
)

// ── 0.7.1：「链」弹窗定位 / 拖动 / 点外关闭 / 动画 ─────────────────────────
check('弹窗默认落在阅读区正中（top/left 各 50%）', /\.dshgn_linkPicker\{[^}]*top:50%[^}]*left:50%/.test(source))
check(
  '弹窗的包含块是阅读区（.dshgn_note 有 position:relative）',
  /\.dshgn_note\{[^}]*position:relative/.test(source),
)
check(
  '拖动偏移用 translate 而不是 transform（transform 要留给动画）',
  /translate:\s*`calc\(-50% \+ \$\{linkPos\.x\}px\)/.test(source),
)
check('标题行当拖动手柄', /className:\s*'[^']*dshgn_linkPickerGrip[^']*'/.test(source))
check('手柄上有 pointerdown 起拖', /onPointerDown:\s*startLinkDrag/.test(source))
check(
  '拖动监听挂在 window 上（甩出弹窗也能收到 pointerup）',
  /window\.addEventListener\('pointermove',\s*onMove\)/.test(source) && /window\.removeEventListener\('pointermove',\s*onMove\)/.test(source),
)
check(
  '点弹窗外关闭用捕获阶段 pointerdown',
  /addEventListener\('pointerdown',\s*onDown,\s*true\)/.test(source),
)
check(
  '点「链」按钮本身不算外部点击（否则先关再开像没反应）',
  /closest\('\[data-role="link-toggle"\]'\)/.test(source),
)
check('关闭动画期间继续渲染（否则缩回动画看不到）', /linkOpen \|\| linkClosing/.test(source))
check('弹窗有蹦出/缩回两组 keyframes', /@keyframes dshgn_pickerIn/.test(source) && /@keyframes dshgn_pickerOut/.test(source))
check('关闭态挂 data-closing 驱动出场动画', /'data-closing':\s*linkClosing/.test(source))
check(
  '减少动效时弹窗不做动画',
  /@media \(prefers-reduced-motion:reduce\)[\s\S]{0,400}\.dshgn_linkPicker[^{]*\{animation:none/.test(source),
)

// ── 0.7.1：链弹窗浅蓝配色 ─────────────────────────────────────────────────
check('弹窗底色走 pickerBg 变量', /\.dshgn_linkPicker\{[^}]*background:var\(--dshgn-pickerBg\)/.test(source))
check('搜索框底色走 pickerField 变量', /\.dshgn_linkQuery\{[^}]*background:var\(--dshgn-pickerField\)/.test(source))
check('弹窗描边走 pickerLine 变量', /\.dshgn_linkPicker\{[^}]*border:[^;]*var\(--dshgn-pickerLine\)/.test(source))

// ── 0.7.1：深色模式 ────────────────────────────────────────────────────────
check('themeVars 接收 dark 参数', /function themeVars\(input, dark\)/.test(source))
check(
  '没选主题色时深色模式也要返回一套变量（否则开关打开界面还是白的）',
  /const picked = parseHex\(input\)\s*\n\s*if \(picked === null && !wantDark\) return null/.test(source),
)
check('深色分支有独立的明度层次', /if \(wantDark\) \{/.test(source))
check(
  '深色下三栏明度差足够（mid 明显亮于 light）',
  (() => {
    const darkStart = source.indexOf('if (wantDark) {')
    const darkBlock = source.slice(darkStart, source.indexOf('\n      return {', darkStart))
    const mid = /'--dshgn-mid':\s*hslToHex\(hue,\s*tint\([^)]*\),\s*([\d.]+)\)/.exec(darkBlock)
    const light = /'--dshgn-light':\s*hslToHex\(hue,\s*tint\([^)]*\),\s*([\d.]+)\)/.exec(darkBlock)
    if (mid === null || light === null) return false
    return Number(mid[1]) - Number(light[1]) > 0.05
  })(),
)
check('深色下分隔线改用白色', /'--dshgn-lineOnDark':\s*'rgba\(255,255,255/.test(source))
check('深色下「面」比底色亮（卡片不能用纯黑）', /'--dshgn-surface':\s*hslToHex/.test(source))
check('设置页有深色开关（role=switch）', /role:\s*'switch'/.test(source) && /dshgn_switch/.test(source))
check('深色开关单独一条保存路径', /\/settings',\s*\{[\s\S]{0,200}darkMode: value/.test(source))
check('深色存失败要把开关拨回去', /setDark\(!value\)/.test(source))
check(
  '外部改了深色设置会同步过来（但不动正在编辑的草稿）',
  /if \(draft === null\) setDark\(darkMode === true\)/.test(source),
)

// ── 0.7.1：关系图配色可自定义 ──────────────────────────────────────────────
check('默认关系图色是很浅的蓝', internals.DEFAULT_GRAPH_COLOR === '#9dc6ef', String(internals.DEFAULT_GRAPH_COLOR))
check('graphVars 输出三个层次', (() => {
  if (typeof internals.graphVars !== 'function') return false
  const v = internals.graphVars('#8fd3c7', false)
  return v !== null && typeof v['--dshgn-graphNode'] === 'string' && typeof v['--dshgn-graphEdge'] === 'string' && typeof v['--dshgn-graphNodeOn'] === 'string'
})())
check('graphVars 坏值回落默认而不返回 null', (() => {
  if (typeof internals.graphVars !== 'function') return false
  const v = internals.graphVars('not-a-color', false)
  return v !== null && v['--dshgn-graphNode'] !== undefined
})())
check('关系图连线用 graphEdge 变量', /\.dshgn_graphEdge\{[^}]*stroke:var\(--dshgn-graphEdge\)/.test(source))
check('关系图节点用 graphNode 变量', /\.dshgn_graphDot\{[^}]*fill:var\(--dshgn-graphNode\)/.test(source))
check('关系图高亮用 graphNodeOn 变量', /\.dshgn_graphEdge\[data-on="true"\]\{[^}]*stroke:var\(--dshgn-graphNodeOn\)/.test(source))
check('关系图节点不再用品牌色（用户明确不要）', !/\.dshgn_graphDot\{[^}]*brand-primary/.test(source))
check('设置页有关系图配色色板', /graphPresets\.map/.test(source))

// ── 0.7.1：根 style 同时挂主题与关系图变量 ────────────────────────────────
check('mergeStyles 能合并两组变量', (() => {
  if (typeof internals.mergeStyles !== 'function') return false
  const m = internals.mergeStyles({ a: '1' }, { b: '2' })
  return m !== null && m.a === '1' && m.b === '2'
})())
check('mergeStyles 全 null 时返回 null（让 CSS 默认值生效）', (() => {
  if (typeof internals.mergeStyles !== 'function') return false
  return internals.mergeStyles(null, null) === null
})())
check('面板根节点同时合并主题与关系图变量', /mergeStyles\([\s\S]{0,300}graphVars\(/.test(source))
check('根节点把 darkMode 传给 themeVars', /themeVars\([\s\S]{0,200}darkPreview\)/.test(source))

// ── 0.7.1：检查版本更新 + 应用内升级 ──────────────────────────────────────
check('导出了 UpdateCard', typeof internals.UpdateCard === 'function')
check('设置页顶部就放检查更新', /h\(UpdateCard,[\s\S]{0,300}settings\.vault/.test(source))
check('检查更新走 GET /update/check', /api\('\/update\/check'\)/.test(source))
check('升级走 POST /update/apply', /api\('\/update\/apply',\s*\{\s*method:\s*'POST'\s*\}\)/.test(source))
check('看到新版本才出现下载按钮', /available[\s\S]{0,400}t\('update\.download'\)/.test(source))
check('离线单独提示，不报成「失败」', /t\('update\.offline'\)/.test(source))
check(
  '升级成功只提示重启，不假装已生效',
  /t\('update\.applied'\)/.test(source),
)

// ── 0.7.1：署名 ────────────────────────────────────────────────────────────
check('设置页底部有署名', /className:\s*'dshgn_credit'/.test(source) && /t\('about\.credit'\)/.test(source))
check('署名文案就是 designed by Magicbaobao', internals.LEX.zh['about.credit'] === 'designed by Magicbaobao', internals.LEX.zh['about.credit'])
check('CSS 有署名样式', /\.dshgn_credit\{/.test(source))

// ── 0.7.1：三语文案齐全 ───────────────────────────────────────────────────
for (const key of [
  'link.dragHint', 'dark.title', 'dark.desc', 'dark.on', 'dark.off',
  'graphColor.title', 'graphColor.desc',
  'update.title', 'update.desc', 'update.check', 'update.checking', 'update.current',
  'update.latest', 'update.upToDate', 'update.available', 'update.download',
  'update.applying', 'update.applied', 'update.failed', 'update.offline', 'about.credit',
]) {
  check(`三语文案都有 ${key}`, internals.LEX.zh[key] !== undefined && internals.LEX.en[key] !== undefined && internals.LEX.nl[key] !== undefined)
}


// ── 0.7.2：定时器清理与 ref 化依赖（审计修复） ──────────────────────────
//
// 这批 bug 的共同形态是「父组件每次重渲染都换一个新函数身份，子组件的
// useEffect 依赖它就每次重跑」——表现是每敲一个字就重新拉一遍列表、轮询
// 永远等不到第一拍。这些断言检查的是接线本身，因为接线一断就静默退化成
// 「能跑但一直在做无用功」，肉眼极难发现。
{
  // ① toast 计时器要存住句柄：连弹两条时，第一条的计时会把第二条提前抹掉。
  check('showToast 有独立计时器 ref', /const toastTimer = React\.useRef\(null\)/.test(source))
  check('showToast 建新计时器前先清旧的', /clearTimeout\(toastTimer\.current\)/.test(source))

  // ② 三个反馈计时器（刷新转圈/变色保持/toast）都比「用户停留在此页」活得久，
  //    点完刷新立刻切走就会 setState 到已卸载组件。
  check('有卸载清理 ref 计时器的 effect', /clearTimeout\(refreshTimer\.current\)/.test(source) && /clearTimeout\(refreshSpinTimer\.current\)/.test(source))

  // ③ 四个面板的 load 不能再依赖内联回调身份（否则每次父渲染都重拉整份数据）。
  check('ConflictPane 用 onErrorRef', /onErrorRef\.current\(/.test(source))
  check('CardPane 的 wifiRefresh 用 onErrorRef', /wifiRefresh[\s\S]{0,400}onErrorRef\.current/.test(source))
  check('ImportPane 的轮询用 onRefreshRef', /onRefreshRef\.current\(\)/.test(source))
  check('ImportPane 轮询只依赖 waiting', /\}, \[waiting\]\)/.test(source))
  check('CardPane 轮询开关改成 runActive', /if \(!runActive\)/.test(source))

  // ④ createCloudNote 通过 ref 调 openCloudNote：直接加依赖会撞 TDZ（声明在后），
  //    不调又会拿到旧 selected，可能把另一篇云笔记收起。
  check('createCloudNote 经 ref 调 openCloudNote', /openCloudNoteRef\.current = openCloudNote/.test(source) && /await openCloudNoteRef\.current\(/.test(source))

  // ⑤ 两个 150ms / 1200ms 的收尾计时器也要能清。
  check('closeLink 计时器有 ref', /closeLinkTimer/.test(source))
  check('导出后复原按钮的计时器有 ref', /busyTimer/.test(source))

  // ⑥ copyReference 不能直接点 status.vaultRoot：宿主/客户端版本错配时
  //    status 会退化成 {}，undefined.endsWith 直接抛。
  check('copyReference 先判 vaultRoot 是字符串', /typeof status\.vaultRoot === 'string'/.test(source))

  // ⑦ AudioPlayer 不能假设 track.url 是字符串（它是导出组件，测试/宿主会直接渲染它）。
  check('AudioPlayer 先判 track.url 是字符串', /typeof track\.url === 'string'/.test(source))

  // ⑧ 关系图惯性：松手后继续滑，且能被用户下一次操作立刻止住。
  check('关系图有惯性启动', /startInertia/.test(source))
  check('惯性按时间指数衰减（不同刷新率滑行距离一致）', /Math\.exp\(-dt \/ TAU\)/.test(source))
  check('速度滤波用的是最近一次位移而不是总平均', /drag\.vvx = drag\.vvx \* 0\.72 \+/.test(source))
  check('按住不动再松手不甩出去', /Math\.exp\(-idle \/ 90\)/.test(source))
  check('惯性帧循环可被取消', /cancelAnimationFrame\(inertiaRef\.current\)/.test(source))
  check('拖图路过节点松手不打开笔记', /if \(movedRef\.current\)/.test(source))
  check('拖拽时光标真的会变（靠 state 不是 ref）', /cursor: dragging \? 'grabbing' : 'grab'/.test(source))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
