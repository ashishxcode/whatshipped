#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { addMonth, monthRange } from '../lib/analyze.js'
import {
  GLOBAL_CONFIG, expandHome, findConfig, loadConfig, openCommand, writeConfig,
} from '../lib/config.js'
import { commitsInWindow, resolveBranch, resolveRepo } from '../lib/git.js'
import { Cancelled, closePrompts, confirm, multiSelect, text } from '../lib/prompt.js'
import { renderReport } from '../lib/render.js'
import { configFromScan, scanWorkspace } from '../lib/scan.js'
import { c, isInteractive, log, plural, spinner, sym } from '../lib/ui.js'

const HELP = `
${c.bold('whatshipped')} ${c.grey('— what went live, across every service you run')}

${c.bold('USAGE')}
  whatshipped ${c.grey('[period] [options]')}
  whatshipped generate ${c.grey('[period] [options]')}   ${c.grey('same thing, spelled out')}
  whatshipped init ${c.grey('[dir] [options]')}

${c.bold('PERIOD')}
  ${c.grey('(omitted)')}            the current month
  last                 the previous month
  2026-07              a single month
  2026-01..2026-07     an inclusive range of months

${c.bold('OPTIONS')}
  -o, --out ${c.grey('<file>')}     output path ${c.grey('(default: ./reports/shipped-<period>.md)')}
  -c, --config ${c.grey('<file>')}  config file to use
  -r, --repos ${c.grey('<a,b>')}    only these services
      --no-fetch       skip git fetch, use local refs as-is
      --open           open the report when it is written
      --stdout         print instead of writing a file
  -h, --help           this text
  -v, --version        print the version

${c.bold('SETUP')}
  whatshipped init                 ${c.grey('interactive — scans the current directory')}
  whatshipped init ~/work          ${c.grey('scan somewhere else')}

  ${c.grey('init options')}
    --scan             non-interactive scan, keep everything it finds
    --depth ${c.grey('<n>')}        how deep to look for checkouts ${c.grey('(default: 3)')}
    --org ${c.grey('<name>')}       keep only repos from this GitHub org
    --active-since ${c.grey('<YYYY-MM-DD>')}  ignore repos idle since then ${c.grey('(default: 1 year)')}
    --global           write to ~/.config/whatshipped/config.json
    --force            overwrite an existing config
    -y, --yes          accept every default, no prompts

  ${c.grey('Config lookup: --config, $WHATSHIPPED_CONFIG, ./whatshipped.json walking up,')}
  ${c.grey('then ~/.config/whatshipped/config.json. Paths inside a config resolve')}
  ${c.grey('relative to that config file, so it behaves the same on every machine.')}

${c.bold('NARRATIVE')}
  Executive Summary, Headline Launches and Risks live between
  ${c.grey('<!-- narrative:... -->')} markers and are carried into every future run,
  verbatim. Write the prose once. Empty a block to get the draft back.

${c.bold('PRIVACY')}
  Everything runs locally against your own clones. Nothing is uploaded and
  there is no telemetry. Generated reports do contain commit subjects, repo
  names and PR numbers ${c.grey('— treat them like any internal document.')}
`

const VERSION = () => JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

function parseArgs(argv) {
  const opts = {
    repos: null, fetch: true, open: false, stdout: false,
    force: false, global: false, yes: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') return { help: true }
    else if (a === '-v' || a === '--version') return { version: true }
    else if (a === '-o' || a === '--out') opts.out = argv[++i]
    else if (a === '-c' || a === '--config') opts.config = argv[++i]
    else if (a === '-r' || a === '--repos') opts.repos = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--no-fetch') opts.fetch = false
    else if (a === '--open') opts.open = true
    else if (a === '--stdout') opts.stdout = true
    else if (a === '--force') opts.force = true
    else if (a === '--global') opts.global = true
    else if (a === '--scan') opts.scan = true
    else if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--org') opts.org = argv[++i]
    else if (a === '--depth') opts.depth = Number(argv[++i])
    else if (a === '--active-since') opts.activeSince = argv[++i]
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}\n  run \`whatshipped --help\``)
    else positional.push(a)
  }
  // `generate` is an explicit alias for the default action, so both
  // `whatshipped last` and `whatshipped generate last` read naturally.
  const isGenerate = positional[0] === 'generate'
  opts.command = positional[0] === 'init' ? 'init' : 'report'
  opts.period = opts.command === 'init' ? null : positional[isGenerate ? 1 : 0]
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
    throw new Error(`bad period "${period}"\n  use YYYY-MM, YYYY-MM..YYYY-MM, or "last"`)
  }
  if (b && b < a) throw new Error(`period runs backwards: ${a}..${b}`)
  return [a, b || a]
}

const defaultActiveSince = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

