import { describe, expect, it } from 'vitest'
import type { Adr } from './format'
import { BODY_TEMPLATE, adrFilename, parseAdr, serializeAdr, slugify } from './format'

type AdrInput = Omit<Adr, 'id' | 'warnings'>

const REQUIRED = ['title', 'date', 'area', 'summary'] as const

const ID = '2026-08-08-session-cookies-over-jwt.md'

const FULL: AdrInput = {
  title: 'Session cookies over JWT',
  date: '2026-08-08',
  area: 'auth',
  summary: 'Auth uses session cookies because revocation has to take effect immediately.',
  supersedes: '2026-03-11-jwt-for-auth.md',
  body: BODY_TEMPLATE,
}

const WITHOUT_SUPERSEDES: AdrInput = {
  title: 'Adopt biome',
  date: '2026-01-02',
  area: 'tooling',
  summary: 'Formatting and linting both run through biome.',
  body: '## Context\nOne linter is enough.\n',
}

const BASE: Record<string, string> = {
  title: 'Session cookies over JWT',
  date: '2026-08-08',
  area: 'auth',
  summary: 'Revocation has to take effect immediately.',
}

/** Build a file from flat frontmatter fields, in the given order. */
function frontmatter(fields: Record<string, string>, body = '## Context\nWhy.\n'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

function roundTrip(input: AdrInput): Adr {
  return parseAdr(ID, serializeAdr(input))
}

describe('slugify', () => {
  it('kebab-cases a plain title', () => {
    expect(slugify('Session cookies over JWT')).toBe('session-cookies-over-jwt')
  })

  it('folds accents to their base letters instead of dropping the word', () => {
    expect(slugify('Sessão sobre JWT')).toBe('sessao-sobre-jwt')
    expect(slugify('Configuração de índices')).toBe('configuracao-de-indices')
    expect(slugify('Señor Ünicode')).toBe('senor-unicode')
  })

  it('collapses punctuation and runs of separators into a single dash', () => {
    expect(slugify('Auth: cookies vs. JWT!')).toBe('auth-cookies-vs-jwt')
    expect(slugify('a   b\t\tc')).toBe('a-b-c')
    expect(slugify('a---b___c')).toBe('a-b-c')
  })

  it('trims leading and trailing separators', () => {
    expect(slugify('  --- Hello ---  ')).toBe('hello')
  })

  it('keeps digits', () => {
    expect(slugify('Postgres 16 over MySQL 8')).toBe('postgres-16-over-mysql-8')
  })

  it('leaves an already-kebab title untouched', () => {
    expect(slugify('session-cookies-over-jwt')).toBe('session-cookies-over-jwt')
  })

  it('caps a 200-character title at 60 without cutting mid-word', () => {
    const title = 'word '.repeat(40)
    expect(title).toHaveLength(200)
    const slug = slugify(title)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.startsWith('-')).toBe(false)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug.split('-').every((part) => part === 'word')).toBe(true)
  })

  it('cuts hard when a single word is longer than the cap', () => {
    expect(slugify('a'.repeat(200))).toBe('a'.repeat(60))
  })

  it('falls back to untitled when nothing survives', () => {
    expect(slugify('🎉🎉🎉')).toBe('untitled')
    expect(slugify('')).toBe('untitled')
    expect(slugify('   ')).toBe('untitled')
    expect(slugify('!!! ??? ...')).toBe('untitled')
  })
})

describe('adrFilename', () => {
  it('joins the date and the slug into the identifier', () => {
    expect(adrFilename('2026-08-08', 'cookie-sessions')).toBe('2026-08-08-cookie-sessions.md')
  })

  it('composes with slugify', () => {
    expect(adrFilename('2026-08-08', slugify('Session cookies over JWT'))).toBe(ID)
  })
})

