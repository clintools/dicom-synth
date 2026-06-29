import type { DicomTagOverrides } from '../schema/types.js'

// Per-file generation context that placeholder tokens resolve against. index is
// always available; the study/series/instance positions exist only inside
// grouped studies (a flat entry has no instanceNumber).
export type TagContext = {
  index: number
  studyIndex?: number
  seriesIndex?: number
  instanceNumber?: number
}

// Placeholder tokens accepted in string tag values (e.g. "P{studyIndex}").
export const TEMPLATE_VOCAB = [
  'index',
  'studyIndex',
  'seriesIndex',
  'instanceNumber',
] as const

// Matches an escaped brace (`{{`/`}}`) or a `{token}`. Doubling lets verbatim
// values (e.g. describe-captured tags) carry literal braces; only single-brace
// `{token}` is substituted.
const TEMPLATE_PART_RE = /\{\{|\}\}|\{([a-zA-Z]+)\}/g

// Escape literal braces in a value so it survives template resolution unchanged.
// Used when capturing real tag values that must be reproduced verbatim.
export function escapeTagTemplate(value: string): string {
  return value.replace(/\{/g, '{{').replace(/\}/g, '}}')
}

// The single-brace placeholder token names in a value, ignoring escaped braces.
export function findTemplateTokens(value: string): string[] {
  const names: string[] = []
  for (const m of value.matchAll(TEMPLATE_PART_RE)) {
    if (m[1] !== undefined) names.push(m[1])
  }
  return names
}

// Substitutes {token} placeholders in string tag values using the generation
// context. Pure — returns a new object, leaving non-string values untouched.
// `{{`/`}}` are unescaped to literal braces. Throws on an unknown single-brace
// token or one whose variable is absent in this context (e.g. {instanceNumber}
// on a flat entry).
export function resolveTagTemplates(
  tags: DicomTagOverrides | undefined,
  context: TagContext,
): DicomTagOverrides | undefined {
  if (!tags) return tags
  const resolved: DicomTagOverrides = {}
  for (const [key, value] of Object.entries(tags)) {
    resolved[key] =
      typeof value === 'string' ? resolveString(value, context) : value
  }
  return resolved
}

function resolveString(value: string, context: TagContext): string {
  return value.replace(TEMPLATE_PART_RE, (match, name: string | undefined) => {
    if (name === undefined) return match === '{{' ? '{' : '}'
    if (!(TEMPLATE_VOCAB as readonly string[]).includes(name)) {
      throw new Error(
        `tag template: unknown placeholder "{${name}}" — allowed: ${TEMPLATE_VOCAB.map((v) => `{${v}}`).join(', ')}`,
      )
    }
    const resolved = context[name as keyof TagContext]
    if (resolved === undefined) {
      throw new Error(
        `tag template: placeholder "{${name}}" is not available here — it only applies inside grouped studies`,
      )
    }
    return String(resolved)
  })
}
