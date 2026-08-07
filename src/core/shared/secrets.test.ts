import { describe, expect, it } from 'vitest'
import { hasSecrets, scanSecrets } from './secrets'

// Fake tokens for testing only — never real credentials.
const GH_TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const NPM_TOKEN = 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'
const RANDOM_20A = 'q7W9eR2tY4uI6oP1aS3d'
const RANDOM_20B = 'Z8xC5vB2nM4kJ6hG1fD3'
const RANDOM_20C = 'L9sK2dJ5fH8gF1hG4jX7'
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

describe('scanSecrets: known token formats', () => {
  it('flags an AWS access key id in prose', () => {
    const text = 'configured with AKIAIOSFODNN7EXAMPLE for s3'
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('aws-access-key')
    expect(hits[0]?.index).toBe(text.indexOf('AKIA'))
    expect(hits[0]?.excerpt).toBe('AKIA…')
  })

  it('flags a GitHub token', () => {
    const text = `remote uses ${GH_TOKEN} for auth`
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('github-token')
    expect(hits[0]?.index).toBe(text.indexOf('ghp_'))
    expect(hits[0]?.excerpt).toBe('ghp_…')
  })

  it('flags a Slack bot token', () => {
    const hits = scanSecrets('bot token xoxb-123456789012-AbCdEfGh1234 here')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('slack-token')
    expect(hits[0]?.excerpt).toBe('xoxb…')
  })

  it('flags a Slack xoxc token', () => {
    const hits = scanSecrets('session xoxc-987654321098-ZyXwVuTsRq end')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('slack-token')
  })

  it('flags a plain private key header', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('private-key')
    expect(hits[0]?.index).toBe(0)
  })

  it('flags RSA and OPENSSH private key headers', () => {
    expect(scanSecrets('-----BEGIN RSA PRIVATE KEY-----')[0]?.kind).toBe('private-key')
    expect(scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')[0]?.kind).toBe('private-key')
  })

  it('flags a JWT', () => {
    const text = `auth header was Bearer ${JWT}`
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('jwt')
    expect(hits[0]?.index).toBe(text.indexOf('eyJ'))
  })

  it('flags an npm token', () => {
    const hits = scanSecrets(`publish with ${NPM_TOKEN}`)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('npm-token')
    expect(hits[0]?.excerpt).toBe('npm_…')
  })

  it('flags an OpenAI-style sk- key', () => {
    const hits = scanSecrets('openai key sk-proj-AbCd1234EfGh5678IjKl set')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('sk-token')
    expect(hits[0]?.excerpt).toBe('sk-p…')
  })

  it('flags an Anthropic sk-ant- key', () => {
    const hits = scanSecrets('use sk-ant-api03-AbCd1234EfGh5678IjKl here')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('sk-token')
    expect(hits[0]?.excerpt).toBe('sk-a…')
  })
})

describe('scanSecrets: env-style assignments', () => {
  it('flags a real value assigned to a PASSWORD-named var', () => {
    const text = 'DB_PASSWORD=hunter2hunter2'
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('env-secret')
    expect(hits[0]?.index).toBe(text.indexOf('hunter2'))
    expect(hits[0]?.excerpt).toBe('hunt…')
  })

  it('flags an exported SECRET-named var', () => {
    const hits = scanSecrets('export SESSION_SECRET=s3cr3t-value-42')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('env-secret')
    expect(hits[0]?.excerpt).toBe('s3cr…')
  })
})

