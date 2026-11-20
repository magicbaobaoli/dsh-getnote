#!/usr/bin/env node
/**
 * 跑全部离线测试。
 *
 * 为什么要有这个脚本：以前每加一个测试文件都得手敲一行 `node test/x.test.mjs`，
 * 六套就是六行，漏一套自己也不知道（CI 里曾经只跑四套，archive / history 长期
 * 没人跑）。这里把清单集中一处，`npm test` 一条命令全跑，并且**任何一套挂了整体
 * 就挂**——不能只看最后一行「N/N passed」。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const SUITES = ['vault', 'sync', 'host', 'client', 'archive', 'history']

function runOne(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'test', `${name}.test.mjs`)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      const lines = out.split(/\r?\n/).filter((line) => line.trim() !== '')
      const last = lines.length > 0 ? lines[lines.length - 1] : ''
      const failed = lines.filter((line) => line.startsWith('FAIL'))
      resolve({ name, code, last, failed, out })
    })
  })
}

const results = []
for (const name of SUITES) {
  process.stdout.write(`${name.padEnd(9)} `)
  const result = await runOne(name)
  results.push(result)
  const ok = result.code === 0
  console.log(ok ? `✓ ${result.last}` : `✗ ${result.last || `exit ${result.code}`}`)
  if (!ok) {
    for (const line of result.failed) console.log(`  ${line}`)
  }
}

const broken = results.filter((result) => result.code !== 0)
const total = results.length
console.log(`\n${total - broken.length}/${total} 套通过`)
if (broken.length > 0) {
  console.log(`失败：${broken.map((result) => result.name).join(', ')}`)
  process.exit(1)
}
