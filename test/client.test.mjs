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
      textOf(node.type(node.props || {}), out, depth + 1)
    } else {
      textOf(node.children, out, depth + 1)
    }
  }
  return out
}

// 与 textOf 同源，但返回元素节点本身（用于断言 class / 结构）
function flatNodes(node, out = [], depth = 0) {
  if (depth > 24 || node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) flatNodes(child, out, depth + 1)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') flatNodes(node.type(node.props || {}), out, depth + 1)
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
  // 首屏 status 还没回来，列表区应给出「这个目录还没有笔记」而不是空白
  check('空库时列表区给出占位文案', text.includes('这个目录还没有笔记'), text.slice(0, 160))
  check('右侧阅读区给出选笔记引导', text.includes('选一篇笔记'), text.slice(0, 200))
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
    const localTrack = { url: '/getnote/asset?path=' + encodeURIComponent('生活记录/asset/x_1_audio.mp3'), duration: 0, kind: 'local', title: 'x_1_audio.mp3' }
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
    const imgOptions = { assets: [{ kind: 'image', name: '照片.png', path: '生活记录/asset/照片.png' }] }
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
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
