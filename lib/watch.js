/**
 * 库目录的文件监听。
 *
 * 解决的具体问题：用户在 Obsidian、git、别的编辑器里改了库里的文件，面板不知道，
 * 必须手点刷新才看得见。插件自己写的文件不需要监听（写操作已经显式让扫描缓存
 * 失效了），监听的价值全在「别人改的」这一半。
 *
 * 为什么用 fs.watch 而不是轮询：轮询要么慢（间隔长）要么费（间隔短），
 * 而 fs.watch 在 Windows / macOS 上原生支持 recursive，事件由内核给。
 *
 * 为什么只用来「失效缓存 + 递增版本号」，不直接推送内容：
 * 面板已经有 20 秒一次的心跳，让它顺带比对版本号就够了。真推内容要维护长连接，
 * 而宿主没有给插件一条现成的推送通道。
 */

import { watch } from 'node:fs'

/** 合并短时间内的连续事件：git checkout 一次能触发几百个 rename。 */
const DEBOUNCE_MS = 300

let current = null // { root, watcher, timer }
let version = 0

/** 库内容版本号。每次监听到外部改动就 +1，面板靠它判断「要不要重新拉一次」。 */
export function vaultVersion() {
  return version
}

/** 外部改动计数（测试与排障用）。 */
export function bumpVersion() {
  version += 1
  return version
}

/**
 * 判断这个路径的变动是否值得关心。
 *
 * `.git` 里的东西每 commit 一次就翻一遍，全量失效没有意义；`.trash` 与
 * `.history` 虽然也在库根下，但它们变化时列表本来就不该变（扫描已经跳过这两个目录），
 * 放过它们只会让面板白白多刷几次。
 */
function worthWatching(filename) {
  const rel = String(filename || '')
  if (rel === '') return true
  return !/(^|[/\\])(\.git|node_modules|\.trash|\.history)([/\\]|$)/.test(rel)
}

/**
 * 确保当前监听的是 root 这个目录。
 *
 * 库目录可以在设置里改，所以不能只在 apply 时建一次监听；每次请求路过时
 * 调一次，root 没变就是个字符串比较，变了才重建。
 *
 * @param {string} root 库根绝对路径
 * @param {() => void} onExternalChange 外部改动发生时调用（用来让扫描缓存失效）
 */
export function ensureWatch(root, onExternalChange) {
  if (typeof root !== 'string' || root === '') return
  if (current !== null && current.root === root) return
  stopWatch()
  let watcher = null
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (event, filename) => {
      if (!worthWatching(filename)) return
      if (current === null) return
      if (current.timer !== null) clearTimeout(current.timer)
      current.timer = setTimeout(() => {
        if (current === null) return
        current.timer = null
        // 版本号先加：面板可能在缓存还没失效前就来问，先让它知道「变了」。
        bumpVersion()
        try {
          if (typeof onExternalChange === 'function') onExternalChange()
        } catch {
          // 失效失败不影响监听本身，下一次读最多多扫一遍
        }
      }, DEBOUNCE_MS)
      // 定时器不该拖着进程不退出（测试跑完要能干净结束）
      if (current.timer && typeof current.timer.unref === 'function') current.timer.unref()
    })
    watcher.on('error', () => {
      // 库被删、被移到别的盘、权限变了都会走到这里。静默停掉就好：
      // 没有监听只是「不会自动刷新」，不该让面板报错。
      stopWatch()
    })
    if (typeof watcher.unref === 'function') watcher.unref()
  } catch {
    // 目录不存在 / 平台不支持 recursive：退化成「只能手动刷新」
    watcher = null
  }
  current = { root, watcher, timer: null }
}

export function stopWatch() {
  if (current === null) return
  if (current.timer !== null) clearTimeout(current.timer)
  try {
    if (current.watcher !== null) current.watcher.close()
  } catch {
    // 已经关掉或目录已消失
  }
  current = null
}

/** 测试用：确认当前是否在监听、监听的是哪个目录。 */
export function watchState() {
  return current === null ? null : { root: current.root, watching: current.watcher !== null }
}
