import { z } from 'zod'

const kebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const detectRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dir'), path: z.string().min(1) }),
  z.object({
    type: z.literal('bin'),
    name: z.string().min(1),
    versionArgs: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('file'), path: z.string().min(1) }),
])

export const injectionMechanismSchema = z.enum([
  'hook-stdout',
  'context-doc-block',
  'skill-instruction',
])

export const adapterDescriptorSchema = z.object({
  id: z.string().min(1).regex(kebabCase, 'must be kebab-case'),
  minVersion: z.string().min(1),
  detect: z.array(detectRuleSchema).min(1),
  paths: z.object({
    home: z.string(),
    skills: z.object({
      project: z.string(),
      global: z.string(),
    }),
    hooksConfig: z.array(
      z.object({
        scope: z.enum(['project', 'global']),
        path: z.string(),
        format: z.literal('json'),
        strategy: z.enum(['merge-json', 'own-file']),
      }),
    ),
    contextDoc: z
      .object({
        project: z.string(),
        maxBytes: z.number().int().positive(),
      })
      .optional(),
  }),
  capabilities: z.object({
    'hooks.sessionStart': z.boolean(),
    'hooks.sessionEnd': z.boolean(),
    'hooks.userPromptSubmit': z.boolean(),
    'hooks.postToolUse': z.boolean(),
    'hooks.envProjectDir': z.boolean(),
    'hooks.requiresTrust': z.boolean(),
    'hooks.stdoutInjection': z.boolean(),
    'platform.windows': z.boolean(),
    /**
     * The harness can run an independent agent that did not author the work.
     * Optional: a descriptor written before verification was graded stays valid,
     * and an absent value reads as "no", which degrades rather than assumes.
     */
    'agents.subagents': z.boolean().optional(),
  }),
  eventMap: z.object({
    inject: z.string().optional(),
    capturePrompt: z.string().optional(),
    captureTool: z.string().optional(),
    /**
     * The harness event for a tool call that FAILED, when the harness has one.
     *
     * Optional because it is a per-harness fact, not a lumem-wide one (principle
     * 5: which events a harness exposes is descriptor data). Claude Code fires
     * `PostToolUse` only after a call succeeds and routes failures to a separate
     * `PostToolUseFailure`, so it needs both subscriptions; Codex has no failure
     * variant among its events, so its `PostToolUse` covers both outcomes and
     * this key stays absent.
     */
    captureToolFailure: z.string().optional(),
    end: z.string().optional(),
  }),
  injection: z.array(injectionMechanismSchema).min(1),
  headless: z.object({
    command: z.array(z.string()).min(1),
    promptVia: z.enum(['stdin', 'arg']),
    modelFlag: z.string().optional(),
    defaultModel: z.string().optional(),
  }),
})

export type DetectRule = z.infer<typeof detectRuleSchema>
export type InjectionMechanism = z.infer<typeof injectionMechanismSchema>
export type AdapterDescriptor = z.infer<typeof adapterDescriptorSchema>
