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

// The decoration and noise real commit logs actually contain.
repo('edge-cases', 'main', [
  ['2026-06-02T09:00:00+00:00', '✨ feat: emoji-prefixed feature'],
  ['2026-06-03T09:00:00+00:00', ':sparkles: feat: shortcode-prefixed feature'],
  ['2026-06-04T09:00:00+00:00', '[FEAT] bracket-tagged feature'],
  ['2026-06-05T09:00:00+00:00', 'FEAT : space before the colon'],
  ['2026-06-06T09:00:00+00:00', 'feat(api)!: breaking change to the api'],
  ['2026-06-07T09:00:00+00:00', 'FEAT: pipes | in | the | subject'],
  ['2026-06-08T09:00:00+00:00', 'fixup! feat: a leftover autosquash marker'],
  ['2026-06-09T09:00:00+00:00', 'Merge pull request #99 from org/feat/squash-merged-work'],
  ['2026-06-10T09:00:00+00:00', 'Revert "Revert \"FEAT: re-landed after a revert\""'],
  ['2026-06-11T09:00:00+00:00', 'FEAT: cherry-picked twice'],
  ['2026-06-11T09:00:00+00:00', 'FEAT: cherry-picked twice'],
  ['2026-06-14T09:00:00+00:00', 'FEAT: Shipped Then Pulled'],
  ['2026-06-16T09:00:00+00:00', 'Revert "FEAT: Shipped Then Pulled"'],
])

cli(['init', work, '--scan', '-y'])
const first = cli(['2026-06', '--no-fetch'])
check('run exits 0', first.code, 0)
// hand-counted from the fixtures above: 20 kept (13 features, 7 fixes),
// 2 dropped (one fixup! marker, one duplicate cherry-pick)
check('change count', /20 changes/.test(first.out), true)
check('feature count', /13 features/.test(first.out), true)
check('drops are reported, not silent', /2 skipped/.test(first.out), true)

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

// --- commit-message edge cases -------------------------------------------
const edge = readFileSync(join(run, 'reports', 'shipped-2026-06.md'), 'utf8')
check('emoji prefix still a feature', /emoji-prefixed feature/.test(edge), true)
check('shortcode prefix still a feature', /shortcode-prefixed feature/.test(edge), true)
check('bracket tag still a feature', /bracket-tagged feature/.test(edge), true)
check('space before colon still a feature', /space before the colon/.test(edge), true)
check('breaking change flagged', /breaking change to the api.*⚠ breaking/.test(edge), true)
check('pipes escaped, table intact', edge.includes('pipes \\| in \\| the \\| subject'), true)
check('fixup! artefact dropped', /leftover autosquash/.test(edge), false)
// squash merges carry the whole change — dropping them would lose real work
check('squash-merge commit kept', /squash-merged-work/.test(edge), true)
check('revert-of-revert kept as a re-land', /re-landed after a revert/.test(edge), true)
check('duplicate cherry-pick collapsed', (edge.match(/cherry-picked twice/g) || []).length, 2)
check('shipped-then-reverted paired', /Shipped then reverted in the same window/.test(edge), true)
check('breaking risk section', /Breaking changes/.test(edge), true)

const bad = cli(['2026-6'])
check('bad period exits non-zero', bad.code, 1)
check('bad period explains itself', /use YYYY-MM/.test(bad.out), true)
check('backwards range rejected', /runs backwards/.test(cli(['2026-07..2026-01']).out), true)
check('unknown flag rejected', cli(['--nope']).code, 1)

const gen = cli(['generate', '2026-06', '--no-fetch'])
check('generate alias works', gen.code, 0)
check('generate alias matches default', /20 changes/.test(gen.out), true)
check('bare generate defaults to this month', cli(['generate', '--no-fetch']).code, 0)
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
check('--version matches package.json', cli(['--version']).out.trim(), pkgVersion)

rmSync(root, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n')
process.exit(failures ? 1 : 0)
