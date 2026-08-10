import { describe, expect, it } from 'vitest'
import * as heuristics from './heuristics'
import {
  DEFAULT_CORRECTION_MARKERS,
  SYSTEM_WRAPPER_TAGS,
  classifyPrompt,
  correctionSignal,
  redact,
  stripSystemBlocks,
} from './heuristics'
import type { Signal } from './journal'

// Fake tokens for testing only — never real credentials.
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const GH_TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const NPM_TOKEN = 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

const TS = '2026-01-02T03:04:05.000Z'

describe('DEFAULT_CORRECTION_MARKERS', () => {
  it('lists the documented pt-BR + en markers in order', () => {
    expect(DEFAULT_CORRECTION_MARKERS).toEqual([
      'na verdade',
      'não, faz',
      'nao, faz',
      'sempre que',
      'nunca',
      'actually',
      'no, do',
      'always',
      'never',
      'não use',
      'nao use',
      "don't use",
      'do not use',
    ])
  })
})

describe('classifyPrompt: default markers', () => {
  for (const marker of DEFAULT_CORRECTION_MARKERS) {
    it(`matches the phrase built around "${marker}"`, () => {
      const text = `um teste com ${marker} aqui`
      // With a single-marker list the answer is unambiguous...
      expect(classifyPrompt(text, [marker])).toBe(marker)
      // ...and the default list also recognises the phrase (possibly via an
      // earlier, diacritic-equivalent entry such as 'não use' for 'nao use').
      expect(classifyPrompt(text)).not.toBeNull()
    })
  }

  it('returns null for a prompt with no marker', () => {
    expect(classifyPrompt('please add a unit test for the parser')).toBeNull()
  })
})

describe('classifyPrompt: word boundaries', () => {
  it('does not match "never" inside "nevertheless"', () => {
    expect(classifyPrompt('nevertheless we ship today', ['never'])).toBeNull()
    expect(classifyPrompt('nevertheless we ship today')).toBeNull()
  })

  it('does not match "never" inside "unnevering"', () => {
    expect(classifyPrompt('an unnevering silence', ['never'])).toBeNull()
    expect(classifyPrompt('an unnevering silence')).toBeNull()
  })

  it('does not match "nunca" inside the hyphenated compound "nunca-mente"', () => {
    expect(classifyPrompt('a palavra nunca-mente nao existe', ['nunca'])).toBeNull()
  })

  it('does not match "never" inside "never-ending"', () => {
    expect(classifyPrompt('a never-ending build', ['never'])).toBeNull()
  })

  it('matches a marker delimited by punctuation', () => {
    expect(classifyPrompt('na verdade, use pnpm')).toBe('na verdade')
    expect(classifyPrompt('nunca!')).toBe('nunca')
  })

  it('matches a marker at the very start and at the very end', () => {
    expect(classifyPrompt('never', ['never'])).toBe('never')
    expect(classifyPrompt('do it never', ['never'])).toBe('never')
  })
})

describe('classifyPrompt: normalization', () => {
  it('is diacritic-insensitive when the text has the accent', () => {
    expect(classifyPrompt('não, faz do outro jeito', ['nao, faz'])).toBe('nao, faz')
    expect(classifyPrompt('não use npm aqui', ['nao use'])).toBe('nao use')
  })

  it('is diacritic-insensitive when the marker has the accent', () => {
    expect(classifyPrompt('nao, faz do outro jeito', ['não, faz'])).toBe('não, faz')
    expect(classifyPrompt('nao use npm aqui', ['não use'])).toBe('não use')
  })

  it('is case-insensitive', () => {
    expect(classifyPrompt('ACTUALLY, use pnpm')).toBe('actually')
    expect(classifyPrompt('Na Verdade o build usa tsup')).toBe('na verdade')
    expect(classifyPrompt('NÃO USE npm', ['nao use'])).toBe('nao use')
  })
})

describe('classifyPrompt: marker precedence and overrides', () => {
  it('returns the first matching marker in list order, not the first in the text', () => {
    const text = 'never do that, actually use pnpm'
    // 'actually' comes before 'never' in the default list.
    expect(classifyPrompt(text)).toBe('actually')
    // A custom list flips the precedence.
    expect(classifyPrompt(text, ['never', 'actually'])).toBe('never')
    expect(classifyPrompt(text, ['actually', 'never'])).toBe('actually')
  })

  it('prefers the accented default entry when both spellings would match', () => {
    expect(classifyPrompt('nao, faz assim')).toBe('não, faz')
  })

  it('lets a custom marker list fully override the defaults', () => {
    expect(classifyPrompt('actually, use pnpm', ['prefira'])).toBeNull()
    expect(classifyPrompt('prefira usar pnpm', ['prefira'])).toBe('prefira')
  })

  it('returns null for an empty custom marker list', () => {
    expect(classifyPrompt('actually, use pnpm', [])).toBeNull()
  })

  it('ignores empty or whitespace-only markers', () => {
    expect(classifyPrompt('qualquer coisa', ['', '   '])).toBeNull()
  })
})

