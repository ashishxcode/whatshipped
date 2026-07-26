import {
  crossServiceThemes, dayName, escapeCell, isBreaking, monthName, monthOf, prOf,
  riskSignals, summarize,
} from './analyze.js'

/* ---- narrative blocks -------------------------------------------------------
 * Everything a human writes lives between these markers. On every regeneration
 * the previous file is read and these blocks are carried over verbatim, so the
 * report can be re-run without losing the prose. Delete a block's body to have
 * the seeded draft come back.
 * ---------------------------------------------------------------------------*/
const open = (id) => `<!-- narrative:${id} -->`
const close = (id) => `<!-- /narrative:${id} -->`

export function extractNarrative(previous, id) {
  if (!previous) return null
  const s = previous.indexOf(open(id))
  const e = previous.indexOf(close(id))
  if (s === -1 || e === -1) return null
  return previous.slice(s + open(id).length, e).trim()
}

const block = (id, body) => `${open(id)}\n${body.trim()}\n${close(id)}`

/* ---- tables ---------------------------------------------------------------*/
const row = (...cells) => `| ${cells.join(' | ')} |`

function commitTable(commits, { showRepo = false } = {}) {
  const head = showRepo
    ? [row('PR', 'Date', 'Service', 'Title'), row('---', '---', '---', '---')]
    : [row('PR', 'Date', 'Title'), row('---', '---', '---')]
  const body = [...commits]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((c) => {
      const title = escapeCell(c.subject) + (isBreaking(c.subject) ? ' **⚠ breaking**' : '')
      return showRepo
        ? row(prOf(c.subject) || '—', c.date, c.repo, title)
        : row(prOf(c.subject) || '—', c.date, title)
    })
  return [...head, ...body].join('\n')
}

/* ---- seeded drafts --------------------------------------------------------*/
function seedExecSummary(sum, themes, months) {
  const top = themes.slice(0, 4)
  const lines = top.map((t) =>
    `- **${t.title}** — shipped across ${t.repos.length} services (${t.repos.join(', ')}), landed ${dayName(t.from)}.`)
  const busiest = [...sum.byMonth].sort((a, b) => b.total - a.total)[0]
  return [
    '_Draft — rewrite this in your own words. It survives the next run._',
    '',
    `${sum.total} changes landed across ${sum.byRepo.filter((r) => r.total).length} services: ${sum.features} features and ${sum.fixes} fixes/improvements.`,
    '',
    ...lines,
    '',
    months.length > 1 && busiest
      ? `Busiest month was ${monthName(busiest.month)} with ${busiest.total} changes.`
      : '',
  ].filter((l) => l !== '').join('\n')
}

function seedHeadlineLaunches(themes) {
  const rows = themes.slice(0, 8).map((t) => row(
    `**${t.title}**`,
    '_what it delivers — fill in_',
    `${t.repos.join(', ')} (${t.repos.length})`,
    t.from === t.to ? dayName(t.from) : `${dayName(t.from)} – ${dayName(t.to)}`,
    'Live',
  ))
  return [
    '_Draft — trim to the launches that actually matter to stakeholders._',
    '',
    row('Launch', 'What it delivers', 'Services', 'Landed', 'Status'),
    row('---', '---', '---', '---', '---'),
    ...rows,
  ].join('\n')
}

function seedRisks(signals) {
  if (!signals.length) return '_No revert or credential-churn signals detected in this window._'
  return [
    '_Draft — seeded from commit signals. Keep what matters, cut the noise._',
    '',
    ...signals.map((s) => [
      `- **${s.title}** — ${s.detail}`,
      ...s.evidence.slice(0, 8).map((e) => `  - ${e}`),
      s.evidence.length > 8 ? `  - _…and ${s.evidence.length - 8} more_` : '',
    ].filter(Boolean).join('\n')),
  ].join('\n')
}

