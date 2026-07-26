const FEATURE_RE = /^\s*(feat|refactor|migrate)/i
const PR_RE = /#(\d+)/

/*
 * Real commit logs are messier than the conventional-commits spec. Before any
 * classification we peel off the decoration teams actually use:
 *
 *   ✨ feat: x        gitmoji as a literal emoji
 *   :sparkles: feat:  gitmoji as a shortcode
 *   [FEAT] x          bracket tags
 *   FEAT : x          space before the colon
 *   feat(api)!: x     conventional scope and breaking marker
 */
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]+\s*)/u
const LEADING_SHORTCODE = /^:[a-z0-9_+-]+:\s*/i
const LEADING_BRACKET = /^\[[^\]]{1,30}\]\s*/

export function normalizeSubject(subject = '') {
  let s = String(subject).trim()
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(LEADING_EMOJI, '').replace(LEADING_SHORTCODE, '').trim()
    // `[FEAT] x` states the type in brackets — rewrite it rather than drop it,
    // but a leading ticket id like `[ABC-123]` carries no type and is removed.
    s = s.replace(LEADING_BRACKET, (m) => {
      const inner = m.replace(/[[\]\s]/g, '')
      return /^[a-z]+$/i.test(inner) ? `${inner}: ` : ''
    }).trim()
    if (s === before) break
  }
  return s
}

/*
 * Commits that are process artefacts rather than delivered work.
 *
 * Deliberately narrow. `Merge pull request …` is NOT here: with a squash-merge
 * workflow those commits have a single parent and carry the entire change
 * (real example: 18 files, +252 lines), so `git log --no-merges` keeps them and
 * dropping them would delete shipped work from the report. True merge commits
 * are already excluded by --no-merges. A `Revert "Revert …"` is a re-land —
 * also real work, also kept.
 */
const ARTEFACT_RE = /^(fixup!|squash!|amend!)\s/i
export const isArtefact = (subject) => ARTEFACT_RE.test(normalizeSubject(subject))

/** `feat!: x`, `feat(api)!: x`, or a BREAKING CHANGE trailer. */
export const isBreaking = (subject) =>
  /^[a-z]+(\([^)]*\))?!\s*:/i.test(normalizeSubject(subject)) || /BREAKING[ -]CHANGE/i.test(subject)

export const isFeature = (subject, pattern = FEATURE_RE) => {
  const s = normalizeSubject(subject)
  if (isArtefact(s)) return false
  // a revert is never a feature, however the reverted commit was labelled
  if (/^revert\b/i.test(s)) return false
  return (pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')).test(s)
}

export const prOf = (subject) => (subject.match(PR_RE) || [])[0] || null

/**
 * Cherry-picks and re-applied commits show up as byte-identical entries on the
 * same day. Counting both inflates every total, so collapse them.
 */
export function dedupe(commits) {
  const seen = new Set()
  const out = []
  for (const cm of commits) {
    const key = `${cm.repo}\u0000${cm.date}\u0000${normalizeSubject(cm.subject).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cm)
  }
  return out
}

/** Markdown table cells break on a literal pipe — escape before rendering. */
export const escapeCell = (text = '') => String(text)
  .replace(/\|/g, '\\|')
  .replace(/\r?\n/g, ' ')
  .trim()

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
  return normalizeSubject(subject)
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
  const breaking = commits.filter((c) => isBreaking(c.subject))

  // A feature that shipped and was pulled back inside the same window is the
  // single most useful thing this section can surface, so pair them up.
  const revertedTitles = new Map()
  for (const r of reverts) {
    const quoted = r.subject.match(/"([^"]+)"/)?.[1]
    if (quoted) revertedTitles.set(themeKey(quoted), r)
  }
  const roundTrips = commits
    .filter((c) => c.feature && revertedTitles.has(themeKey(c.subject)))
    .map((c) => ({ shipped: c, reverted: revertedTitles.get(themeKey(c.subject)) }))
  const credentials = match(/\b(api ?key|key (change|fix|swap|rotat)|rate.?limit|quota|credential)/i)
  const out = []
  if (roundTrips.length) {
    out.push({
      title: 'Shipped then reverted in the same window',
      detail: `${roundTrips.length} ${roundTrips.length === 1 ? 'change' : 'changes'} went live and were pulled back before the window closed. Worth confirming each one has since re-landed.`,
      evidence: roundTrips.map(({ shipped, reverted }) =>
        `${shipped.repo} ${shipped.date} → reverted ${reverted.date} — ${shipped.subject.replace(/\s*\(#\d+\)\s*$/, '')}`),
    })
  }
  if (breaking.length) {
    out.push({
      title: 'Breaking changes',
      detail: `${breaking.length} ${breaking.length === 1 ? 'commit is' : 'commits are'} marked breaking. Confirm consumers were migrated and the change was communicated.`,
      evidence: breaking.map(fmt),
    })
  }
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
