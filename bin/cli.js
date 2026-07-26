#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { addMonth, monthRange } from '../lib/analyze.js'
import {
  expandHome, findConfig, loadConfig, openCommand, writeConfig, writeStarterConfig,
} from '../lib/config.js'
import { configFromScan, scanWorkspace } from '../lib/scan.js'
import { commitsInWindow, resolveBranch, resolveRepo } from '../lib/git.js'
import { renderReport } from '../lib/render.js'

const HELP = `
whatshipped — engineering delivery report across all your services

USAGE
  whatshipped [period] [options]
  whatshipped init [dir] [options]

PERIOD
  (omitted)            the current month
  last                 the previous month
  2026-07              a single month
  2026-01..2026-07     an inclusive range of months

OPTIONS
  -o, --out <file>     output path (default: ./reports/shipped-<period>.md)
  -c, --config <file>  config file to use
  -r, --repos <a,b>    only these services
      --no-fetch       skip git fetch, use local refs as-is
      --open           open the finished report when it is written
      --stdout         print to stdout instead of writing a file
  -h, --help           this text

SETUP — fastest path
  whatshipped init ~/work --scan     scan a directory for git checkouts,
                                         detect each repo's org and live branch,
                                         and write a ready-to-use config
  whatshipped last                   generate last month's report

  init options
    --scan             auto-detect repos instead of writing a blank template
    --org <name>       keep only repos belonging to this GitHub org
    --active-since <YYYY-MM-DD>  skip repos with no commits since then
                                 (default: 12 months ago, with --scan)
    --global           write to ~/.config/whatshipped/config.json
    --force            overwrite an existing config

  Without --scan you get a commented template to fill in by hand.

  Config lookup order: --config, $WHATSHIPPED_CONFIG, ./whatshipped.json
  (walking up from the current directory), then ~/.config/whatshipped/config.json.
  Paths inside a config are resolved relative to that config file, so a config
  committed to a repo behaves identically on every machine.

NARRATIVE
  Executive Summary, Headline Launches and Risks live between
  <!-- narrative:... --> markers. Re-running the command carries whatever you
  wrote there into the new report, verbatim. Empty a block to get a fresh
  seeded draft back on the next run.
`

function parseArgs(argv) {
  const opts = { repos: null, fetch: true, open: false, stdout: false, force: false, global: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') return { help: true }
    else if (a === '-o' || a === '--out') opts.out = argv[++i]
    else if (a === '-c' || a === '--config') opts.config = argv[++i]
    else if (a === '-r' || a === '--repos') opts.repos = argv[++i]?.split(',').map((s) => s.trim())
    else if (a === '--no-fetch') opts.fetch = false
    else if (a === '--open') opts.open = true
    else if (a === '--stdout') opts.stdout = true
    else if (a === '--force') opts.force = true
    else if (a === '--global') opts.global = true
    else if (a === '--scan') opts.scan = true
    else if (a === '--org') opts.org = argv[++i]
    else if (a === '--active-since') opts.activeSince = argv[++i]
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}\n\nrun \`whatshipped --help\``)
    else positional.push(a)
  }
  opts.command = positional[0] === 'init' ? 'init' : 'report'
  opts.period = opts.command === 'init' ? null : positional[0]
  opts.scanDir = opts.command === 'init' ? positional[1] : null
  return opts
}

function resolvePeriod(period) {
  const now = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  if (!period) return [thisMonth, thisMonth]
  if (period === 'last') { const p = addMonth(thisMonth, -1); return [p, p] }
  const [a, b] = period.split('..')
  const ok = (m) => /^\d{4}-\d{2}$/.test(m)
  if (!ok(a) || (b !== undefined && !ok(b))) {
    throw new Error(`bad period "${period}" — use YYYY-MM, YYYY-MM..YYYY-MM, or "last"`)
  }
  if (b && b < a) throw new Error(`period runs backwards: ${a}..${b}`)
  return [a, b || a]
}

