// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 形象: the little figure each agent and each person wears in the console.
 *
 * A figure is seven choices (形态、颜色、材质、眼睛、嘴巴、腮红、配饰), every one
 * from a short closed list, and one state (待机、倾听、思考、回复、完成、出错、
 * 休眠) the page works out and never saves. Every choice is checked against
 * its list, so a saved figure is data the server can check and draw — never
 * markup somebody sent. Nobody has to pick: an agent or a person
 * without a saved figure gets one drawn from their own address or subject, the
 * same one on every page and every reload ({@link defaultAvatar}).
 *
 * Drawing lives in `view/avatar.ts`; storage behind {@link AvatarsPort}.
 */

import type { ConsoleResult } from './contracts.js'
import type { DirectionActor } from './directionPorts.js'

export const AVATAR_SHAPES = [
  'orb',
  'capsule',
  'drop',
  'cloud',
  'pebble',
  'squircle',
] as const
export type AvatarShape = (typeof AVATAR_SHAPES)[number]

export const AVATAR_COLORS = [
  'mist',
  'lake',
  'sage',
  'sand',
  'apricot',
  'clay',
  'blush',
  'lilac',
  'cloud',
  'ink',
] as const
export type AvatarColor = (typeof AVATAR_COLORS)[number]

export const AVATAR_MATERIALS = ['matte', 'plush', 'glaze'] as const
export type AvatarMaterial = (typeof AVATAR_MATERIALS)[number]

export const AVATAR_EYES = [
  'dot',
  'oval',
  'wide',
  'square',
  'ring',
  'spark',
] as const
export type AvatarEyes = (typeof AVATAR_EYES)[number]

export const AVATAR_MOUTHS = ['none', 'smile', 'dot', 'cat'] as const
export type AvatarMouth = (typeof AVATAR_MOUTHS)[number]

export const AVATAR_ACCESSORIES = [
  'none',
  'beret',
  'headphones',
  'halo',
  'antenna',
  'sprout',
  'glasses',
] as const
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number]

/**
 * What the figure is doing. Not saved: the page works it out from the
 * conversation (`view/chat.ts`), and the script moves it while somebody types
 * or sends.
 */
export const AVATAR_STATES = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'error',
  'sleep',
] as const
export type AvatarState = (typeof AVATAR_STATES)[number]

export interface AvatarSpec {
  readonly shape: AvatarShape
  readonly color: AvatarColor
  readonly material: AvatarMaterial
  readonly eyes: AvatarEyes
  readonly mouth: AvatarMouth
  readonly cheeks: boolean
  readonly accessory: AvatarAccessory
}

/** The words the editor shows for each choice. */
export const AVATAR_WORDS = {
  shape: {
    orb: '圆',
    capsule: '胶囊',
    drop: '水滴',
    cloud: '云',
    pebble: '卵石',
    squircle: '方圆',
  },
  color: {
    mist: '雾蓝',
    lake: '湖青',
    sage: '鼠尾草',
    sand: '沙',
    apricot: '杏',
    clay: '陶',
    blush: '藕粉',
    lilac: '丁香',
    cloud: '云白',
    ink: '墨',
  },
  material: { matte: '雾面', plush: '绒', glaze: '釉' },
  eyes: {
    dot: '圆点',
    oval: '椭圆',
    wide: '亮眼',
    square: '方点',
    ring: '圆环',
    spark: '星点',
  },
  mouth: { none: '无', smile: '微笑', dot: '小点', cat: '猫嘴' },
  accessory: {
    none: '无',
    beret: '贝雷帽',
    headphones: '耳机',
    halo: '光环',
    antenna: '天线',
    sprout: '嫩芽',
    glasses: '眼镜',
  },
  state: {
    idle: '待机',
    listening: '倾听',
    thinking: '思考',
    speaking: '回复',
    happy: '完成',
    error: '出错',
    sleep: '休眠',
  },
} as const satisfies {
  readonly shape: Readonly<Record<AvatarShape, string>>
  readonly color: Readonly<Record<AvatarColor, string>>
  readonly material: Readonly<Record<AvatarMaterial, string>>
  readonly eyes: Readonly<Record<AvatarEyes, string>>
  readonly mouth: Readonly<Record<AvatarMouth, string>>
  readonly accessory: Readonly<Record<AvatarAccessory, string>>
  readonly state: Readonly<Record<AvatarState, string>>
}

/**
 * Each colour's base. A muted set that sits on the console's warm paper
 * rather than shouting over it; the shading is worked out from these.
 */
