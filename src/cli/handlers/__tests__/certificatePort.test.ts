// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `createCertificatePort` — the host half of §10.1's certificate column.
 *
 * Real certificates from a real CA (`qm ca init/issue`, P12.1) rather than
 * fixtures, for the same reason `mtls.test.ts` uses openssl: what is under
 * test is an X.509 verification, and a fixture would assert our belief about
 * what `verify()` does.
 *
 * The order of the checks is the thing worth pinning. A forged certificate
 * carries whatever `notAfter` its author chose, so a port that asked about
 * time before it asked about the signature would render somebody else's
 * forgery as `valid` — and "任何人都能往零鉴权的注册中心里塞一张" is §5.2's own
 * description of the registry this port reads.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
} from '../../../services/qianmo/ca/operations.js'
import {
  opensslVersion,
  runOpenssl,
} from '../../../services/qianmo/ca/openssl.js'
import { popMessage } from '../../../services/qianmo/ca/pop.js'
import { createCertificatePort } from '../consolePorts.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

const DAY = 24 * 60 * 60 * 1000

let root: string
let caDir: string

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-console-cert-'))
  caDir = join(root, 'ca')
  initCa({ directory: caDir })
})

afterAll(() => {
  if (OPENSSL === null) return
  rmSync(root, { recursive: true, force: true })
})

interface Issued {
  readonly node: string
  readonly certificatePem: string
  readonly fingerprint256: string
}

function issue(directory: string, node: string, days?: number): Issued {
  const keys = generateNodeKeyPair()
  const keyPath = join(root, `${node}-${String(days ?? 0)}.key`)
  writeFileSync(
    keyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  const csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    keyPath,
    '-subj',
    `/CN=${node}`,
  ])
  const result = issueCertificate({
    directory,
    node,
    publicKey: keys.publicKey,
    csrPem,
    popSignature: signBytes(keys, popMessage(node, csrPem)),
    hosts: [`${node}.example.com`],
    ...(days === undefined ? {} : { days }),
  })
  return {
    node,
    certificatePem: result.certificatePem,
    fingerprint256: result.fingerprint256,
  }
}

/** A registry face made of two canned responses. No socket, no server. */
function registryOf(options: {
  readonly agents: readonly unknown[]
  readonly revocationList?: unknown
}) {
  return async (input: string): Promise<Response> => {
    if (input.endsWith('/v0/agents')) {
      return new Response(JSON.stringify({ agents: options.agents }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (input.endsWith('/v0/revocation-list')) {
      return options.revocationList === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(options.revocationList), {
            headers: { 'content-type': 'application/json' },
          })
    }
    return new Response('{}', { status: 404 })
  }
}

function portFor(options: {
  readonly agents: readonly unknown[]
  readonly revocationList?: unknown
  readonly now?: () => number
}) {
  return createCertificatePort({
    baseUrl: 'http://127.0.0.1:1',
    caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
    fetch: registryOf(options),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

describe('createCertificatePort (§10.1)', () => {
  itNeedsOpenssl(
    'a CA-issued, in-date certificate reads as valid',
    async () => {
      const issued = issue(caDir, 'node-a')
      const result = await portFor({
        agents: [
          {
            address: 'qianmo://node-a/reviewer',
            certificate: issued.certificatePem,
          },
        ],
      }).read()

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.certificates).toHaveLength(1)
      expect(result.value.certificates[0]?.node).toBe('node-a')
      expect(result.value.certificates[0]?.status).toBe('valid')
      expect(result.value.certificates[0]?.fingerprint256).toBe(
        issued.fingerprint256,
      )
    },
  )

  itNeedsOpenssl(
    'a certificate from another CA is a forgery, not an expiry question',
    async () => {
      // The order-of-checks assertion: this certificate is perfectly in date,
      // and it says so itself. Asking about time first would render it green.
      const otherCa = join(root, 'other-ca')
      initCa({ directory: otherCa })
      const forged = issue(otherCa, 'node-a')

      const result = await portFor({
        agents: [
          {
            address: 'qianmo://node-a/reviewer',
            certificate: forged.certificatePem,
          },
        ],
      }).read()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.certificates[0]?.status).toBe('bad-signature')
    },
  )

  itNeedsOpenssl('a node with no certificate reads as absent', async () => {
    const result = await portFor({
      agents: [{ address: 'qianmo://node-b/reviewer' }],
    }).read()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.certificates[0]?.status).toBe('absent')
    expect(result.value.certificates[0]?.fingerprint256).toBeUndefined()
  })

  itNeedsOpenssl(
    'an unparseable blob is a forgery, not an absence',
    async () => {
      const result = await portFor({
        agents: [
          { address: 'qianmo://node-c/reviewer', certificate: 'not a pem' },
        ],
      }).read()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.certificates[0]?.status).toBe('bad-signature')
    },
  )

  itNeedsOpenssl(
    '§6.2’s 21-day threshold turns valid into expiring',
    async () => {
      const issued = issue(caDir, 'node-d', 10)
      const result = await portFor({
        agents: [
          {
            address: 'qianmo://node-d/reviewer',
            certificate: issued.certificatePem,
          },
        ],
      }).read()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.certificates[0]?.status).toBe('expiring')
    },
  )

  itNeedsOpenssl(
    'a signed RL revokes, and its clocks reach the header',
    async () => {
      const issued = issue(caDir, 'node-e')
      const rl = refreshRevocationList({
        directory: caDir,
        revoke: [{ node: 'node-e', fingerprint256: issued.fingerprint256 }],
        now: Date.now(),
        validMs: 30 * DAY,
      })
      const signed: unknown = JSON.parse(readFileSync(rl.path, 'utf8'))

      const result = await portFor({
        agents: [
          {
            address: 'qianmo://node-e/reviewer',
            certificate: issued.certificatePem,
          },
        ],
        revocationList: signed,
      }).read()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.certificates[0]?.status).toBe('revoked')
      expect(result.value.revocationList?.revokedCount).toBe(1)
      expect(result.value.revocationList?.nextUpdate).toBeGreaterThan(
        Date.now(),
      )
    },
  )

  itNeedsOpenssl(
    'an RL with a broken signature is treated as no RL at all',
    async () => {
      // The registry has no authentication (§5.2). An unverified list is a
      // way for anybody to declare any node revoked on this page.
      const issued = issue(caDir, 'node-f')
      const result = await portFor({
        agents: [
          {
            address: 'qianmo://node-f/reviewer',
            certificate: issued.certificatePem,
          },
        ],
        revocationList: {
          payload: {
            version: 1,
            issuedAt: Date.now(),
            nextUpdate: Date.now() + DAY,
            revoked: [
              { node: 'node-f', fingerprint256: issued.fingerprint256 },
            ],
          },
          signature: 'not-a-signature',
        },
      }).read()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.certificates[0]?.status).toBe('valid')
      expect(result.value.revocationList).toBeNull()
    },
  )

  itNeedsOpenssl(
    'an unreachable registry is a failure value, not a throw',
    async () => {
      const port = createCertificatePort({
        baseUrl: 'http://127.0.0.1:1',
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        fetch: () => Promise.reject(new Error('connect ECONNREFUSED')),
      })
      const result = await port.read()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.code).toBe('unreachable')
    },
  )
})