describe('BODY_TEMPLATE', () => {
  it('carries the four seeded headings', () => {
    expect(BODY_TEMPLATE).toContain('## Context')
    expect(BODY_TEMPLATE).toContain('## Decision')
    expect(BODY_TEMPLATE).toContain('## Alternatives considered')
    expect(BODY_TEMPLATE).toContain('## Consequences')
  })

  it('gives every heading a one-line prompt under it', () => {
    for (const section of BODY_TEMPLATE.split('\n## ')) {
      expect(section.trim().split('\n').length).toBeGreaterThan(1)
    }
  })

  it('ends with exactly one newline', () => {
    expect(BODY_TEMPLATE.endsWith('\n')).toBe(true)
    expect(BODY_TEMPLATE.endsWith('\n\n')).toBe(false)
  })
})

describe('serializeAdr', () => {
  it('emits the fields in the fixed order between two fences', () => {
    expect(serializeAdr(FULL).split('\n').slice(0, 7)).toEqual([
      '---',
      'title: Session cookies over JWT',
      'date: 2026-08-08',
      'area: auth',
      'summary: Auth uses session cookies because revocation has to take effect immediately.',
      'supersedes: 2026-03-11-jwt-for-auth.md',
      '---',
    ])
  })

  it('omits supersedes when it is absent', () => {
    expect(serializeAdr(WITHOUT_SUPERSEDES)).not.toContain('supersedes')
  })

  it('ends the file with a newline when the body has none', () => {
    const out = serializeAdr({ ...WITHOUT_SUPERSEDES, body: '## Context\nno trailing newline' })
    expect(out.endsWith('no trailing newline\n')).toBe(true)
  })

  it('does not add a second newline when the body already ends with one', () => {
    const out = serializeAdr(WITHOUT_SUPERSEDES)
    expect(out.endsWith('One linter is enough.\n')).toBe(true)
  })

  it('stops at the closing fence when the body is empty', () => {
    const out = serializeAdr({ ...WITHOUT_SUPERSEDES, body: '' })
    expect(out.endsWith('---\n')).toBe(true)
    expect(parseAdr(ID, out).body).toBe('')
  })
})

describe('round-trip', () => {
  it('preserves every field of a full ADR', () => {
    expect(roundTrip(FULL)).toEqual({ id: ID, ...FULL, warnings: [] })
  })

  it('preserves an ADR without supersedes', () => {
    const parsed = roundTrip(WITHOUT_SUPERSEDES)
    expect(parsed).toEqual({ id: ID, ...WITHOUT_SUPERSEDES, warnings: [] })
    expect(parsed.supersedes).toBeUndefined()
  })

  it('preserves the body byte-for-byte, including trailing blank lines', () => {
    const body = '## Context\n\nSomething.\n\n\n'
    expect(roundTrip({ ...FULL, body }).body).toBe(body)
  })

  it('preserves a body that itself contains a --- fence', () => {
    const body = '## Context\n\n---\n\nA horizontal rule.\n'
    expect(roundTrip({ ...FULL, body }).body).toBe(body)
  })

  it('preserves a module rule in supersedes', () => {
    const parsed = roundTrip({ ...FULL, supersedes: 'backend-dotnet/commands-mediatr' })
    expect(parsed.supersedes).toBe('backend-dotnet/commands-mediatr')
    expect(parsed.warnings).toEqual([])
  })

  it('preserves values containing a colon', () => {
    const parsed = roundTrip({ ...FULL, summary: 'Auth: revocation has to be immediate.' })
    expect(parsed.summary).toBe('Auth: revocation has to be immediate.')
    expect(parsed.warnings).toEqual([])
  })

  it('preserves a value that already looks quoted', () => {
    const parsed = roundTrip({ ...FULL, title: '"Session cookies" over JWT' })
    expect(parsed.title).toBe('"Session cookies" over JWT')
    expect(roundTrip({ ...FULL, title: '"quoted"' }).title).toBe('"quoted"')
    expect(roundTrip({ ...FULL, title: "'quoted'" }).title).toBe("'quoted'")
  })

  it('preserves the seeded body template', () => {
    expect(roundTrip(FULL).body).toBe(BODY_TEMPLATE)
  })
})

