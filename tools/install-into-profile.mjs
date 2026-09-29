/**
 * Install dsh-sidebar-chat into a DSH profile.
 *
 * Deliberately not `dsh plugin add`: that runs pnpm, which re-resolves the whole
 * profile over the network. The three things the profile actually needs are done
 * in place and idempotently:
 *
 *   1. link (or copy) the package into the profile's `node_modules`, so both the
 *      Cordis Loader and the client-module scanner can resolve `dsh-sidebar-chat`
 *      from the profile's own resolution base;
 *   2. list it in `dependencies`, so the profile's manifest records where the
 *      package came from;
 *   3. mount one Loader row in the profile's `cordis.patch.yml`, which is the
 *      user layer the profile hot-reloads — so the tab appears without
 *      restarting DSH.
 *
 * The package also ships a bundle patch (`cordis.patch.yml` at its root) for the
 * `dsh.profile.bundles` install route. The two routes are mutually exclusive:
 * both insert the same row id and the Loader rejects a duplicate entry, so this
 * script refuses to run while the package is also listed as a bundle.
 *
 * Usage:
 *   node tools/install-into-profile.mjs [--profile <dir>] [--copy] [--dry-run]
 *   node tools/install-into-profile.mjs --uninstall
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name: the Loader row name, the client module id, and the directory name. */
const PACKAGE_NAME = 'dsh-sidebar-chat'
/** Loader entry id of the mounted row. */
const ENTRY_ID = 'sidebar-chat'
/** A bundle row here would collide with the entry this script inserts. */
const BUNDLE_ROW = PACKAGE_NAME

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const dryRun = flag('--dry-run')
const uninstall = flag('--uninstall')
const copy = flag('--copy')

/** The harness home this deployment actually booted with. */
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** The profile to install into: `$DSH_PROFILE_DIR`, else `<home>/profiles/<name>`. */
const profileDir = resolve(
  option(
    '--profile',
    process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', option('--name', 'desktop')),
  ),
)

/** Prefix a progress line for a dry run. */
const say = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)

/** The comment paragraph introducing the inserted row, kept in sync with removal. */
const ENTRY_COMMENT = [
  '# 侧边栏聊天（dsh-sidebar-chat）：在右侧栏新增一个「聊天」页签。',
  '# host 半提供 /dsh-sidebar-chat/* 路由（模型列表、聊天流、附件、历史），',
  '# client 半注册侧边栏页签类型。想停用：把下面这行的 disabled 改成 true；',
  '# 想彻底移除：跑 node tools/install-into-profile.mjs --uninstall',
].join('\n')

/** The exact patch text this script owns, including its comment header. */
const ENTRY_BLOCK = `${ENTRY_COMMENT}\n- insert:\n    - id: ${ENTRY_ID}\n      name: ${PACKAGE_NAME}\n`

/**
 * Drop our install block, comment paragraph included, from a patch file.
 *
 * Comments may be separated from the entry by a blank line and may sit above or
 * below other entries, so the block is located by the row it inserts and then
 * widened to the contiguous comment paragraph that documents it.
 * @param text - the patch file's contents.
 * @returns the patch without our block, and whether anything was removed.
 */
function dropInstallBlock(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() === `- id: ${ENTRY_ID}`)
  if (at < 0) return { text, removed: false }
  let start = at
  while (start > 0 && /^\s{4,}\S/.test(lines[start - 1])) start -= 1
  if (start > 0 && lines[start - 1].trim() === '- insert:') start -= 1
  while (start > 0 && (lines[start - 1].trim() === '' || /^\s*#/.test(lines[start - 1]))) start -= 1
  let end = at + 1
  while (end < lines.length && /^\s{4,}\S/.test(lines[end])) end += 1
  lines.splice(start, end - start)
  return { text: `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\s*$/, '')}\n`, removed: true }
}

/**
 * Add our install block to a patch file when it is absent.
 * @param text - the patch file's contents.
 * @returns the patch with our block, and whether anything was added.
 */
function addInstallBlock(text) {
  const hasRow = new RegExp(`^\\s*name:\\s*${PACKAGE_NAME}\\s*$`, 'm').test(text)
  const hasId = new RegExp(`^\\s*-\\s*id:\\s*${ENTRY_ID}\\s*$`, 'm').test(text)
  if (hasRow || hasId) return { text, added: false }
  const body = text.replace(/\s*$/, '')
  return { text: `${body}\n\n${ENTRY_BLOCK}`, added: true }
}

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`找不到 profile：${profileDir}（先启动一次 DSH 让它初始化）`)
  process.exit(1)
}
say(`profile: ${profileDir}`)
say(`source:  ${projectRoot}`)