const monthLabel = (ym) => {
  const [y, m] = ym.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`
}

/* ---- init -----------------------------------------------------------------*/

async function runInit(opts) {
  const interactive = isInteractive() && !opts.yes && !opts.scan

  log.title('whatshipped setup')

  // No directory argument means "here" — the directory the command was run
  // from, searched recursively.
  let root = resolve(expandHome(opts.scanDir || process.cwd()))
  if (interactive && !opts.scanDir) {
    root = resolve(expandHome(await text('Directory holding your checkouts?', root)))
  }
  if (!existsSync(root)) throw new Error(`no such directory: ${root}`)

  const depth = Number.isFinite(opts.depth) && opts.depth > 0 ? opts.depth : 3
  const spin = spinner(`scanning ${c.grey(root)} ${c.grey(`(depth ${depth})`)}`)
  const found = scanWorkspace(root, { depth })
  spin.stop()
  if (!found.length) {
    throw new Error(`no git checkouts found under ${root}\n  try another directory, or --depth ${depth + 2}`)
  }
  log.ok(`found ${plural(found.length, 'checkout')} under ${c.grey(root)}`)

  const activeSince = opts.activeSince || defaultActiveSince()
  let candidates = found.filter((r) => (r.lastCommit || '') >= activeSince)
  const idle = found.length - candidates.length
  if (idle) log.item(c.grey(`${plural(idle, 'repo')} skipped as idle since ${activeSince}`))

  const orgs = [...new Set(candidates.map((r) => r.org).filter(Boolean))]
  let org = opts.org
  if (!org && interactive && orgs.length > 1) {
    log.blank()
    log.raw(`  ${c.grey('repos found from:')} ${orgs.join(', ')}`)
    org = await text('Limit to one org? (blank = keep all)', '')
  }
  if (org) candidates = candidates.filter((r) => r.org === org)
  if (!candidates.length) {
    throw new Error(
      `nothing left after filtering\n  loosen it with --active-since 2000-01-01${org ? ', or drop --org' : ''}`,
    )
  }

  let chosen = candidates
  if (interactive) {
    chosen = await multiSelect(
      `Which services belong in the report? ${c.grey(`(${candidates.length} found)`)}`,
      candidates,
      { render: (r) => `${r.name} ${c.grey(`${sym.dot} ${r.branch} ${sym.dot} last commit ${r.lastCommit}`)}` },
    )
    if (!chosen.length) throw new Error('no services selected')
  }

  const config = configFromScan(chosen, { root, org })
  let global = opts.global
  if (interactive && !opts.global) {
    global = !(await confirm(`Save to ${c.bold('./whatshipped.json')}? (no = save globally)`, true))
  }
  const target = writeConfig(config, { global, force: opts.force || opts.yes })

  log.blank()
  log.ok(`config written ${c.grey(sym.arrow)} ${c.bold(target)}`)
  for (const [label, value] of [
    ['org', config.org || c.grey('(mixed — set it by hand)')],
    ['live branch', config.defaultBranch],
    ['services', String(config.repos.length)],
  ]) log.raw(`  ${c.grey(`${label}:`.padEnd(13))}${value}`)
  for (const r of config.repos) {
    log.item(`${r.name}${r.branch ? c.grey(` @ ${r.branch}`) : ''}`)
  }

  log.blank()
  log.raw(`${c.bold('Privacy')} ${c.grey('— everything here stays on this machine')}`)
  log.hint(`${sym.bullet} reads your local clones; the only network calls are \`git fetch\` to your own remotes`)
  log.hint(`${sym.bullet} no telemetry, no analytics, nothing uploaded`)
  log.hint(`${sym.bullet} the config stores repo names and paths; reports contain commit subjects and PR numbers`)
  log.hint(`${sym.bullet} treat generated reports as internal documents before sharing`)

  if (interactive && existsSync(join(process.cwd(), '.git'))) {
    log.blank()
    if (await confirm('Add whatshipped.json and reports/ to .gitignore here?', true)) {
      const gi = join(process.cwd(), '.gitignore')
      const current = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
      const lines = ['whatshipped.json', 'reports/'].filter((l) => !current.includes(l))
      if (lines.length) {
        appendFileSync(gi, `${current && !current.endsWith('\n') ? '\n' : ''}# whatshipped\n${lines.join('\n')}\n`)
        log.ok(`updated ${c.grey(gi)}`)
      } else log.ok('.gitignore already covers them')
    }
  }

  log.blank()
  log.raw(`${c.bold('Next')}  ${c.cyan('whatshipped last')} ${c.grey('— report for last month')}`)
  log.raw(`      ${c.cyan('whatshipped 2026-01..2026-06')} ${c.grey('— a range, month by month')}`)
  log.blank()
  closePrompts()
}

/* ---- report ---------------------------------------------------------------*/

