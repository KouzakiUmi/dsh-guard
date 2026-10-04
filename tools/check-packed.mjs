#!/usr/bin/env node
// 核对实际 tarball，而非仅相信 npm pack 输出的文件清单；只读、不解包写盘。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const names = ['dsh-audit-rollback', 'dsh-auto-review-router']
let expectedVersion
for (const name of names) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'))
  const allowed = new Set(['package.json', ...pkg.files])
  const data = gunzipSync(readFileSync(resolve(root, 'dist', `${name}.tgz`)))
  const seen = new Set()
  let sources = 0
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const prefix = text(345, 155)
    const path = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`
    const size = parseInt(text(124, 12).trim() || '0', 8)
    assert.ok(Number.isSafeInteger(size) && size >= 0, `非法 tar 条目大小: ${path}`)
    const type = text(156, 1)
    const content = data.subarray(offset + 512, offset + 512 + size)
    assert.equal(content.length, size, `截断的 tar 条目: ${path}`)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === '5') continue
    assert.ok(type === '' || type === '0', `不接受链接/扩展 tar 条目: ${path}`)
    assert.ok(path.startsWith('package/') && !path.split('/').includes('..'), `非法包路径: ${path}`)
    const rel = path.slice('package/'.length)
    assert.ok(allowed.has(rel), `非白名单文件: ${name}/${rel}`)
    assert.ok(!seen.has(rel), `重复包条目: ${rel}`)
    seen.add(rel)
    assert.deepEqual(content, readFileSync(resolve(root, 'packages', name, rel)), `产物与源码不同: ${name}/${rel}`)
    if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', '--input-type=module'], { input: content, stdio: ['pipe', 'inherit', 'inherit'] })
      sources++
    }
  }
  assert.deepEqual([...seen].sort(), [...allowed].sort(), `${name}: 实际包文件集合不符`)
  expectedVersion ??= pkg.version
  assert.equal(pkg.version, expectedVersion)
  console.log(`PASS ${name}@${pkg.version}: ${seen.size} 个文件与源码逐字节一致，${sources} 个 JS 语法通过`)
}
assert.equal(readdirSync(resolve(root, 'dist')).filter(name => name.endsWith('.tgz')).length, names.length)
console.log('实际发布包核验全部通过（未安装、未运行插件代码）')
