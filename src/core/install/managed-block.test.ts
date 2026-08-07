import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readManagedBlock, removeManagedBlock, upsertManagedBlock } from './managed-block'

const START = '<!-- lumem:start -->'
const END = '<!-- lumem:end -->'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lumem-'))
}

function tmpFile(name = 'target.md'): string {
  return path.join(tmpDir(), name)
}

describe('upsertManagedBlock', () => {
  it('creates the file containing only the block when the file is absent', () => {
    const file = tmpFile()
    const res = upsertManagedBlock(file, 'hello\nworld')
    expect(res).toEqual({ action: 'created-file', truncated: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(`${START}\nhello\nworld\n${END}\n`)
  })

  it('creates parent directories and leaves no .tmp residue', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a', 'b', 'notes.md')
    const res = upsertManagedBlock(file, 'x')
    expect(res.action).toBe('created-file')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${START}\nx\n${END}\n`)
    const leftovers = fs.readdirSync(path.join(dir, 'a', 'b')).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('renders an empty block when blockContent is empty', () => {
    const file = tmpFile()
    upsertManagedBlock(file, '')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${START}\n${END}\n`)
  })

  it('round-trips blockContent through readManagedBlock', () => {
    const file = tmpFile()
    upsertManagedBlock(file, 'a\nb\nc')
    expect(readManagedBlock(file)).toBe('a\nb\nc')
  })

  it('appends after existing content (with trailing newline) separated by exactly one blank line', () => {
    const file = tmpFile()
    fs.writeFileSync(file, '# Title\n\nsome text\n')
    const res = upsertManagedBlock(file, 'block')
    expect(res).toEqual({ action: 'created-block', truncated: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(`# Title\n\nsome text\n\n${START}\nblock\n${END}\n`)
  })

  it('appends after existing content without trailing newline, preserving every byte', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'no trailing newline')
    const res = upsertManagedBlock(file, 'block')
    expect(res.action).toBe('created-block')
    expect(fs.readFileSync(file, 'utf8')).toBe(`no trailing newline\n\n${START}\nblock\n${END}\n`)
  })

  it('does not add a separator when existing content already ends with a blank line', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'text\n\n')
    upsertManagedBlock(file, 'block')
    expect(fs.readFileSync(file, 'utf8')).toBe(`text\n\n${START}\nblock\n${END}\n`)
  })

  it('appends to an existing empty file without a leading separator', () => {
    const file = tmpFile()
    fs.writeFileSync(file, '')
    const res = upsertManagedBlock(file, 'block')
    expect(res.action).toBe('created-block')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${START}\nblock\n${END}\n`)
  })

  it('replaces only the content between markers, preserving surrounding bytes exactly', () => {
    const file = tmpFile()
    const before = `abc  \t${START}\nold stuff\n${END}   trailing\n\n\n`
    fs.writeFileSync(file, before)
    const res = upsertManagedBlock(file, 'new stuff')
    expect(res).toEqual({ action: 'updated', truncated: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `abc  \t${START}\nnew stuff\n${END}   trailing\n\n\n`,
    )
  })

  it('returns unchanged when the resulting file is byte-identical', () => {
    const file = tmpFile()
    upsertManagedBlock(file, 'same')
    const bytes = fs.readFileSync(file, 'utf8')
    const res = upsertManagedBlock(file, 'same')
    expect(res).toEqual({ action: 'unchanged', truncated: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
  })

  it('honors only the first start marker and the first end marker after it', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `${START}\na\n${START}\nb\n${END}\nc\n${END}\n`)
    const res = upsertManagedBlock(file, 'z')
    expect(res.action).toBe('updated')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${START}\nz\n${END}\nc\n${END}\n`)
  })

  it('treats a missing end marker as no block and appends a fresh block at end', () => {
    const file = tmpFile()
    const orphan = `user text\n${START}\nunterminated\n`
    fs.writeFileSync(file, orphan)
    const res = upsertManagedBlock(file, 'fresh')
    expect(res.action).toBe('created-block')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${orphan}\n${START}\nfresh\n${END}\n`)
  })

  describe('maxFileBytes', () => {
    it('reports truncated=false when the block fits', () => {
      const file = tmpFile()
      const res = upsertManagedBlock(file, 'aaaa\nbbbb', { maxFileBytes: 10_000 })
      expect(res).toEqual({ action: 'created-file', truncated: false })
      expect(readManagedBlock(file)).toBe('aaaa\nbbbb')
    })

    it('truncates whole lines from the end of blockContent until the file fits', () => {
      const probe = tmpFile()
      upsertManagedBlock(probe, 'aaaa\nbbbb\ncccc')
      const fullBytes = fs.statSync(probe).size

      const file = tmpFile()
      const res = upsertManagedBlock(file, 'aaaa\nbbbb\ncccc', { maxFileBytes: fullBytes - 1 })
      expect(res).toEqual({ action: 'created-file', truncated: true })
      expect(readManagedBlock(file)).toBe('aaaa\nbbbb')
      expect(fs.statSync(file).size).toBeLessThanOrEqual(fullBytes - 1)
    })

    it('never truncates user content: writes an empty block when even that does not fit', () => {
      const file = tmpFile()
      const user = `${'x'.repeat(100)}\n`
      fs.writeFileSync(file, user)
      const res = upsertManagedBlock(file, 'content', { maxFileBytes: 10 })
      expect(res).toEqual({ action: 'created-block', truncated: true })
      const text = fs.readFileSync(file, 'utf8')
      expect(text.startsWith(user)).toBe(true)
      expect(text).toBe(`${user}\n${START}\n${END}\n`)
      expect(readManagedBlock(file)).toBe('')
    })

    it('truncates when updating an existing block, preserving bytes outside it', () => {
      const file = tmpFile()
      fs.writeFileSync(file, `keep\n\n${START}\nold\n${END}\n`)
      const emptyBlockSize = Buffer.byteLength(`keep\n\n${START}\n${END}\n`)
      const res = upsertManagedBlock(file, 'line1\nline2', { maxFileBytes: emptyBlockSize + 6 })
      expect(res.action).toBe('updated')
      expect(res.truncated).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe(`keep\n\n${START}\nline1\n${END}\n`)
    })
  })
})

describe('removeManagedBlock', () => {
  it('removes the block and the separating blank line lumem added at the end', () => {
    const file = tmpFile()
    fs.writeFileSync(file, '# Title\n\ncontent\n')
    upsertManagedBlock(file, 'managed')
    const res = removeManagedBlock(file)
    expect(res).toEqual({ removed: true, fileDeleted: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('# Title\n\ncontent\n')
  })

  it('deletes the file entirely when only whitespace would remain', () => {
    const file = tmpFile()
    upsertManagedBlock(file, 'managed')
    const res = removeManagedBlock(file)
    expect(res).toEqual({ removed: true, fileDeleted: true })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('removes a block in the middle, preserving bytes before and after', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `pre\n${START}\nmanaged\n${END}\npost\n`)
    const res = removeManagedBlock(file)
    expect(res).toEqual({ removed: true, fileDeleted: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('pre\n\npost\n')
  })

  it('removes only the first marker pair when multiple blocks exist', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `${START}\none\n${END}\n${START}\ntwo\n${END}\n`)
    const res = removeManagedBlock(file)
    expect(res.removed).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain(`${START}\ntwo\n${END}`)
  })

  it('returns removed=false when the file has no block', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'just text\n')
    expect(removeManagedBlock(file)).toEqual({ removed: false, fileDeleted: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('just text\n')
  })

  it('returns removed=false when the end marker is missing, leaving content intact', () => {
    const file = tmpFile()
    const orphan = `text\n${START}\nno end\n`
    fs.writeFileSync(file, orphan)
    expect(removeManagedBlock(file)).toEqual({ removed: false, fileDeleted: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(orphan)
  })

  it('returns removed=false when the file does not exist', () => {
    expect(removeManagedBlock(tmpFile())).toEqual({ removed: false, fileDeleted: false })
  })
})

describe('readManagedBlock', () => {
  it('returns undefined when the file does not exist', () => {
    expect(readManagedBlock(tmpFile())).toBeUndefined()
  })

  it('returns undefined when the file has no block', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'plain\n')
    expect(readManagedBlock(file)).toBeUndefined()
  })

  it('returns undefined when the end marker is missing', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `${START}\nno end\n`)
    expect(readManagedBlock(file)).toBeUndefined()
  })

  it('reads the content between markers of a hand-written block', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `before\n${START}\nalpha\nbeta\n${END}\nafter\n`)
    expect(readManagedBlock(file)).toBe('alpha\nbeta')
  })

  it('returns the empty string for an empty block', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `${START}\n${END}\n`)
    expect(readManagedBlock(file)).toBe('')
  })

  it('reads only the first block when multiple exist', () => {
    const file = tmpFile()
    fs.writeFileSync(file, `${START}\none\n${END}\n${START}\ntwo\n${END}\n`)
    expect(readManagedBlock(file)).toBe('one')
  })
})