export const AVATAR_HEX: Readonly<Record<AvatarColor, string>> = {
  mist: '#8ea9de',
  lake: '#79b0b2',
  sage: '#a3b58d',
  sand: '#e2c48f',
  apricot: '#eeaa86',
  clay: '#d3825f',
  blush: '#e3a9b5',
  lilac: '#b2a3da',
  cloud: '#ece6dc',
  ink: '#46434b',
}

/** FNV-1a over UTF-16 code units: small, stable, and the same in every runtime. */
export function avatarHash(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function pick<T>(list: readonly T[], seed: number): T {
  return list[seed % list.length] as T
}

/**
 * The figure somebody wears before they chose one: drawn from `seed` (an
 * agent's address, a person's subject), so it is random across people and
 * the same for one person on every page. A plain figure is likelier than a
 * busy one: no mouth comes up half the time, no accessory two times in
 * three, cheeks one time in three.
 */
export function defaultAvatar(seed: string): AvatarSpec {
  const roll = (salt: string) => avatarHash(`${salt}:${seed}`)
  return {
    shape: pick(AVATAR_SHAPES, roll('shape')),
    color: pick(AVATAR_COLORS, roll('color')),
    material: pick(AVATAR_MATERIALS, roll('material')),
    eyes: pick(AVATAR_EYES, roll('eyes')),
    mouth: roll('mouth') % 2 === 0 ? 'none' : pick(AVATAR_MOUTHS, roll('m2')),
    cheeks: roll('cheeks') % 3 === 0,
    accessory:
      roll('accessory') % 3 !== 0
        ? 'none'
        : pick(AVATAR_ACCESSORIES.slice(1), roll('accessory-kind')),
  }
}

/** A state from untrusted text, or `idle`. */
export function parseAvatarState(value: unknown): AvatarState {
  return typeof value === 'string' &&
    (AVATAR_STATES as readonly string[]).includes(value)
    ? (value as AvatarState)
    : 'idle'
}

function oneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined {
  return typeof value === 'string' &&
    (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

/** A figure from untrusted JSON, or `null` when any field is off the lists. */
export function parseAvatar(value: unknown): AvatarSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const shape = oneOf(AVATAR_SHAPES, record.shape)
  const color = oneOf(AVATAR_COLORS, record.color)
  const material = oneOf(AVATAR_MATERIALS, record.material)
  const eyes = oneOf(AVATAR_EYES, record.eyes)
  const mouth = oneOf(AVATAR_MOUTHS, record.mouth)
  const accessory = oneOf(AVATAR_ACCESSORIES, record.accessory)
  if (
    shape === undefined ||
    color === undefined ||
    material === undefined ||
    eyes === undefined ||
    mouth === undefined ||
    accessory === undefined ||
    typeof record.cheeks !== 'boolean'
  ) {
    return null
  }
  return {
    shape,
    color,
    material,
    eyes,
    mouth,
    cheeks: record.cheeks,
    accessory,
  }
}

/** Whose figure: an agent by its address, a person by their subject. */
export type AvatarKey = `agent:${string}` | `user:${string}`

export function agentAvatarKey(address: string): AvatarKey {
  return `agent:${address}`
}

export function userAvatarKey(subject: string): AvatarKey {
  return `user:${subject}`
}

export function parseAvatarKey(value: string): AvatarKey | null {
  if (value.length > 300) return null
  if (/^agent:qianmo:\/\/[^\s]+$/.test(value)) return value as AvatarKey
  if (/^user:[^\s]+$/.test(value)) return value as AvatarKey
  return null
}

/** A saved figure, and who saved it when. */
export interface AvatarRecord {
  readonly spec: AvatarSpec
  readonly updatedAt: number
  readonly updatedBy: string
}

/**
 * Where saved figures live. Reads take every key a page needs at once; a key
 * with nothing saved is simply absent from the answer, and the page falls
 * back to {@link defaultAvatar}. Saving `null` forgets the saved figure.
 */
export interface AvatarsPort {
  read(
    keys: readonly AvatarKey[],
  ): Promise<ConsoleResult<ReadonlyMap<AvatarKey, AvatarRecord>>>
  save(
    key: AvatarKey,
    spec: AvatarSpec | null,
    actor: DirectionActor,
  ): Promise<ConsoleResult<AvatarRecord | null>>
}

/** The figure to draw for `key`: the saved one, or the one its seed gives. */
export function avatarFor(
  key: AvatarKey,
  saved: ReadonlyMap<AvatarKey, AvatarRecord> | undefined,
): AvatarSpec {
  return saved?.get(key)?.spec ?? defaultAvatar(key.slice(key.indexOf(':') + 1))
}
