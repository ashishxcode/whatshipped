import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

const GLOBAL_DIR = join(homedir(), '.config', 'whatshipped')
export const GLOBAL_CONFIG = join(GLOBAL_DIR, 'config.json')
const LOCAL_NAME = 'whatshipped.json'

/**
 * Config lookup, first hit wins:
 *   1. --config <file>
 *   2. $WHATSHIPPED_CONFIG
 *   3. ./whatshipped.json, walking up to the filesystem root
 *   4. ~/.config/whatshipped/config.json
 * Nothing is machine-specific until a dev runs `whatshipped init`.
 */
export function findConfig(explicit) {
  if (explicit) {
    const p = resolve(expandHome(explicit))
    if (!existsSync(p)) throw new Error(`config not found: ${p}`)
    return p
  }
  if (process.env.WHATSHIPPED_CONFIG) {
    const p = resolve(expandHome(process.env.WHATSHIPPED_CONFIG))
    if (!existsSync(p)) throw new Error(`WHATSHIPPED_CONFIG points at a missing file: ${p}`)
    return p
  }
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, LOCAL_NAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (existsSync(GLOBAL_CONFIG)) return GLOBAL_CONFIG
  return null
}

export function loadConfig(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`could not parse ${path}: ${err.message}`)
  }
  if (!Array.isArray(raw.repos) || !raw.repos.length) {
    throw new Error(`${path} has no "repos" — add at least one service`)
  }

  // Paths in the config are resolved relative to the config file itself, so a
  // config committed to a repo works the same on every machine.
  const base = dirname(path)
  const abs = (p) => {
    const e = expandHome(p)
    return isAbsolute(e) ? e : resolve(base, e)
  }

  const workspace = abs(raw.workspace || '.')
  const inWorkspace = (p) => {
    const e = expandHome(p)
    return isAbsolute(e) ? e : resolve(workspace, e)
  }
  return {
    org: raw.org || null,
    defaultBranch: raw.defaultBranch || 'origin/main',
    workspace,
    searchPaths: (raw.searchPaths?.length ? raw.searchPaths : ['.']).map(inWorkspace),
    cloneInto: inWorkspace(raw.cloneInto || '.'),
    featurePattern: raw.featurePattern || '^\\s*(feat|refactor|migrate)',
    repos: raw.repos.map((r) => (typeof r === 'string' ? { name: r } : r)),
    configPath: path,
  }
}

const TEMPLATE = {
  $schema: 'https://example.invalid/whatshipped.schema.json',
  '//': 'Paths are relative to THIS file. Run `whatshipped --help` for usage.',
  org: 'your-github-org',
  defaultBranch: 'origin/main',
  '//workspace': 'directory that holds (or will hold) the service checkouts',
  workspace: '.',
  searchPaths: ['.'],
  cloneInto: '.',
  '//repos': 'name is the GitHub repo name. Optional per-repo: branch, path.',
  repos: [
    { name: 'example-api' },
    { name: 'example-web', branch: 'origin/production' },
  ],
}

/** Write a generated config (from `init --scan`) to the right place. */
export function writeConfig(config, { global = false, force = false } = {}) {
  const target = global ? GLOBAL_CONFIG : join(process.cwd(), LOCAL_NAME)
  if (existsSync(target) && !force) {
    throw new Error(`${target} already exists — pass --force to overwrite`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`)
  return target
}

export function writeStarterConfig({ global = false, force = false } = {}) {
  const target = global ? GLOBAL_CONFIG : join(process.cwd(), LOCAL_NAME)
  if (existsSync(target) && !force) {
    throw new Error(`${target} already exists — pass --force to overwrite`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(TEMPLATE, null, 2)}\n`)
  return target
}

/** Cross-platform "open this file in something sensible". */
export function openCommand() {
  if (process.env.EDITOR) return [process.env.EDITOR, []]
  if (platform() === 'darwin') return ['open', []]
  if (platform() === 'win32') return ['cmd', ['/c', 'start', '']]
  return ['xdg-open', []]
}
