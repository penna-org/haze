/**
 * 为已经发布到 npm、但缺少 git tag 或 GitHub Release 的包版本补齐（幂等，可重复执行）。
 *
 * changesets 只为它自己发布的版本创建 tag 与 Release；在本地手动发布的版本（例如首个版本）
 * 不会被补上，这一步在 Release 工作流中每次运行时检查并补齐。
 *
 * 需要：git（已配置推送凭据）、gh（GitHub 托管的运行器自带）、环境变量 GH_TOKEN。
 * `--dry-run` 只打印将要执行的操作。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const dryRun = process.argv.includes('--dry-run')

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function succeeds(command, args) {
  try {
    run(command, args)
    return true
  }
  catch {
    return false
  }
}

/** packages/* 中会发布的包 */
function publicPackages() {
  return readdirSync(join(root, 'packages'))
    .map(dir => join(root, 'packages', dir))
    .filter(dir => existsSync(join(dir, 'package.json')))
    .map(dir => ({
      dir,
      pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    }))
    .filter(({ pkg }) => !pkg.private)
}

async function isOnNpm(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`)
  return response.ok
}

/** CHANGELOG.md 中该版本的段落，作为 Release 说明 */
function releaseNotes(dir, version) {
  const file = join(dir, 'CHANGELOG.md')
  if (!existsSync(file))
    return ''
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${version}`)
  if (start === -1)
    return ''
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1
    ? undefined
    : end).join('\n').trim()
}

let failures = 0
for (const { dir, pkg } of publicPackages()) {
  const tag = `${pkg.name}@${pkg.version}`
  try {
    if (!(await isOnNpm(pkg.name, pkg.version))) {
      console.log(`skip ${tag}: not on npm`)
      continue
    }
    if (!run('git', [
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${tag}`,
    ])) {
      // 打在把 package.json 改成该版本的提交上（需要完整历史），找不到时用当前提交
      const commit = run('git', [
        'log',
        '-n1',
        '--format=%H',
        '-G',
        `"version": "${pkg.version}"`,
        '--',
        join(dir, 'package.json'),
      ]) || 'HEAD'
      if (!dryRun) {
        run('git', ['tag', tag, commit])
        run('git', ['push', 'origin', `refs/tags/${tag}`])
      }
      console.log(`tag ${tag} -> ${commit.slice(0, 7)}`)
    }
    if (!succeeds('gh', ['release', 'view', tag])) {
      const notes = releaseNotes(dir, pkg.version) || `${pkg.name} ${pkg.version}`
      if (!dryRun) {
        run('gh', [
          'release',
          'create',
          tag,
          '--title',
          tag,
          '--notes',
          notes,
          '--verify-tag',
          ...(pkg.version.includes('-')
            ? ['--prerelease']
            : []),
        ])
      }
      console.log(`release ${tag}${dryRun
        ? `\n${notes.replace(/^/gm, '    ')}`
        : ''}`)
    }
  }
  catch (error) {
    failures++
    console.error(`failed ${tag}: ${error.stderr || error.message}`)
  }
}
process.exitCode = failures ? 1 : 0