function runInit(opts) {
  if (!opts.scan && !opts.scanDir) {
    const target = writeStarterConfig({ global: opts.global, force: opts.force })
    console.log(`wrote ${target}`)
    console.log('\nnext:')
    console.log(`  1. edit ${target} — set "org" and list your services under "repos"`)
    console.log('  2. point "workspace"/"searchPaths" at the directory holding your checkouts')
    console.log('  3. whatshipped last')
    console.log('\ntip: `whatshipped init <dir> --scan` fills all of that in for you')
    return
  }

  const root = resolve(expandHome(opts.scanDir || process.cwd()))
  console.error(`scanning ${root} …`)
  const found = scanWorkspace(root)
  if (!found.length) throw new Error(`no git checkouts found under ${root}`)

  const activeSince = opts.activeSince || defaultActiveSince()
  const config = configFromScan(found, { root, activeSince, org: opts.org })
  if (!config.repos.length) {
    throw new Error(
      `found ${found.length} checkouts but none active since ${activeSince}`
      + (opts.org ? ` for org "${opts.org}"` : '')
      + '\n  loosen it with --active-since 2000-01-01, or drop --org',
    )
  }

  const target = writeConfig(config, { global: opts.global, force: opts.force, root })
  const skipped = found.length - config.repos.length
  console.log(`\nwrote ${target}`)
  console.log(`  org:      ${config.org || '(mixed — set it by hand)'}`)
  console.log(`  branch:   ${config.defaultBranch}`)
  console.log(`  services: ${config.repos.length}${skipped ? ` (${skipped} skipped as inactive since ${activeSince})` : ''}`)
  for (const r of config.repos) console.log(`     - ${r.name}${r.branch ? ` @ ${r.branch}` : ''}`)
  console.log('\nnext: whatshipped last')
}

function defaultActiveSince() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

function runReport(opts) {
  const [start, end] = resolvePeriod(opts.period)
  const months = monthRange(start, end)

  const configPath = findConfig(opts.config)
  if (!configPath) {
    throw new Error(
      'no config found.\n\n'
      + '  run `whatshipped init` to create ./whatshipped.json\n'
      + '  or  `whatshipped init --global` for ~/.config/whatshipped/config.json',
    )
  }
  const config = loadConfig(configPath)
  console.error(`config: ${configPath}`)

  let entries = config.repos
  if (opts.repos) {
    const missing = opts.repos.filter((n) => !config.repos.some((r) => r.name === n))
    if (missing.length) console.error(`warn: not in config, ignored — ${missing.join(', ')}`)
    entries = config.repos.filter((r) => opts.repos.includes(r.name))
  }
  if (!entries.length) throw new Error('no services selected')

  const isFeature = (subject) => new RegExp(config.featurePattern, 'i').test(subject)
  const since = `${start}-01`
  const before = `${addMonth(end)}-01`
  const commits = []
  const statuses = new Map()

  for (const entry of entries) {
    const { name } = entry
    const path = entry.path ? expandHome(entry.path) : resolveRepo(config, name)
    if (!path) {
      console.error(`  ${name} — no checkout found and clone failed, skipping`)
      statuses.set(name, { state: 'no checkout' })
      continue
    }
    const wanted = entry.branch || config.defaultBranch
    const branch = resolveBranch(path, wanted, { fetch: opts.fetch })
    if (!branch) {
      console.error(`  ${name} — branch "${wanted}" not found, skipping`)
      statuses.set(name, { state: `branch "${wanted}" not found`, ref: wanted })
      continue
    }
    const found = commitsInWindow(path, branch.ref, since, before)
      .map((c) => ({ ...c, repo: name, feature: isFeature(c.subject) }))
    commits.push(...found)
    statuses.set(name, { state: 'ok', ref: branch.ref })
    console.error(`  ${name} @ ${branch.ref} — ${found.length} commits`)
  }

  if (!commits.length) {
    console.error('\nno commits found in this window — check the period and the branch names')
  }

  const label = start === end ? start : `${start}_${end}`
  const outPath = opts.stdout
    ? null
    : resolve(expandHome(opts.out || join(process.cwd(), 'reports', `shipped-${label}.md`)))
  const previous = outPath && existsSync(outPath) ? readFileSync(outPath, 'utf8') : null

  const markdown = renderReport({
    commits,
    repos: entries.map((r) => r.name),
    months,
    statuses,
    previous,
  })

  if (opts.stdout) { process.stdout.write(markdown); return }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, markdown)
  console.error(`\ndone → ${outPath}${previous ? '  (narrative carried over)' : ''}`)
  console.error(`      ${commits.length} commits, ${commits.filter((c) => c.feature).length} features`)

  if (opts.open) {
    const [cmd, args] = openCommand()
    try {
      execFileSync(cmd, [...args, outPath], { stdio: 'ignore' })
    } catch {
      console.error(`note: could not open with "${cmd}" — open ${outPath} yourself`)
    }
  }
}

try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) console.log(HELP.trim())
  else if (opts.command === 'init') runInit(opts)
  else runReport(opts)
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
