#!/usr/bin/env node
// 接手复核：排除规则、字节保真与影子库隔离必须同时成立。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRoot, captureTree, cleanGitEnv, readBlob, readTreeEntry, toRelPath } from '../lib/snapshot.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-snapshot-safety-'))
after(() => rmSync(TMP, { recursive: true, force: true }))
function fixture(name) {
  const root = join(TMP, name, 'work')
  const stateDir = join(TMP, name, 'state')
  mkdirSync(root, { recursive: true })
  return { root, stateDir }
}
async function entry(options, tree, relPath) {
  const result = await readTreeEntry({ ...options, tree, relPath })
  assert.equal(result.ok, true, result.reason)
  return result
}

test('force 只忽略 gitignore，显式排除表仍必须生效', async () => {
  const options = fixture('force')
  mkdirSync(join(options.root, 'cache'), { recursive: true })
  writeFileSync(join(options.root, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(options.root, 'ignored.txt'), 'included by force')
  writeFileSync(join(options.root, 'cache', 'secret.txt'), 'must stay excluded')
  const cap = await captureTree({ ...options, ignorePolicy: 'force', excludeGlobs: ['/cache/'] })
  assert.equal(cap.ok, true, cap.reason)
  assert.equal((await entry(options, cap.tree, 'ignored.txt')).exists, true)
  assert.equal((await entry(options, cap.tree, 'cache/secret.txt')).exists, false)
})

test('配置热更新：已经进入影子索引的路径后来被排除，不得继续入库', async () => {
  const options = fixture('reexclude')
  mkdirSync(join(options.root, 'cache'), { recursive: true })
  writeFileSync(join(options.root, 'cache', 'secret.txt'), 'initial')
  const before = await captureTree(options)
  assert.equal(before.ok, true, before.reason)
  assert.equal((await entry(options, before.tree, 'cache/secret.txt')).exists, true)
  const after = await captureTree({ ...options, excludeGlobs: ['/cache/'] })
  assert.equal(after.ok, true, after.reason)
  assert.equal((await entry(options, after.tree, 'cache/secret.txt')).exists, false)
})

test('工作区 text/eol/ident 属性不得改变影子 blob 原始字节', async () => {
  const options = fixture('attributes')
  writeFileSync(join(options.root, '.gitattributes'), '*.txt text eol=lf ident\n')
  const bytes = Buffer.from('A\r\n$Id: original $\r\n')
  writeFileSync(join(options.root, 'raw.txt'), bytes)
  const cap = await captureTree(options)
  assert.equal(cap.ok, true, cap.reason)
  const file = await entry(options, cap.tree, 'raw.txt')
  const blob = await readBlob({ ...options, oid: file.oid })
  assert.equal(blob.ok, true, blob.reason)
  assert.deepEqual(blob.buffer, bytes)
})

test('影子目录被 junction/symlink 重定向时拒绝，不得写链接目标', async () => {
  const options = fixture('redirect')
  writeFileSync(join(options.root, 'a.txt'), 'a')
  const outside = join(TMP, 'redirect', 'outside')
  mkdirSync(outside)
  mkdirSync(options.stateDir, { recursive: true })
  symlinkSync(outside, join(options.stateDir, 'shadow'), process.platform === 'win32' ? 'junction' : 'dir')
  const cap = await captureTree(options)
  assert.equal(cap.ok, false, '影子目录重定向必须拒绝')
  assert.deepEqual(readdirSync(outside), [], '重定向目标不得出现任何 Git 元数据')
})

test('stateDir 位于被审计根内时，无论 force 或排除表为空都不得递归纳入自身', async () => {
  const options = fixture('nested-state')
  options.stateDir = join(options.root, '.private-state')
  writeFileSync(join(options.root, 'a.txt'), 'a')
  for (const ignorePolicy of ['git', 'force']) {
    const cap = await captureTree({ ...options, ignorePolicy, excludeGlobs: [] })
    assert.equal(cap.ok, true, cap.reason)
    assert.equal((await entry(options, cap.tree, 'a.txt')).exists, true)
    assert.equal((await entry(options, cap.tree, '.private-state')).exists, false)
  }
})

test('路径范围：拒绝另一卷；合法的双点前缀文件名不是父目录穿越', () => {
  const options = fixture('path-scope')
  assert.equal(toRelPath(options.root, join(options.root, '..notes.txt')), '..notes.txt')
  assert.equal(toRelPath(options.root, join(options.root, '..', 'outside.txt')), null)
  if (process.platform === 'win32') {
    assert.equal(canonicalRoot('D:\\'), 'D:\\')
    assert.equal(toRelPath('D:\\work', 'C:\\outside.txt'), null)
  }
})

test('所有 GIT_* 环境注入都必须剔除，而非只枚举部分改道变量', () => {
  const env = cleanGitEnv({ PATH: 'retained', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: 'outside', GIT_CONFIG_PARAMETERS: "'core.worktree=outside'", GIT_ATTR_SOURCE: 'injected' })
  assert.equal(env.PATH, 'retained')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_ATTR_SOURCE'])
    assert.equal(env[key], undefined, `${key} 必须剔除`)
})