describe('parseAdr', () => {
  it('returns the id verbatim', () => {
    expect(parseAdr('whatever.md', frontmatter(BASE)).id).toBe('whatever.md')
  })

  it('parses a well-formed file with no warnings', () => {
    const adr = parseAdr(ID, frontmatter(BASE))
    expect(adr.warnings).toEqual([])
    expect(adr.title).toBe('Session cookies over JWT')
    expect(adr.date).toBe('2026-08-08')
    expect(adr.area).toBe('auth')
    expect(adr.summary).toBe('Revocation has to take effect immediately.')
    expect(adr.supersedes).toBeUndefined()
    expect(adr.body).toBe('## Context\nWhy.\n')
  })

  it('keeps the body verbatim, including trailing blank lines', () => {
    const adr = parseAdr(ID, frontmatter(BASE, '## Context\n\n\n'))
    expect(adr.body).toBe('## Context\n\n\n')
  })

  it('splits each line on the first colon only', () => {
    const adr = parseAdr(
      ID,
      frontmatter({ ...BASE, summary: 'See https://example.com/x: it explains why.' }),
    )
    expect(adr.summary).toBe('See https://example.com/x: it explains why.')
    expect(adr.warnings).toEqual([])
  })

  it('strips exactly one matching pair of quotes', () => {
    const adr = parseAdr(
      ID,
      frontmatter({
        title: '"Session cookies over JWT"',
        date: "'2026-08-08'",
        area: 'auth',
        summary: '""double wrapped""',
      }),
    )
    expect(adr.title).toBe('Session cookies over JWT')
    expect(adr.date).toBe('2026-08-08')
    expect(adr.summary).toBe('"double wrapped"')
    expect(adr.warnings).toEqual([])
  })

  it('leaves mismatched or single quote characters alone', () => {
    const adr = parseAdr(ID, frontmatter({ ...BASE, title: '"unbalanced\'', area: '"' }))
    expect(adr.title).toBe('"unbalanced\'')
    expect(adr.area).toBe('"')
  })

  it('tolerates CRLF line endings', () => {
    const adr = parseAdr(ID, frontmatter(BASE).replace(/\n/g, '\r\n'))
    expect(adr.warnings).toEqual([])
    expect(adr.title).toBe('Session cookies over JWT')
    expect(adr.area).toBe('auth')
  })

  it('ignores blank lines inside the frontmatter', () => {
    const adr = parseAdr(
      ID,
      '---\ntitle: A\n\ndate: 2026-08-08\narea: auth\nsummary: S\n---\nbody\n',
    )
    expect(adr.warnings).toEqual([])
    expect(adr.date).toBe('2026-08-08')
  })

  for (const field of REQUIRED) {
    it(`warns by name when '${field}' is missing, and still parses the rest`, () => {
      const fields = Object.fromEntries(Object.entries(BASE).filter(([key]) => key !== field))
      const adr = parseAdr(ID, frontmatter(fields))
      expect(adr.warnings.filter((w) => w.includes(`'${field}'`))).toHaveLength(1)
      expect(adr[field]).toBe('')
      for (const other of REQUIRED) {
        if (other !== field) expect(adr[other]).toBe(BASE[other])
      }
      expect(adr.body).toBe('## Context\nWhy.\n')
    })

    it(`warns by name when '${field}' is present but empty`, () => {
      const adr = parseAdr(ID, frontmatter({ ...BASE, [field]: '' }))
      expect(adr.warnings.filter((w) => w.includes(`'${field}'`))).toHaveLength(1)
      expect(adr[field]).toBe('')
    })
  }

  it('warns once per missing field when all four are absent', () => {
    const adr = parseAdr(ID, '---\n---\nbody\n')
    expect(adr.warnings).toHaveLength(4)
    for (const field of REQUIRED) {
      expect(adr.warnings.some((w) => w.includes(`'${field}'`))).toBe(true)
    }
    expect(adr.body).toBe('body\n')
  })

  it('warns on a malformed frontmatter line and still parses the other fields', () => {
    const content = [
      '---',
      'title: Session cookies over JWT',
      'this line has no colon',
      'date: 2026-08-08',
      'area: auth',
      'summary: Revocation has to take effect immediately.',
      '---',
      'body',
      '',
    ].join('\n')
    const adr = parseAdr(ID, content)
    expect(adr.warnings).toHaveLength(1)
    expect(adr.warnings[0]).toContain('line 3')
    expect(adr.title).toBe('Session cookies over JWT')
    expect(adr.date).toBe('2026-08-08')
    expect(adr.area).toBe('auth')
    expect(adr.summary).toBe('Revocation has to take effect immediately.')
  })

  it('treats a line with an empty key as malformed', () => {
    const adr = parseAdr(ID, frontmatter({ ...BASE, '': 'orphan' }))
    expect(adr.warnings).toHaveLength(1)
    expect(adr.warnings[0]).toContain('line 6')
  })

  it('warns about an unknown key and ignores it', () => {
    const adr = parseAdr(ID, frontmatter({ ...BASE, status: 'accepted' }))
    expect(adr.warnings).toHaveLength(1)
    expect(adr.warnings[0]).toContain('status')
    expect(adr.title).toBe('Session cookies over JWT')
    expect(Object.keys(adr)).not.toContain('status')
  })

  it('treats an empty supersedes as absent, without a warning', () => {
    const adr = parseAdr(ID, frontmatter({ ...BASE, supersedes: '' }))
    expect(adr.supersedes).toBeUndefined()
    expect(adr.warnings).toEqual([])
  })

  it('reports one warning and keeps the whole content as body when there is no frontmatter', () => {
    const content = '# Just a document\n\nNo frontmatter here.\n'
    const adr = parseAdr(ID, content)
    expect(adr.warnings).toHaveLength(1)
    expect(adr.body).toBe(content)
    expect(adr.title).toBe('')
    expect(adr.date).toBe('')
    expect(adr.area).toBe('')
    expect(adr.summary).toBe('')
    expect(adr.supersedes).toBeUndefined()
  })

  it('reports one warning and keeps the whole content when the fence is never closed', () => {
    const content = '---\ntitle: Session cookies over JWT\ndate: 2026-08-08\n'
    const adr = parseAdr(ID, content)
    expect(adr.warnings).toHaveLength(1)
    expect(adr.body).toBe(content)
    expect(adr.title).toBe('')
  })

  it('does not treat a fence that is not at the very start as frontmatter', () => {
    const content = '\n---\ntitle: A\n---\nbody\n'
    const adr = parseAdr(ID, content)
    expect(adr.warnings).toHaveLength(1)
    expect(adr.body).toBe(content)
  })

  it('never throws on hostile input', () => {
    const hostile = [
      '',
      '\n',
      '---',
      '---\n',
      '---\r\n',
      '-----',
      '---\n---',
      '---\n---\n',
      '---\ntitle\n---\n',
      '---\n:\n---\n',
      '---\n::::\n---\n',
      `---\ntitle: ${'x'.repeat(5000)}\n---\n`,
      `---\n${'k'.repeat(200)}: v\n---\n`,
      '\u0000\u0001\u001b[31m binary \ud800 bytes \ufffd',
      '---\n\u0000\u0001\ud800\n---\n\u0000',
      '---\ntitle: \u0000\ud800\n---\n',
    ]
    for (const content of hostile) {
      expect(() => parseAdr('hostile.md', content)).not.toThrow()
      const adr = parseAdr('hostile.md', content)
      expect(typeof adr.body).toBe('string')
      expect(Array.isArray(adr.warnings)).toBe(true)
    }
  })
})
