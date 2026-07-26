import { stderr, stdout } from 'node:process'

/* Colour is opt-out: NO_COLOR, a non-TTY pipe, or CI all disable it. */
const enabled = !process.env.NO_COLOR
  && !process.env.CI
  && stderr.isTTY
  && process.env.TERM !== 'dumb'

const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
}

export const sym = {
  tick: enabled ? '✓' : 'ok',
  cross: enabled ? '✗' : 'x',
  warn: enabled ? '▲' : '!',
  dot: '·',
  arrow: '›',
  bullet: '•',
}

const write = (s) => stderr.write(`${s}\n`)

export const log = {
  blank: () => write(''),
  title: (s) => write(`\n${c.bold(s)}`),
  step: (s) => write(`${c.cyan(sym.arrow)} ${s}`),
  ok: (s) => write(`${c.green(sym.tick)} ${s}`),
  warn: (s) => write(`${c.yellow(sym.warn)} ${s}`),
  error: (s) => write(`${c.red(sym.cross)} ${c.red(s)}`),
  hint: (s) => write(`  ${c.grey(s)}`),
  item: (s) => write(`  ${c.grey(sym.dot)} ${s}`),
  raw: write,
}

/**
 * Single-line progress that rewrites itself on a TTY and degrades to one
 * line per event when piped to a file or CI.
 */
export function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  let current = text
  let timer = null

  const render = () => {
    if (!enabled) return
    stderr.write(`\r\x1b[2K${c.cyan(frames[i++ % frames.length])} ${current}`)
  }
  const clear = () => { if (enabled) stderr.write('\r\x1b[2K') }

  if (enabled) {
    render()
    timer = setInterval(render, 80)
    timer.unref?.()
  } else {
    write(`${sym.arrow} ${text}`)
  }

  return {
    update(next) {
      current = next
      if (!enabled) write(`  ${next}`)
    },
    /** Print a finished line above the still-running spinner. */
    line(text) {
      clear()
      write(text)
      render()
    },
    stop(finalText) {
      if (timer) clearInterval(timer)
      clear()
      if (finalText) write(finalText)
    },
  }
}

/** Right-align a column of numbers so a summary reads as a table. */
export function alignedRows(rows, { gap = 2 } = {}) {
  if (!rows.length) return []
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)))
  return rows.map((r) => r
    .map((cell, i) => (i === 0
      ? String(cell ?? '').padEnd(widths[i])
      : String(cell ?? '').padStart(widths[i])))
    .join(' '.repeat(gap))
    .trimEnd())
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const isInteractive = () => Boolean(stdout.isTTY && process.stdin.isTTY)
