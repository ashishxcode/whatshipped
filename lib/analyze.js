const FEATURE_RE = /^\s*(feat|refactor|migrate)/i
const PR_RE = /#(\d+)/

export const isFeature = (subject) => FEATURE_RE.test(subject)
export const prOf = (subject) => (subject.match(PR_RE) || [])[0] || null

/** Month helpers — all string math, no Date parsing surprises. */
export const monthOf = (date) => date.slice(0, 7)
export function addMonth(ym, n = 1) {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}
export function monthRange(start, end) {
  const out = []
  for (let m = start; m <= end; m = addMonth(m)) out.push(m)
  return out
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
export const monthName = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}
export const dayName = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * Normalise a commit subject down to a comparable theme key:
 * strip the PR ref, the FEAT:/fix: prefix, punctuation and case.
 */
export function themeKey(subject) {
  return subject
    .replace(/\(#\d+\)/g, '')
    .replace(/#\d+/g, '')
    .replace(/^\s*[a-z]+\s*:\s*/i, '')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Feature work that landed in more than one service — the release spine. */
export function crossServiceThemes(commits) {
  const groups = new Map()
  for (const c of commits.filter((c) => c.feature)) {
    const key = themeKey(c.subject)
    if (key.length < 6) continue // too generic to be a theme
    if (!groups.has(key)) groups.set(key, { title: c.subject, repos: new Set(), dates: [] })
    const g = groups.get(key)
    g.repos.add(c.repo)
    g.dates.push(c.date)
    if (c.subject.length > g.title.length) g.title = c.subject
  }
  return [...groups.values()]
    .filter((g) => g.repos.size > 1)
    .map((g) => {
      const dates = g.dates.sort()
      return {
        title: g.title.replace(/\s*\(#\d+\)\s*$/, '').replace(/^\s*[A-Za-z]+\s*:\s*/, ''),
        repos: [...g.repos].sort(),
        from: dates[0],
        to: dates[dates.length - 1],
      }
    })
    .sort((a, b) => b.repos.length - a.repos.length || a.from.localeCompare(b.from))
}

/**
 * Signals worth a human look. Seeded into Risks & Follow-ups on first run so
 * the section starts from evidence rather than a blank page.
 */
export function riskSignals(commits) {
  const match = (re) => commits.filter((c) => re.test(c.subject))
  const fmt = (c) => `${c.repo} ${c.date} — ${c.subject.replace(/\s*\(#\d+\)\s*$/, '')}`
  const reverts = match(/\b(revert|restore|rollback)\b/i)
  const credentials = match(/\b(api ?key|key (change|fix|swap|rotat)|rate.?limit|quota|credential)/i)
  const out = []
  if (reverts.length) {
    out.push({
      title: 'Reverted / restored work',
      detail: `${reverts.length} revert-or-restore ${reverts.length === 1 ? 'commit' : 'commits'} landed in the window. Each one is a change that shipped and then had to be pulled back — check whether the underlying cause was addressed.`,
      evidence: reverts.map(fmt),
    })
  }
  if (credentials.length) {
    out.push({
      title: 'Third-party credential & rate-limit churn',
      detail: `${credentials.length} ${credentials.length === 1 ? 'commit' : 'commits'} touched API keys, quotas or rate limits. Recurring churn here is a standing production risk and usually signals a missing managed-credential strategy.`,
      evidence: credentials.map(fmt),
    })
  }
  return out
}

/** Roll raw commits up into the numbers the report tables need. */
export function summarize(commits, repos, months) {
  const count = (pred) => commits.filter(pred).length
  const byRepo = repos.map((name) => ({
    name,
    features: count((c) => c.repo === name && c.feature),
    fixes: count((c) => c.repo === name && !c.feature),
  })).map((r) => ({ ...r, total: r.features + r.fixes }))
    .sort((a, b) => b.total - a.total)

  const byMonth = months.map((m) => ({
    month: m,
    features: count((c) => monthOf(c.date) === m && c.feature),
    fixes: count((c) => monthOf(c.date) === m && !c.feature),
  })).map((r) => ({ ...r, total: r.features + r.fixes }))

  const features = count((c) => c.feature)
  const fixes = commits.length - features
  return { byRepo, byMonth, features, fixes, total: commits.length }
}
