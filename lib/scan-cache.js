/**
 * 全库扫描的短缓存 + 并发去重。
 *
 * 为什么需要它：面板刷新时打的是 `/status` 和 `/tree` 两个请求（一次 Promise.all），
 * 两个 handler 各自 `scanVault(root)` 一遍——同样的目录、同样的文件、读两遍。库小的时候
 * 感觉不出来，几百篇之后每次刷新都要多花一倍时间。而且改名、删标签、批量、读单篇这些
 * 操作也各自先扫一遍全库，一共九处调用点。
 *
 * 三条设计取舍：
 *
 * 1. **并发去重**是主要收益。同一个 root 同时来了三个请求，只跑一次扫描，三个都等那一份。
 *    这一条就干掉了「一次刷新扫两遍」。
 * 2. **短 TTL（1 秒）而不是长缓存**。库是用户用别的编辑器/Obsidian/git 也会改的地方，
 *    缓存太久会出现「文件明明改了、面板还显示旧的」——那比慢更让人不信任。
 *    1 秒足够把同一次刷新里的多个请求合并，又不会让人察觉到延迟。
 * 3. **写操作显式失效**。我们自己写库的时候知道变了，不必等 TTL：写完立刻
 *    `invalidateScan(root)`，下一次读就是新的。
 *
 * 不建持久索引、不落盘：文件永远是唯一真相，这里只是一层内存里的、随时可以扔掉的
 * 加速层。缓存丢了最多多扫一遍，不会出现「索引和文件不一致」。
 */
import { scanVault } from './vault.js'

/** 缓存多久算过期。短到用户感觉不到，长到能把一次刷新的多个请求合并。 */
const TTL_MS = 1000

/** root → { at, promise } */
const cache = new Map()


/**
 * 取一次扫描结果。
 *
 * `{ fresh: true }` 跳过缓存直接重扫（用户点刷新时用：他点刷新就是怀疑看到的是旧的，
 * 这时候还给他缓存等于骗他）。
 */
export async function getScan(root, options = {}) {
  if (typeof root !== 'string' || root === '') return scanVault(root)
  const fresh = options.fresh === true
  const now = Date.now()
  const hit = cache.get(root)
  if (!fresh && hit && now - hit.at < TTL_MS) return hit.promise

  const promise = scanVault(root)
    .then((result) => result)
    .catch((error) => {
      // 扫描失败不能把失败本身缓存住：下一次请求应该重新试，而不是继续拿同一个错误。
      // 只在「失败时这份缓存还是当初那个」的情况下删，避免把别人刚建好的新缓存误删。
      const current = cache.get(root)
      if (current && current.promise === promise) cache.delete(root)
      throw error
    })

  cache.set(root, { at: now, promise })
  return promise
}

/** 我们自己改了库：立刻让缓存失效，下一次读就是新的。 */
export function invalidateScan(root) {
  if (typeof root === 'string' && root !== '') cache.delete(root)
  else cache.clear()
}

/** 测试和「换了库根」这类全局变化用。 */
export function clearScanCache() {
  cache.clear()
}

export { TTL_MS as SCAN_TTL_MS }