describe('classifyPrompt: empty input', () => {
  it('returns null for empty text', () => {
    expect(classifyPrompt('')).toBeNull()
  })

  it('returns null for whitespace-only text', () => {
    expect(classifyPrompt('   ')).toBeNull()
    expect(classifyPrompt('\n\t  \r\n')).toBeNull()
  })
})

describe('redact: secrets', () => {
  it('replaces an AWS access key keeping the surrounding words', () => {
    expect(redact(`deploy usa ${AWS_KEY} no s3`)).toBe('deploy usa [REDACTED:aws-access-key] no s3')
  })

  it('replaces a GitHub token keeping the surrounding words', () => {
    const out = redact(`o remote usa ${GH_TOKEN} para auth`)
    expect(out).toBe('o remote usa [REDACTED:github-token] para auth')
    expect(out).not.toContain('ghp_')
  })

  it('replaces every secret when a prompt carries several', () => {
    const out = redact(`use ${AWS_KEY} e ${GH_TOKEN} e ${NPM_TOKEN} juntos`)
    expect(out).toBe(
      'use [REDACTED:aws-access-key] e [REDACTED:github-token] e [REDACTED:npm-token] juntos',
    )
    expect(out).not.toContain(AWS_KEY)
    expect(out).not.toContain(GH_TOKEN)
    expect(out).not.toContain(NPM_TOKEN)
  })

  it('replaces a quoted secret without eating the quotes', () => {
    expect(redact(`password: "${AWS_KEY}"`)).toBe('password: "[REDACTED:aws-access-key]"')
  })

  it('replaces an env-style secret assignment', () => {
    const out = redact('API_TOKEN=s3cr3t-value-here rodou ok')
    expect(out).toBe('API_TOKEN=[REDACTED:env-secret] rodou ok')
  })

  it('leaves a prompt without secrets untouched', () => {
    expect(redact('rode os testes do parser por favor')).toBe('rode os testes do parser por favor')
  })

  it('does not throw on malformed input around a secret', () => {
    expect(() => redact(`"unclosed ${AWS_KEY}`)).not.toThrow()
    expect(redact(`"unclosed ${AWS_KEY}`)).not.toContain('AKIA')
  })
})

describe('redact: whitespace', () => {
  it('collapses newlines to single spaces', () => {
    expect(redact('linha um\nlinha dois\r\nlinha três')).toBe('linha um linha dois linha três')
  })

  it('trims the result', () => {
    expect(redact('  \n  centro  \n  ')).toBe('centro')
  })

  it('returns empty string for empty input', () => {
    expect(redact('')).toBe('')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(redact('   \n\t ')).toBe('')
  })
})

describe('redact: truncation', () => {
  it('truncates at the default maxLen and appends an ellipsis', () => {
    const out = redact('x'.repeat(600))
    expect(out).toHaveLength(501)
    expect(out.endsWith('…')).toBe(true)
    expect(out.slice(0, 500)).toBe('x'.repeat(500))
  })

  it('does not truncate text exactly at maxLen', () => {
    expect(redact('abcd', 4)).toBe('abcd')
    expect(redact('x'.repeat(500))).toHaveLength(500)
  })

  it('honours a custom maxLen', () => {
    expect(redact('abcdefghij', 4)).toBe('abcd…')
  })

  it('redacts before truncating, so a leading secret never survives the cut', () => {
    const out = redact(`na verdade ${GH_TOKEN} ${'y'.repeat(600)}`)
    expect(out).toHaveLength(501)
    expect(out.startsWith('na verdade [REDACTED:github-token] ')).toBe(true)
    expect(out).not.toContain('ghp_')
  })

  it('does not throw when truncating multi-byte text', () => {
    const emoji = '🙂'.repeat(400)
    let out = ''
    expect(() => {
      out = redact(emoji, 501)
    }).not.toThrow()
    expect(out.length).toBeLessThanOrEqual(502)
    expect(out.endsWith('…')).toBe(true)
    // No lone surrogate left behind by the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false)
  })
})

describe('correctionSignal', () => {
  it('returns a well-formed correction Signal', () => {
    const signal: Signal | null = correctionSignal('na verdade, use pnpm', TS)
    expect(signal).toEqual({
      t: 'correction',
      ts: TS,
      marker: 'na verdade',
      prompt: 'na verdade, use pnpm',
    })
  })

  it('redacts secrets inside the captured prompt', () => {
    const signal = correctionSignal(`na verdade use ${GH_TOKEN} no deploy`, TS)
    expect(signal).not.toBeNull()
    expect(signal?.t).toBe('correction')
    const prompt = signal !== null && signal.t === 'correction' ? signal.prompt : ''
    expect(prompt).toBe('na verdade use [REDACTED:github-token] no deploy')
    expect(JSON.stringify(signal)).not.toContain('ghp_')
  })

  it('collapses newlines in the captured prompt', () => {
    const signal = correctionSignal('nunca\nfaça isso', TS)
    const prompt = signal !== null && signal.t === 'correction' ? signal.prompt : ''
    expect(prompt).toBe('nunca faça isso')
  })

  it('returns null when no marker matches', () => {
    expect(correctionSignal('adicione um teste para o parser', TS)).toBeNull()
    expect(correctionSignal('', TS)).toBeNull()
    expect(correctionSignal('   ', TS)).toBeNull()
  })

  it('honours a custom marker list', () => {
    expect(correctionSignal('actually, use pnpm', TS, ['prefira'])).toBeNull()
    const signal = correctionSignal('prefira usar pnpm', TS, ['prefira'])
    const marker = signal !== null && signal.t === 'correction' ? signal.marker : ''
    expect(marker).toBe('prefira')
  })

  it('passes the timestamp through verbatim', () => {
    const signal = correctionSignal('nunca use npm', 'not-a-date')
    expect(signal?.ts).toBe('not-a-date')
  })
})

