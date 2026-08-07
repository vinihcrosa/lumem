import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWrite, expandHome, readJsonSafe, sha256 } from './fsx'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-'))
}

describe('atomicWrite', () => {
  it('writes content and creates parent directories', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'a', 'b', 'c.txt')
    atomicWrite(target, 'hello')
    expect(fs.readFileSync(target, 'utf8')).toBe('hello')
  })

  it('leaves no .tmp residue after success', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'file.txt')
    atomicWrite(target, 'data')
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('overwrites an existing file', () => {
    const dir = tmpDir()
    const target = path.join(dir, 'file.txt')
    atomicWrite(target, 'first')
    atomicWrite(target, 'second')
    expect(fs.readFileSync(target, 'utf8')).toBe('second')
  })

  it('on failure does not corrupt an existing sibling file and cleans temp', () => {
    const dir = tmpDir()
    // an existing destination file we must not corrupt
    const existing = path.join(dir, 'existing.txt')
    fs.writeFileSync(existing, 'precious')
    // target path is a non-empty directory -> renameSync fails
    const target = path.join(dir, 'blocked')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'inner.txt'), 'x')

    expect(() => atomicWrite(target, 'new content')).toThrow()

    expect(fs.readFileSync(existing, 'utf8')).toBe('precious')
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('expandHome', () => {
  it('expands ~ to the home directory', () => {
    expect(expandHome('~')).toBe(os.homedir())
  })

  it('expands ~/x under the home directory', () => {
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'))
  })

  it('returns absolute paths untouched', () => {
    expect(expandHome('/abs')).toBe('/abs')
  })

  it('returns relative paths untouched', () => {
    expect(expandHome('rel')).toBe('rel')
  })

  it('does not expand ~user style paths', () => {
    expect(expandHome('~other/x')).toBe('~other/x')
  })
})

describe('sha256', () => {
  it('matches a known vector for a string input', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('matches a known vector for the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('accepts a Buffer input', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('readJsonSafe', () => {
  it('parses a valid JSON file', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'valid.json')
    fs.writeFileSync(file, JSON.stringify({ a: 1, b: 'two' }))
    expect(readJsonSafe<{ a: number; b: string }>(file)).toEqual({ a: 1, b: 'two' })
  })

  it('returns undefined for a missing file', () => {
    const dir = tmpDir()
    expect(readJsonSafe(path.join(dir, 'nope.json'))).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, '{ not json !!!')
    expect(readJsonSafe(file)).toBeUndefined()
  })
})
