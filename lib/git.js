import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

function git(cwd, args, { quiet = true } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** Find an existing checkout, else clone into config.cloneInto. */
export function resolveRepo(config, name) {
  for (const base of config.searchPaths) {
    const p = join(expand(base), name)
    if (existsSync(join(p, '.git'))) return p
  }
  const dest = join(expand(config.cloneInto), name)
  const url = `git@github.com:${config.org}/${name}.git`
  try {
    execFileSync('git', ['clone', '--quiet', url, dest], { stdio: 'ignore' })
    git(dest, ['remote', 'add', 'upstream', url])
    return dest
  } catch {
    return null
  }
}

const hasRef = (path, ref) => git(path, ['rev-parse', '--verify', '--quiet', ref]) !== null

/**
 * Resolve the live branch, fetching it first. Falls back from upstream/X to
 * origin/X for checkouts that never had an upstream remote configured.
 */
export function resolveBranch(path, wanted, { fetch = true } = {}) {
  const [remote, ...rest] = wanted.split('/')
  const branch = rest.join('/')
  if (fetch) git(path, ['fetch', remote, branch])
  if (hasRef(path, wanted)) return { ref: wanted, fetched: fetch }

  const fallback = `origin/${branch}`
  if (fetch) git(path, ['fetch', 'origin', branch])
  if (hasRef(path, fallback)) return { ref: fallback, fetched: fetch, fellBack: true }

  return null
}

/**
 * Commits that landed on `ref` inside [since, before).
 *
 * Both edges carry an explicit T00:00:00 — git fills a missing time-of-day from
 * the CURRENT clock, which silently leaks commits across the month boundary.
 * --date=short-local keeps the printed date in the same zone git filtered in.
 */
export function commitsInWindow(path, ref, since, before) {
  const out = git(path, [
    'log', ref,
    '--no-merges',
    `--since=${since}T00:00:00`,
    `--before=${before}T00:00:00`,
    '--date=short-local',
    '--format=%cd\x1f%s',
  ])
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [date, subject] = line.split('\x1f')
      return { date, subject }
    })
}