function runReport(opts) {
  const [start, end] = resolvePeriod(opts.period)
  const months = monthRange(start, end)

  const configPath = findConfig(opts.config)
  if (!configPath) {
    throw new Error(
      'no config found\n'
      + `  run ${c.cyan('whatshipped init')} to create one here\n`
      + `  or  ${c.cyan('whatshipped init --global')} for ${GLOBAL_CONFIG}`,
    )
  }
  const config = loadConfig(configPath)

  let entries = config.repos
  if (opts.repos) {
    const missing = opts.repos.filter((n) => !config.repos.some((r) => r.name === n))
    if (missing.length) log.warn(`not in config, ignored — ${missing.join(', ')}`)
    entries = config.repos.filter((r) => opts.repos.includes(r.name))
  }
  if (!entries.length) throw new Error('no services selected')

  const span = start === end ? monthLabel(start) : `${monthLabel(start)} → ${monthLabel(end)}`
  log.title(`whatshipped ${c.grey(sym.dot)} ${span}`)
  log.hint(configPath)
  log.blank()

  const isFeature = (subject) => new RegExp(config.featurePattern, 'i').test(subject)
  const since = `${start}-01`
  const before = `${addMonth(end)}-01`
  const commits = []
  const statuses = new Map()
  const results = []

  const spin = spinner('starting')
  for (const entry of entries) {
    const { name } = entry
    spin.update(`${name} ${c.grey(opts.fetch ? '— fetching' : '— reading')}`)

    const path = entry.path ? expandHome(entry.path) : resolveRepo(config, name)
    if (!path) {
      statuses.set(name, { state: 'no checkout' })
      spin.line(`${c.yellow(sym.warn)} ${name} ${c.grey('— no checkout, and clone failed')}`)
      continue
    }
    const wanted = entry.branch || config.defaultBranch
    const branch = resolveBranch(path, wanted, { fetch: opts.fetch })
    if (!branch) {
      statuses.set(name, { state: `branch "${wanted}" not found`, ref: wanted })
      spin.line(`${c.yellow(sym.warn)} ${name} ${c.grey(`— branch "${wanted}" not found`)}`)
      continue
    }
    const found = commitsInWindow(path, branch.ref, since, before)
      .map((cm) => ({ ...cm, repo: name, feature: isFeature(cm.subject) }))
    commits.push(...found)
    statuses.set(name, { state: 'ok', ref: branch.ref })
    results.push({ name, total: found.length, features: found.filter((f) => f.feature).length, ref: branch.ref })
  }
  spin.stop()

  const nameW = Math.max(0, ...results.map((r) => r.name.length))
  const countW = Math.max(0, ...results.map((r) => String(r.total).length))
  for (const r of results) {
    log.raw(
      `${c.green(sym.tick)} ${r.name.padEnd(nameW)}  `
      + `${String(r.total).padStart(countW)} ${(r.total === 1 ? 'change ' : 'changes')}  `
      + `${c.grey(`${r.features} feat`.padEnd(8))} ${c.grey(r.ref)}`,
    )
  }

  if (!commits.length) {
    log.blank()
    log.warn('no commits in this window')
    log.hint('check the period, and that the live branches in your config are right')
  }

  const featureCount = commits.filter((cm) => cm.feature).length
  const repoNames = entries.map((r) => r.name)

  if (opts.stdout) {
    process.stdout.write(renderReport({ commits, repos: repoNames, months, statuses, previous: null }))
    return
  }

  // A filtered run must never overwrite the full report for the same period.
  const periodLabel = start === end ? start : `${start}_${end}`
  const suffix = opts.repos ? `-${repoNames.join('+').slice(0, 40)}` : ''
  const outPath = resolve(expandHome(
    opts.out || join(process.cwd(), 'reports', `shipped-${periodLabel}${suffix}.md`),
  ))
  const previous = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, renderReport({ commits, repos: repoNames, months, statuses, previous }))

  log.blank()
  log.ok(`${c.bold(String(commits.length))} changes ${c.grey(sym.dot)} ${c.bold(String(featureCount))} features ${c.grey(sym.dot)} ${plural(results.length, 'service')}`)
  log.raw(`  ${c.grey(sym.arrow)} ${c.cyan(outPath)}`)
  if (previous) log.hint('narrative blocks carried over')
  log.blank()

  if (opts.open) {
    const [cmd, args] = openCommand()
    try {
      execFileSync(cmd, [...args, outPath], { stdio: 'ignore' })
    } catch {
      log.hint(`could not open with "${cmd}" — open it yourself`)
    }
  }
}

/* ---- entry ----------------------------------------------------------------*/

try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) console.log(HELP.trim())
  else if (opts.version) console.log(VERSION())
  else if (opts.command === 'init') await runInit(opts)
  else runReport(opts)
} catch (err) {
  log.blank()
  closePrompts()
  if (err instanceof Cancelled) {
    log.hint('cancelled — nothing was written')
    log.blank()
    process.exit(130)
  }
  log.error(err.message)
  log.blank()
  process.exit(1)
}