describe('scanSecrets: entropy check on secret-ish assigned values', () => {
  it('flags a high-entropy value in lowercase key = value form', () => {
    const text = `password = ${RANDOM_20A}`
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('high-entropy')
    expect(hits[0]?.index).toBe(text.indexOf(RANDOM_20A))
  })

  it('flags a high-entropy value in yaml key: value form', () => {
    const hits = scanSecrets(`api_key: ${RANDOM_20B}`)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('high-entropy')
  })

  it('flags a high-entropy value in "key": "value" form', () => {
    const text = `"client_secret": "${RANDOM_20C}"`
    const hits = scanSecrets(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('high-entropy')
    expect(hits[0]?.index).toBe(text.indexOf(RANDOM_20C))
  })

  it('flags an AWS secret key when key-assigned', () => {
    const hits = scanSecrets(`aws_secret_access_key = ${AWS_SECRET}`)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('high-entropy')
    expect(hits[0]?.excerpt).toBe('wJal…')
  })
})

describe('scanSecrets: multiple secrets and dedupe', () => {
  it('reports multiple secrets with correct kinds in index order', () => {
    const text = [
      'aws AKIAIOSFODNN7EXAMPLE',
      `github ${GH_TOKEN}`,
      'DB_PASSWORD=hunter2hunter2',
    ].join('\n')
    const hits = scanSecrets(text)
    expect(hits.map((h) => h.kind)).toEqual(['aws-access-key', 'github-token', 'env-secret'])
    const indexes = hits.map((h) => h.index)
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
  })

  it('reports a known-format token assigned to a secret-ish env var only once', () => {
    const hits = scanSecrets(`GITHUB_TOKEN=${GH_TOKEN}`)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.kind).toBe('github-token')
  })
})

describe('scanSecrets: excerpts are redacted', () => {
  it('never includes the full secret in any excerpt', () => {
    const text = [
      `github ${GH_TOKEN}`,
      `password = ${RANDOM_20A}`,
      'export API_TOKEN=super-secret-value-99',
    ].join('\n')
    const hits = scanSecrets(text)
    expect(hits.length).toBeGreaterThanOrEqual(3)
    for (const hit of hits) {
      expect(hit.excerpt.endsWith('…')).toBe(true)
      expect(hit.excerpt.length).toBe(5)
      expect(GH_TOKEN.includes(hit.excerpt)).toBe(false)
      expect(RANDOM_20A.includes(hit.excerpt)).toBe(false)
    }
  })
})

describe('scanSecrets: never flags (negative corpus)', () => {
  const negatives: Array<[name: string, text: string]> = [
    [
      'bare 40-char git SHA in prose',
      'deployed commit 3f2a8c9d4e5b6a7f8091a2b3c4d5e6f708192a3b to prod',
    ],
    ['UUID in prose', 'request id 550e8400-e29b-41d4-a716-446655440000 failed'],
    [
      'plain URL without credentials',
      'see https://api.example.com/v1/users?page=2&limit=50 for details',
    ],
    [
      'base64-ish string not assigned to a secret key',
      "const data = 'aGVsbG9Xb3JsZEZvb0JhckJhelF1dXg='",
    ],
    [
      'normal code (imports and functions)',
      "import path from 'node:path'\nexport function resolveConfig(base: string): string {\n  return path.join(base, 'config.json')\n}",
    ],
    [
      'sha256 hex in a lockfile-like line',
      '"hash": "a3f5b8c2d4e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"',
    ],
    ['DEBUG=true', 'DEBUG=true'],
    ['PORT=8080', 'PORT=8080'],
    ['xxx placeholder', 'SECRET_TOKEN=xxxxxxxxxxxx'],
    ['dots placeholder', 'SECRET=........'],
    ['angle-bracket placeholder', 'PASSWORD=<your-password>'],
    ['shell interpolation placeholder', 'API_KEY=${API_KEY}'],
    ['changeme placeholder', 'DB_PASSWORD=changeme'],
    ['your-* placeholder', 'API_TOKEN=your-token-here'],
    ['short value on secret-ish name', 'AUTH_PORT=443'],
    ['low-entropy long value on secret-ish name', 'password = aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['long angle-bracket placeholder on secret-ish key', 'password: <your-password-goes-here>'],
    ['hyphenated word ending in sk', 'open the task-management-dashboard-view component'],
  ]

  for (const [name, text] of negatives) {
    it(`does not flag ${name}`, () => {
      expect(scanSecrets(text)).toEqual([])
      expect(hasSecrets(text)).toBe(false)
    })
  }
})

describe('hasSecrets', () => {
  it('returns true when any secret is present', () => {
    expect(hasSecrets(`token ${GH_TOKEN}`)).toBe(true)
  })

  it('returns false for clean prose and empty input', () => {
    expect(hasSecrets('remember: the build uses node 20 and vitest')).toBe(false)
    expect(hasSecrets('')).toBe(false)
  })
})
