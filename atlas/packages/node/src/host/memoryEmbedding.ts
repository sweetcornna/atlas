// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  contentHash,
  isUsableVector,
  type EmbeddingProvider,
} from '@qianmo/recall'

export interface MemoryEmbeddingConfig {
  readonly kind: 'ollama' | 'openai'
  readonly endpoint: string
  readonly model: string
  readonly dimensions: number
  readonly apiKeyEnv?: string
  readonly batchSize?: number
  readonly dailyTokenLimit?: number
  readonly timeoutMs?: number
}

export function parseEmbeddingConfig(
  input: unknown,
  llmBaseUrl?: string,
): MemoryEmbeddingConfig | null {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid memory embedding config')
  const row = input as Record<string, unknown>
  if (row.kind === 'off' && Object.keys(row).length === 1) return null
  if (
    Object.keys(row).some(
      key =>
        ![
          'kind',
          'endpoint',
          'model',
          'dimensions',
          'apiKeyEnv',
          'batchSize',
          'dailyTokenLimit',
          'timeoutMs',
        ].includes(key),
    ) ||
    !['ollama', 'openai'].includes(String(row.kind)) ||
    typeof row.model !== 'string' ||
    !row.model ||
    typeof row.endpoint !== 'string' ||
    !Number.isSafeInteger(row.dimensions) ||
    Number(row.dimensions) < 1 ||
    Number(row.dimensions) > 65_536
  )
    throw new Error('invalid memory embedding config')
  const endpoint = new URL(row.endpoint)
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('embedding endpoint must not carry credentials or query')
  if (row.kind === 'ollama') {
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      !['http:', 'https:'].includes(endpoint.protocol) ||
      row.apiKeyEnv !== undefined
    )
      throw new Error('local embedding must use loopback without credentials')
  } else {
    if (
      endpoint.protocol !== 'https:' ||
      llmBaseUrl === undefined ||
      endpoint.origin !== new URL(llmBaseUrl).origin
    )
      throw new Error(
        'remote embedding must share the configured LLM gateway origin',
      )
    if (
      typeof row.apiKeyEnv !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.apiKeyEnv)
    )
      throw new Error('embedding API key environment name required')
  }
  if (
    row.batchSize !== undefined &&
    (!Number.isSafeInteger(row.batchSize) ||
      Number(row.batchSize) < 1 ||
      Number(row.batchSize) > 128)
  )
    throw new Error('invalid embedding batch size')
  if (
    row.dailyTokenLimit !== undefined &&
    (!Number.isSafeInteger(row.dailyTokenLimit) ||
      Number(row.dailyTokenLimit) < 0)
  )
    throw new Error('invalid embedding daily token limit')
  if (
    row.timeoutMs !== undefined &&
    (!Number.isSafeInteger(row.timeoutMs) ||
      Number(row.timeoutMs) < 1 ||
      Number(row.timeoutMs) > 60_000)
  )
    throw new Error('invalid embedding timeout')
  return {
    ...(typeof row.dailyTokenLimit === 'number'
      ? { dailyTokenLimit: row.dailyTokenLimit }
      : {}),
    ...(typeof row.timeoutMs === 'number' ? { timeoutMs: row.timeoutMs } : {}),
    kind: row.kind as MemoryEmbeddingConfig['kind'],
    endpoint: endpoint.toString(),
    model: row.model,
    dimensions: Number(row.dimensions),
    ...(typeof row.apiKeyEnv === 'string' ? { apiKeyEnv: row.apiKeyEnv } : {}),
    ...(typeof row.batchSize === 'number' ? { batchSize: row.batchSize } : {}),
  }
}

export function readEmbeddingConfig(
  llmBaseUrl?: string,
): MemoryEmbeddingConfig | null {
  try {
    return parseEmbeddingConfig(
      JSON.parse(
        readFileSync(qianmoConfigPath('memory', 'embedding.json'), 'utf8'),
      ),
      llmBaseUrl,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Batches preserve input order; errors never contain endpoint, credentials or text. */
export function createMemoryEmbedder(
  config: MemoryEmbeddingConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmbeddingProvider {
  const url = new URL(
    config.kind === 'ollama' ? 'api/embed' : 'embeddings',
    config.endpoint.endsWith('/') ? config.endpoint : `${config.endpoint}/`,
  )
  const key = config.apiKeyEnv === undefined ? undefined : env[config.apiKeyEnv]
  if (config.kind === 'openai' && !key)
    throw new Error('embedding credential unavailable')
  return {
    id: `${config.kind}-${createHash('sha256').update(config.endpoint).digest('hex').slice(0, 12)}`,
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts, options) {
      const vectors: (readonly number[])[] = []
      let tokens = 0
      for (
        let offset = 0;
        offset < texts.length;
        offset += config.batchSize ?? 32
      ) {
        const batch = texts.slice(offset, offset + (config.batchSize ?? 32))
        let response: Response
        try {
          response = await fetch(url, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.any([
              options.signal,
              AbortSignal.timeout(60_000),
            ]),
            headers: {
              'content-type': 'application/json',
              ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
            },
            body: JSON.stringify({
              model: config.model,
              input: batch,
              ...(config.kind === 'ollama'
                ? { truncate: false }
                : { dimensions: config.dimensions }),
            }),
          })
        } catch {
          throw new Error('embedding request unavailable')
        }
        if (!response.ok) throw new Error(`embedding HTTP ${response.status}`)
        const body = (await response.json()) as Record<string, unknown>
        if (
          config.kind === 'openai' &&
          (!Array.isArray(body.data) ||
            body.data.some(
              (row: unknown) =>
                !row ||
                typeof row !== 'object' ||
                !Number.isInteger((row as { index: unknown }).index),
            ) ||
            new Set(body.data.map(row => row.index)).size !== batch.length ||
            body.data.some(row => row.index < 0 || row.index >= batch.length))
        )
          throw new Error('invalid embedding indexes')
        const rows =
          config.kind === 'ollama'
            ? body.embeddings
            : Array.isArray(body.data)
              ? [...body.data]
                  .sort((a, b) => Number(a.index) - Number(b.index))
                  .map(row => row.embedding)
              : undefined
        if (
          !Array.isArray(rows) ||
          rows.length !== batch.length ||
          rows.some(row => !isUsableVector(row, config.dimensions))
        )
          throw new Error('invalid embedding vectors')
        vectors.push(...rows)
        const usage =
          config.kind === 'ollama'
            ? body.prompt_eval_count
            : (body.usage as Record<string, unknown> | undefined)?.total_tokens
        if (
          typeof usage === 'number' &&
          Number.isSafeInteger(usage) &&
          usage >= 0
        )
          tokens += usage
      }
      return { vectors, ...(tokens > 0 ? { usage: { tokens } } : {}) }
    },
  }
}

/** Persistent replay material, containing hashes/vectors and no source texts. */
export function recordingEmbedder(
  inner: EmbeddingProvider,
  vectors: Record<string, readonly number[]>,
): EmbeddingProvider {
  return {
    ...inner,
    async embed(texts, options) {
      const result = await inner.embed(texts, options)
      for (let i = 0; i < texts.length; i++)
        vectors[contentHash(texts[i]!)] = [...result.vectors[i]!]
      return result
    },
  }
}
