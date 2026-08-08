/**
 * Merge lumem's hooks into a JSON config file the user also owns.
 *
 * Claude Code's `.claude/settings.json` is a shared file: it carries the user's
 * `permissions`, `env`, `statusLine` and their own hooks. Replacing it would
 * destroy live configuration, so the descriptor marks it `merge-json` and lumem
 * only ever adds entries under `hooks.<EventName>`, leaving every other byte of
 * meaning alone. JSON has no comments, so ownership is recorded in-band: each
 * injected entry carries a `"__lumem__": true` property, which harnesses ignore
 * as an unknown key and uninstall uses to remove exactly what lumem added.
 */

/** Property stamped on every hook entry lumem injects into a shared config. */
export const LUMEM_MARKER = '__lumem__'

export interface MergeResult {
  /** Full file content to write: 2-space JSON with a trailing newline. */
  content: string
  /** The `hooks.<Event>` paths lumem owns entries under, in template order. */
  ownedKeys: string[]
  /**
   * Set when `existing` could not be merged — unparseable JSON, or a shape that
   * is not a hooks config. The content is then lumem's alone, so the caller must
   * back the destination up before writing: a file we cannot read is still the
   * user's.
   */
  replacedInvalid?: boolean
}

type JsonObject = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse `text` as a JSON object; undefined when it is neither. */
function parseObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function serialize(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function isLumemOwned(entry: unknown): boolean {
  return isPlainObject(entry) && entry[LUMEM_MARKER] === true
}

/** Copy of `entry` with the ownership marker as its first property. */
function tagOwned(entry: JsonObject): JsonObject {
  const tagged: JsonObject = { [LUMEM_MARKER]: true }
  for (const [key, value] of Object.entries(entry)) {
    if (key !== LUMEM_MARKER) tagged[key] = value
  }
  return tagged
}

/** The template is lumem's own asset: anything unexpected in it is a packaging bug. */
function readRendered(rendered: string): { object: JsonObject; hooks: JsonObject } {
  const object = parseObject(rendered)
  if (object === undefined) {
    throw new Error('mergeHookConfig: the rendered hook config is not a JSON object')
  }
  const hooks = object.hooks ?? {}
  if (!isPlainObject(hooks)) {
    throw new Error("mergeHookConfig: the rendered hook config's 'hooks' is not a JSON object")
  }
  return { object, hooks }
}

function renderedEntries(value: unknown, event: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`mergeHookConfig: rendered 'hooks.${event}' is not an array`)
  }
  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new Error(`mergeHookConfig: rendered 'hooks.${event}' holds a non-object entry`)
    }
    return entry
  })
}

/**
 * Whether `existing` is shaped like a hooks config for the events lumem writes.
 * A `hooks` value that is not an object, or an event array that is not an array,
 * cannot be merged into without guessing — and lumem never guesses about user
 * content, it backs it up instead.
 */
function isMergeable(existing: JsonObject, renderedHooks: JsonObject): boolean {
  const hooks = existing.hooks
  if (hooks === undefined) return true
  if (!isPlainObject(hooks)) return false
  for (const event of Object.keys(renderedHooks)) {
    const current = hooks[event]
    if (current !== undefined && !Array.isArray(current)) return false
  }
  return true
}

/**
 * Build the merged document: every key of `base` survives in its original
 * position, and each rendered event array gets the user's entries (minus any
 * previous lumem entry, which is what makes re-running idempotent) followed by
 * lumem's freshly rendered, marked ones.
 */
function build(base: JsonObject, renderedHooks: JsonObject): MergeResult {
  const merged: JsonObject = { ...base }
  const baseHooks = isPlainObject(base.hooks) ? base.hooks : {}
  const hooks: JsonObject = { ...baseHooks }
  const ownedKeys: string[] = []

  for (const [event, value] of Object.entries(renderedHooks)) {
    const injected = renderedEntries(value, event).map(tagOwned)
    const current = hooks[event]
    const userEntries = Array.isArray(current) ? current.filter((e) => !isLumemOwned(e)) : []
    hooks[event] = [...userEntries, ...injected]
    ownedKeys.push(`hooks.${event}`)
  }

  if (base.hooks !== undefined || Object.keys(hooks).length > 0) merged.hooks = hooks
  return { content: serialize(merged), ownedKeys }
}

/**
 * Merge lumem's rendered hook config into `existing`.
 *
 * - `existing` missing, empty or whitespace-only: the rendered template, tagged.
 * - `existing` a hooks-shaped JSON object: lumem's entries are appended to the
 *   user's arrays and every other key passes through untouched. Re-running
 *   replaces lumem's previous entries rather than duplicating them.
 * - `existing` anything else: the rendered template again, with
 *   `replacedInvalid` set so the caller backs the file up first.
 */
export function mergeHookConfig(existing: string | undefined, rendered: string): MergeResult {
  const { object, hooks: renderedHooks } = readRendered(rendered)

  const freshBase: JsonObject = { ...object }
  if (freshBase.hooks !== undefined) freshBase.hooks = {}

  if (existing === undefined || existing.trim() === '') return build(freshBase, renderedHooks)

  const base = parseObject(existing)
  if (base === undefined || !isMergeable(base, renderedHooks)) {
    return { ...build(freshBase, renderedHooks), replacedInvalid: true }
  }
  return build(base, renderedHooks)
}

/**
 * Remove lumem's entries from a merged config.
 *
 * Every `__lumem__`-marked entry is dropped, event arrays emptied by that removal
 * are pruned, and a `hooks` object left with no events goes too. Everything else
 * — user hooks, unrelated top-level keys — survives; a file holding nothing of
 * lumem's is returned byte-for-byte, and one that cannot be parsed is returned
 * untouched rather than rewritten.
 *
 * Returns undefined when nothing but lumem's content remained, i.e. the caller
 * should delete the file.
 *
 * `ownedKeys` (as recorded by `mergeHookConfig`) restricts the sweep to those
 * `hooks.<Event>` paths; without it every event is swept.
 */
export function unmergeHookConfig(existing: string, ownedKeys?: string[]): string | undefined {
  const object = parseObject(existing)
  if (object === undefined) return existing

  const hooks = object.hooks
  const swept = isPlainObject(hooks) ? sweepHooks(hooks, ownedKeys) : undefined

  const result: JsonObject = {}
  for (const [key, value] of Object.entries(object)) {
    if (key === 'hooks' && swept !== undefined) {
      // a hooks object left with no events goes with them
      if (Object.keys(swept.kept).length > 0) result.hooks = swept.kept
      continue
    }
    result[key] = value
  }

  if (Object.keys(result).length === 0) return undefined
  return swept?.removed === true ? serialize(result) : existing
}

/** Drop lumem's entries from each swept event, pruning the arrays they emptied. */
function sweepHooks(
  hooks: JsonObject,
  ownedKeys: string[] | undefined,
): { kept: JsonObject; removed: boolean } {
  const kept: JsonObject = {}
  let removed = false

  for (const [event, value] of Object.entries(hooks)) {
    const swept = ownedKeys === undefined || ownedKeys.includes(`hooks.${event}`)
    if (!swept || !Array.isArray(value)) {
      kept[event] = value
      continue
    }
    const survivors = value.filter((entry) => !isLumemOwned(entry))
    if (survivors.length !== value.length) removed = true
    // an array that was already empty is the user's, not ours to prune
    if (survivors.length > 0 || value.length === 0) kept[event] = survivors
  }

  return { kept, removed }
}