const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
if (bundles.includes(BUNDLE_ROW)) {
  console.error(
    `${BUNDLE_ROW} 已经在 dsh.profile.bundles 里：bundle 层和本脚本插入的 profile 补丁行会各自 insert 同一条目，\n` +
      'Loader 会报 duplicate loader entry id。请二选一 —— 从 bundles 里删掉这个包（推荐，本脚本会补上等价的行），\n' +
      '或者删掉 cordis.patch.yml 里的 sidebar-chat 行，只保留 bundle 挂载。',
  )
  process.exit(1)
}

// ------------------------------------------------------------------ uninstall

if (uninstall) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const { text, removed } = dropInstallBlock(readFileSync(patchPath, 'utf8'))
    if (removed) {
      say('cordis.patch.yml -= sidebar-chat 行')
      if (!dryRun) writeFileSync(patchPath, text)
    } else {
      say('cordis.patch.yml 没有 sidebar-chat 行')
    }
  }
  if (manifest.dependencies?.[PACKAGE_NAME] !== undefined) {
    delete manifest.dependencies[PACKAGE_NAME]
    say(`dependencies -= ${PACKAGE_NAME}`)
    if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  const target = join(profileDir, 'node_modules', PACKAGE_NAME)
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    say(`删除 ${target}`)
    if (!dryRun) rmSync(target, { recursive: true, force: true })
  }
  say('完成。刷新页面即可（client 半随模块系统卸载）。')
  process.exit(0)
}

// ------------------------------------------------------------------ 1. link

const target = join(profileDir, 'node_modules', PACKAGE_NAME)
if (dryRun) {
  say(`会${copy ? '复制' : '软链'}到 ${target}`)
} else {
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    rmSync(target, { recursive: true, force: true })
  }
  if (copy) {
    cpSync(projectRoot, target, {
      recursive: true,
      filter: (source) => !source.includes('/.git') && !source.includes('/node_modules') && !source.includes('/test'),
    })
    say(`已复制到 ${target}`)
  } else {
    symlinkSync(projectRoot, target, 'dir')
    say(`已软链 ${target} → ${projectRoot}`)
  }
}

// ---------------------------------------------------- 2. dependency + 3. row

const dependencySpec = copy ? `file:${target}` : `link:${projectRoot}`
let manifestChanged = false
manifest.dependencies = manifest.dependencies ?? {}
if (manifest.dependencies[PACKAGE_NAME] !== dependencySpec) {
  manifest.dependencies[PACKAGE_NAME] = dependencySpec
  manifestChanged = true
  say(`dependencies += ${PACKAGE_NAME}: ${dependencySpec}`)
} else {
  say(`dependencies 已包含 ${PACKAGE_NAME}`)
}
if (manifestChanged && !dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const patchPath = join(profileDir, 'cordis.patch.yml')
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
const { text: patched, added } = addInstallBlock(patch)
if (added) {
  say(`cordis.patch.yml += ${ENTRY_ID} 行`)
  if (!dryRun) writeFileSync(patchPath, patched)
} else {
  say(`cordis.patch.yml 已包含 ${ENTRY_ID} 行`)
}

say(
  added && !dryRun
    ? '完成。cordis.patch.yml 会被热重载，几秒后刷新页面即可在右侧栏看到「聊天」页签；无需重启 DSH。'
    : '完成。若页签没有立即出现，刷新一次页面；仍未出现时重启 DSH。',
)
