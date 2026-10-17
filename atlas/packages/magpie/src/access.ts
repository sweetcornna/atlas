// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The L-6 guard (charter §5.2 ③): a key Qianmo issues reaches API-key
 * providers only, never a signed-in subscription or a borrowed client
 * identity.
 *
 * magpie holds a key to its model list (`access.Key.Models`), where an
 * empty list means every model and a group the key names grants every
 * member that group has at request time (`gateway/key_models.go`). So a
 * key's list is always written out in full, from what is eligible now:
 *
 * - `<provider>/*` for each API-key provider (on or off: switching one on
 *   later is not a change of class);
 * - `group/<id>` for each group all of whose members, named or matched,
 *   are of API-key providers or such groups, whose patterns can only ever
 *   match one API-key provider's models (a literal `<provider>/` before any
 *   `*`; never `re:`), and whose classifier, when it has one, is eligible
 *   too.
 *
 * When nothing is eligible, the list is one model no provider serves
 * (`NO_MODEL_PATTERN`), never empty.
 */

import type { MagpieGroup, MagpieProvider } from './types.js'

/** A model id no magpie provider serves: the list of a key that may use nothing. */
export const NO_MODEL_PATTERN = 'qianmo-none/none'

/** magpie's prefix for a routing group's id (`provider.GroupPrefix`). */
const GROUP_PREFIX = 'group/'

interface Eligibility {
  readonly providers: ReadonlySet<string>
  readonly groups: ReadonlySet<string>
}

function keyProviders(providers: readonly MagpieProvider[]): Set<string> {
  return new Set(
    providers
      .filter(provider => provider.access === 'key')
      .map(provider => provider.id.toLowerCase()),
  )
}

/**
 * The provider a member or pattern can reach, when it can only ever reach
 * one: the literal text before the first `/`, with no `*` before it.
 */
function providerOf(pattern: string): string | null {
  const slash = pattern.indexOf('/')
  if (slash <= 0) return null
  const star = pattern.indexOf('*')
  if (star !== -1 && star < slash) return null
  return pattern.slice(0, slash).toLowerCase()
}

function eligibility(
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): Eligibility {
  const keyed = keyProviders(providers)
  const byId = new Map(groups.map(group => [group.id.toLowerCase(), group]))
  const verdicts = new Map<string, boolean>()

  const memberOk = (member: string, path: ReadonlySet<string>): boolean => {
    const trimmed = member.trim()
    if (trimmed.toLowerCase().startsWith(GROUP_PREFIX)) {
      const id = trimmed.slice(GROUP_PREFIX.length).toLowerCase()
      if (id.includes('*')) return false
      return groupOk(id, path)
    }
    if (trimmed.startsWith('re:')) return false
    const provider = providerOf(trimmed)
    return provider !== null && provider !== 'group' && keyed.has(provider)
  }

  const groupOk = (id: string, path: ReadonlySet<string>): boolean => {
    const known = verdicts.get(id)
    if (known !== undefined) return known
    if (path.has(id)) return false
    const group = byId.get(id)
    if (group === undefined) return false
    const inner = new Set(path).add(id)
    const members = [...group.members, ...group.matched]
    const ok =
      members.length > 0 &&
      members.every(member => memberOk(member, inner)) &&
      group.match.every(pattern => memberOk(pattern, inner)) &&
      (group.classifier === '' || memberOk(group.classifier, inner))
    verdicts.set(id, ok)
    return ok
  }

  const eligibleGroups = new Set<string>()
  for (const group of groups) {
    if (groupOk(group.id.toLowerCase(), new Set())) {
      eligibleGroups.add(group.id.toLowerCase())
    }
  }
  return { providers: keyed, groups: eligibleGroups }
}

/** Whether a group may be named in a Qianmo key's list. */
export function groupEligible(
  group: MagpieGroup,
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): boolean {
  return eligibility(providers, groups).groups.has(group.id.toLowerCase())
}

/** The full list a Qianmo key is held to: everything eligible now. */
export function eligiblePatterns(
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): readonly string[] {
  const { providers: keyed, groups: eligibleGroups } = eligibility(
    providers,
    groups,
  )
  const out = [
    ...providers
      .filter(provider => keyed.has(provider.id.toLowerCase()))
      .map(provider => `${provider.id}/*`),
    ...groups
      .filter(group => eligibleGroups.has(group.id.toLowerCase()))
      .map(group => `${GROUP_PREFIX}${group.id}`),
  ]
  return out.length === 0 ? [NO_MODEL_PATTERN] : out
}

/**
 * The patterns of `patterns` that could reach something not eligible: a
 * pattern is fine when it can only match one API-key provider's models
 * (`openai/gpt-5`, `openai/*`), or names an eligible group exactly.
 */
export function ineligiblePatterns(
  patterns: readonly string[],
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): readonly string[] {
  const { providers: keyed, groups: eligibleGroups } = eligibility(
    providers,
    groups,
  )
  return patterns.filter(raw => {
    const pattern = raw.trim()
    if (pattern === NO_MODEL_PATTERN) return false
    if (pattern.toLowerCase().startsWith(GROUP_PREFIX)) {
      const id = pattern.slice(GROUP_PREFIX.length).toLowerCase()
      return id.includes('*') || !eligibleGroups.has(id)
    }
    if (pattern.startsWith('re:')) return true
    const provider = providerOf(pattern)
    return provider === null || provider === 'group' || !keyed.has(provider)
  })
}

/** Whether a key's list stays within what is eligible, and is not empty. */
export function patternsConfined(
  patterns: readonly string[],
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): boolean {
  return (
    patterns.length > 0 &&
    ineligiblePatterns(patterns, providers, groups).length === 0
  )
}