describe('marks-only boundary (PRD): the module never writes durable memory', () => {
  it('exports exactly the pure helpers and nothing else', () => {
    // Grows only with read-only helpers. The point of pinning the exact set is
    // that a write path cannot be added here without this test noticing.
    expect(Object.keys(heuristics).sort()).toEqual(
      [
        'DEFAULT_CORRECTION_MARKERS',
        'SYSTEM_WRAPPER_TAGS',
        'classifyPrompt',
        'correctionSignal',
        'redact',
        'stripSystemBlocks',
      ].sort(),
    )
  })

  it('exports no write/persist/append/save function', () => {
    const forbidden = /write|persist|append|save|store|commit|flush|upsert|record/i
    expect(Object.keys(heuristics).filter((k) => forbidden.test(k))).toEqual([])
  })

  it('only produces signals — correctionSignal returns data, never a side effect handle', () => {
    const signal = correctionSignal('na verdade, use pnpm', TS)
    expect(signal).not.toBeNull()
    for (const value of Object.values(signal ?? {})) {
      expect(typeof value).toBe('string')
    }
  })
})

describe('stripSystemBlocks — harness-injected content is not user input', () => {
  // Verbatim shape from the real journal: three of four captured corrections
  // were these, and they matched on words from the agent's own prose quoted
  // inside them.
  const TASK_NOTIFICATION =
    '<task-notification> <task-id>ada2f56ddb1f8e218</task-id> ' +
    '<result>The agent reported it will never guess a field name and always ' +
    'verify. Actually it also fixed the parser.</result> </task-notification>'

  it('drops a pure task-notification, so it produces no correction at all', () => {
    expect(stripSystemBlocks(TASK_NOTIFICATION)).toBe('')
    expect(correctionSignal(TASK_NOTIFICATION, '2026-08-08T00:00:00Z')).toBeNull()
  })

  it.each(SYSTEM_WRAPPER_TAGS)('strips <%s> blocks', (tag) => {
    const text = `<${tag}>never do this, always do that</${tag}>`
    expect(stripSystemBlocks(text)).toBe('')
    expect(correctionSignal(text, '2026-08-08T00:00:00Z')).toBeNull()
  })

  it('strips an unclosed wrapper — harnesses do not always close them', () => {
    expect(stripSystemBlocks('<system-reminder>never mind this')).toBe('')
  })

  it('strips the bare SYSTEM NOTIFICATION prefix', () => {
    const text = '[SYSTEM NOTIFICATION - NOT USER INPUT] the agent said never'
    expect(stripSystemBlocks(text)).not.toContain('SYSTEM NOTIFICATION')
  })

  it('keeps the human message when a reminder is appended to it', () => {
    // The case that makes stripping the right call over discarding: a real
    // correction arrives WITH injected content stuck to it.
    const text = 'na verdade, nunca use ORM aqui\n<system-reminder>be nice</system-reminder>'
    const signal = correctionSignal(text, '2026-08-08T00:00:00Z')
    expect(signal?.t).toBe('correction')
    const prompt = signal?.t === 'correction' ? signal.prompt : ''
    expect(prompt).toContain('nunca use ORM')
    expect(prompt).not.toContain('system-reminder')
    expect(prompt).not.toContain('be nice')
  })

  it('leaves markup the user pasted alone — it is a real prompt', () => {
    // Why the tag list is a whitelist and not "strip every tag".
    const text = 'na verdade esse <div class="x">bloco</div> nunca deveria renderizar'
    expect(stripSystemBlocks(text)).toBe(text)
    const signal = correctionSignal(text, '2026-08-08T00:00:00Z')
    expect(signal?.t === 'correction' ? signal.prompt : '').toContain('<div')
  })

  it('leaves an ordinary prompt untouched', () => {
    expect(stripSystemBlocks('sempre roda o lint antes')).toBe('sempre roda o lint antes')
  })

  it('never throws on hostile input', () => {
    for (const bad of ['', '<', '<task-notification', '</task-notification>', '<<>>']) {
      expect(() => stripSystemBlocks(bad)).not.toThrow()
    }
  })
})
