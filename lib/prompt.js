import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { c, sym } from './ui.js'

/** Thrown when the user hits Ctrl+C / Ctrl+D — a cancel, not a failure. */
export class Cancelled extends Error {
  constructor() { super('cancelled'); this.name = 'Cancelled' }
}

/*
 * One readline interface for the whole session. Creating one per question
 * works on a human terminal but loses buffered input the moment stdin is a
 * pipe, which makes scripted runs unreproducible.
 */
let rl = null
const session = () => {
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout })
    rl.on('SIGINT', () => { closePrompts(); process.exit(130) })
  }
  return rl
}

export function closePrompts() {
  rl?.close()
  rl = null
}

async function ask(question, { defaultValue = '' } = {}) {
  const suffix = defaultValue ? c.grey(` (${defaultValue})`) : ''
  let answer
  try {
    answer = await session().question(`${c.cyan('?')} ${c.bold(question)}${suffix} `)
  } catch {
    throw new Cancelled() // stdin closed (Ctrl+D) or the prompt was aborted
  }
  if (answer === null || answer === undefined) throw new Cancelled()
  return answer.trim() || defaultValue
}

export async function text(question, defaultValue) {
  return ask(question, { defaultValue })
}

export async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N'
  const answer = (await ask(`${question} ${c.grey(`[${hint}]`)}`)).toLowerCase()
  if (!answer) return defaultYes
  return answer.startsWith('y')
}

/**
 * Numbered multi-select. Everything starts selected — the common answer is
 * "yes, all of these", and the rare one is dropping an entry or two.
 *
 *   enter = accept · all · none · 1,3 = keep only these · -2 = drop #2
 */
export async function multiSelect(question, items, { render = String } = {}) {
  const selected = new Set(items.map((_, i) => i))

  for (;;) {
    stdout.write(`\n${c.bold(question)}\n`)
    items.forEach((item, i) => {
      const on = selected.has(i)
      const mark = on ? c.green(sym.tick) : c.grey('○')
      const label = on ? render(item) : c.grey(render(item))
      stdout.write(`  ${mark} ${c.grey(String(i + 1).padStart(2))}. ${label}\n`)
    })
    stdout.write(c.grey('\n  enter = accept  ·  all  ·  none  ·  1,3 = keep only these  ·  -2 = drop #2\n'))

    const answer = (await ask('selection')).toLowerCase()
    if (!answer) break
    if (answer === 'all') { items.forEach((_, i) => selected.add(i)); continue }
    if (answer === 'none') { selected.clear(); continue }

    const tokens = answer.split(/[\s,]+/).filter(Boolean)
    const drops = tokens.filter((t) => t.startsWith('-'))
    const keeps = tokens.filter((t) => !t.startsWith('-'))

    if (keeps.length) {
      selected.clear()
      for (const k of keeps) {
        const i = Number(k) - 1
        if (Number.isInteger(i) && items[i]) selected.add(i)
      }
    }
    for (const d of drops) {
      const i = Number(d.slice(1)) - 1
      if (Number.isInteger(i)) selected.delete(i)
    }
  }

  return items.filter((_, i) => selected.has(i))
}