/* ---- the report -----------------------------------------------------------*/
export function renderReport({ commits, repos, months, statuses, previous }) {
  const sum = summarize(commits, repos, months)
  const themes = crossServiceThemes(commits)
  const dates = commits.map((c) => c.date).sort()
  const single = months.length === 1
  const live = sum.byRepo.filter((r) => r.total > 0).length

  const title = single
    ? `# ${monthName(months[0])} — Engineering Delivery Report`
    : `# ${monthName(months[0])} – ${monthName(months.at(-1))} — Engineering Delivery Report`

  const period = dates.length
    ? `**Period:** ${dayName(dates[0])} – ${dayName(dates.at(-1))}`
    : `**Period:** ${monthName(months[0])}`

  const out = [
    title,
    '',
    `${period}  ·  **Scope:** ${live} production services  ·  **Shipped:** ${sum.total} changes (${sum.features} features, ${sum.fixes} fixes/improvements)`,
    '',
    '## Executive Summary',
    '',
    block('exec-summary',
      extractNarrative(previous, 'exec-summary') || seedExecSummary(sum, themes, months)),
    '',
    '## Headline Launches',
    '',
    block('headline-launches',
      extractNarrative(previous, 'headline-launches') || seedHeadlineLaunches(themes)),
    '',
    '## Delivery by Service',
    '',
    row('Service', 'Features', 'Fixes/Chores', 'Total'),
    row('---', '---:', '---:', '---:'),
    ...sum.byRepo.map((r) => row(r.name, r.features, r.fixes, `**${r.total}**`)),
    row('**All**', `**${sum.features}**`, `**${sum.fixes}**`, `**${sum.total}**`),
    '',
    serviceNote(sum),
    '',
  ]

  if (!single) {
    out.push(
      '## Delivery by Month',
      '',
      row('Month', 'Features', 'Fixes/Chores', 'Total'),
      row('---', '---:', '---:', '---:'),
      ...sum.byMonth.map((m) => row(monthName(m.month), m.features, m.fixes, `**${m.total}**`)),
      '',
    )
  }

  out.push('---', '', '## Features Shipped', '')
  const features = commits.filter((c) => c.feature)
  if (single) {
    out.push(features.length ? commitTable(features, { showRepo: true }) : '_none_', '')
  } else {
    for (const m of months) {
      const inMonth = features.filter((c) => monthOf(c.date) === m)
      out.push(`### ${monthName(m)}`, '')
      out.push(inMonth.length ? commitTable(inMonth, { showRepo: true }) : '_no features_', '')
    }
  }

  out.push('---', '', '## Cross-Service Themes', '',
    'Work that shipped across multiple services in the same window — the release spine.', '')
  if (themes.length) {
    out.push(
      row('Theme', 'Services', 'Landed'),
      row('---', '---', '---'),
      ...themes.map((t) => row(
        `**${escapeCell(t.title)}**`,
        `${t.repos.join(', ')} (${t.repos.length})`,
        t.from === t.to ? shortDay(t.from) : `${shortDay(t.from)} – ${shortDay(t.to)}`,
      )),
      '',
    )
  } else {
    out.push('_no work spanned more than one service in this window_', '')
  }

  out.push('## Risks & Follow-ups', '',
    block('risks', extractNarrative(previous, 'risks') || seedRisks(riskSignals(commits))),
    '', '---', '', '## Appendix — Per-Service Detail', '',
    '_Full commit-level breakdown per service. Reference only._', '')

  for (const name of repos) {
    const st = statuses.get(name)
    out.push(`## ${name}`, `_live branch: \`${st?.ref || 'unresolved'}\`_`, '')
    if (!st || st.state !== 'ok') {
      out.push(`_skipped: ${st?.state || 'not processed'}_`, '')
      continue
    }
    const mine = commits.filter((c) => c.repo === name)
    const f = mine.filter((c) => c.feature)
    const x = mine.filter((c) => !c.feature)
    out.push('### Features', '', f.length ? commitTable(f) : '_none_', '')
    out.push('### Fixes / Hotfixes / Chores', '', x.length ? commitTable(x) : '_none_', '')
  }

  out.push('---',
    `_Generated by whatshipped — ${live} services, ${sum.total} commits, window ${months[0]}-01 → ${months.at(-1)}-01 (+1 month)._`)

  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

const shortDay = (date) => {
  const [, m, d] = date.split('-').map(Number)
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}`
}

function serviceNote(sum) {
  const [a, b] = sum.byRepo
  if (!a || !sum.total) return ''
  const share = Math.round(((a.total + (b?.total || 0)) / sum.total) * 100)
  const ratio = sum.features ? (sum.fixes / sum.features).toFixed(1) : '—'
  return `_${a.name}${b ? ` and ${b.name}` : ''} carried ${share}% of the volume. The ${ratio}:1 fix-to-feature ratio reflects stabilisation behind this window's launches._`
}
