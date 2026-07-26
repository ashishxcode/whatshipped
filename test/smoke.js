#!/usr/bin/env node
/**
 * End-to-end smoke test. Builds throwaway git repos with commits placed at
 * deliberate month edges, runs the CLI against them, and asserts the counts.
 *
 * Run with: npm test
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'whatshipped-test-'))
const work = join(root, 'work')
const run = join(root, 'run')

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : ` — expected ${expected}, got ${actual}`}`)
}

// Month boundaries are evaluated in the local timezone, so the test pins TZ.
// Without this it passes in IST and fails on a UTC runner, or vice versa.
const TZ = 'UTC'

const git = (cwd, args, env = {}) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, TZ, ...env }, stdio: ['ignore', 'pipe', 'ignore'],
  })

// The CLI prints its UI to stderr and report markdown to stdout, so both
// streams matter to a test.
const cli = (args, cwd = run) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, TZ, NO_COLOR: '1' },
  })
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status }
}

function repo(name, branch, commits) {
  const dir = join(work, name)
  execFileSync('mkdir', ['-p', dir])
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  for (const [date, subject] of commits) {
    execFileSync('sh', ['-c', `echo "${subject}" >> "${dir}/log.txt"`])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  }
  const bare = join(root, 'remotes', `${name}.git`)
  execFileSync('git', ['clone', '-q', '--bare', dir, bare])
  git(dir, ['remote', 'add', 'origin', bare])
  git(dir, ['fetch', '-q', 'origin'])
}

console.log(`\nwhatshipped smoke test\n  workspace: ${root}\n`)
execFileSync('mkdir', ['-p', run])

// Month edges are the thing most likely to silently break.
repo('billing-api', 'main', [
  ['2026-05-31T23:50:00+00:00', 'FEAT: excluded, belongs to May'],
  ['2026-06-01T00:30:00+00:00', 'FEAT: included, first minute of June'],
  ['2026-06-10T12:00:00+00:00', 'FEAT: Shared Launch'],
  ['2026-06-12T12:00:00+00:00', 'FIX: patch a thing (#12)'],
  ['2026-06-20T12:00:00+00:00', 'Revert "FEAT: Shared Launch"'],
  ['2026-06-30T23:59:00+00:00', 'FEAT: included, last minute of June'],
  ['2026-07-01T00:10:00+00:00', 'FIX: excluded, belongs to July'],
])
repo('web-dashboard', 'main', [
  ['2026-06-10T09:00:00+00:00', 'FEAT: Shared Launch'],
  ['2026-06-15T09:00:00+00:00', 'chore: update deps'],
  ['2026-06-18T09:00:00+00:00', 'FIX: rotate stale API key'],
])
repo('marketing-site', 'production', [
  ['2026-06-05T09:00:00+00:00', 'migrate: move to new host'],
])

cli(['init', work, '--scan', '-y'])
const first = cli(['2026-06', '--no-fetch'])
check('run exits 0', first.code, 0)
check('change count', /9 changes/.test(first.out), true)
check('feature count', /5 features/.test(first.out), true)

const report = readFileSync(join(run, 'reports', 'shipped-2026-06.md'), 'utf8')
check('May commit excluded', report.includes('belongs to May'), false)
check('July commit excluded', report.includes('belongs to July'), false)
check('June first-minute included', report.includes('first minute of June'), true)
check('June last-minute included', report.includes('last minute of June'), true)
check('cross-service theme found', /\*\*Shared Launch\*\*.*\(2\)/.test(report), true)
check('revert surfaced as a risk', /Reverted \/ restored work/.test(report), true)
check('credential churn surfaced', /credential & rate-limit churn/.test(report), true)
check('non-main live branch used', report.includes('origin/production'), true)

// narrative blocks must survive a regeneration
const edited = report.replace(
  /(<!-- narrative:exec-summary -->)[\s\S]*?(<!-- \/narrative:exec-summary -->)/,
  '$1\nHUMAN WRITTEN SUMMARY\n$2',
)
execFileSync('sh', ['-c', `cat > "${join(run, 'reports', 'shipped-2026-06.md')}"`], { input: edited })
cli(['2026-06', '--no-fetch'])
const after = readFileSync(join(run, 'reports', 'shipped-2026-06.md'), 'utf8')
check('narrative carried over', after.includes('HUMAN WRITTEN SUMMARY'), true)

// a filtered run must not overwrite the full report
cli(['2026-06', '--no-fetch', '--repos', 'billing-api'])
const full = readFileSync(join(run, 'reports', 'shipped-2026-06.md'), 'utf8')
check('full report untouched by filtered run', full.includes('web-dashboard'), true)

const bad = cli(['2026-6'])
check('bad period exits non-zero', bad.code, 1)
check('bad period explains itself', /use YYYY-MM/.test(bad.out), true)
check('backwards range rejected', /runs backwards/.test(cli(['2026-07..2026-01']).out), true)
check('unknown flag rejected', cli(['--nope']).code, 1)
check('--version prints', cli(['--version']).out.trim(), '0.1.0')

rmSync(root, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n')
process.exit(failures ? 1 : 0)
