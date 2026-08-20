// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `CertificateDirectory` — the `--trust-ca` replacement for
 * `StaticPublicKeyDirectory` (key-distribution.md §8.1).
 *
 * Same {@link PublicKeyDirectory} interface `@qianmo/capability` already
 * defines, so nothing downstream of `publicKeyOf` changes. What is different
 * is where the keys come from: instead of a fixed map built once from
 * `--trust`, this one caches the registry's published certificates, checks
 * each against a local CA root and a revocation list, and refreshes itself
 * on its own clock.
 *
 * ## `publicKeyOf` stays synchronous, on purpose (§8.1, `token.ts:44-48`)
 *
 * The inbound capability gate calls `publicKeyOf` from inside a message
 * handler, before the sender has proven anything — a lookup that could block
 * would hand an unauthenticated peer control over how long that handler
 * takes. So every network call and every certificate check happens in
 * {@link CertificateDirectory.refresh}, off the hot path, and `publicKeyOf`
 * only ever reads a plain `Map` built by the last refresh. This is why the
 * class does its own verification up front rather than verifying lazily on
 * first lookup — a lazy design would put exactly the blocking work `token.ts`
 * forbids on the one method that must never block.
 *
 * ## Fail-closed, and to what (§6.4)
 *
 * A revocation list that is stale — `now >= nextUpdate`, including "never
 * fetched at all" — does not fail the directory open (every CA-derived key
 * still served) or closed (every lookup refused). It falls back to exactly
 * the explicit entries handed to the constructor or {@link put}, the same
 * set `--trust` has always populated. `#effective` is rebuilt on every
 * refresh so this degrade and its recovery are both silent and immediate —
 * there is no "stuck open" state to notice and clear by hand.
 *
 * ## What is verified here, and what is not
 *
 * A certificate must, in order: parse as a §4.2 binding, name the node it
 * was registered under, agree with any `publicKey` field alongside it,
 * verify against the configured CA root (F-2), be currently valid (not
 * before `notAfter`, not after — well, not *before* `notBefore` either), and
 * — only while the revocation list is fresh — not be on it. Any failure
 * drops that one node from the CA-derived cache; it does not throw, because
 * one bad record from a zero-auth registry (§5.2) must not stop every other
 * node from resolving.
 *
 * What this class does **not** do: verify the RL's own freshness against a
 * clock the operator cannot see (that is exactly {@link publicKeyOf}'s
 * fail-closed behaviour, not a bug to work around), or accept a certificate
 * this CA root did not sign, however well-formed its SANs are — that is
 * precisely T-B's "篡改者可以往注册中心塞一张伪造证书" case, and F-2 is the
 * whole reason it is checkable with zero additional trust.
 */

import { X509Certificate } from 'node:crypto'
import {
  isNodePublicKey,
  parseAddress,
  parseNodeCertificateBinding,
  type NodeCertificateBinding,
} from '@qianmo/protocol'
import type { PublicKeyDirectory } from '@qianmo/capability'
import {
  verifyRevocationList,
  type RevocationList,
} from './ca/revocationList.js'

/** Injection point for tests; production always uses the global `fetch`. */
type DirectoryFetch = (input: string, init: RequestInit) => Promise<Response>

/** One shape `GET /v0/agents` returns a row as — only what this class reads. */
interface AgentBody {
  readonly address?: unknown
  readonly publicKey?: unknown
  readonly certificate?: unknown
}

/** A certificate that passed every check except revocation. */
interface CachedCertificate {
  readonly publicKey: string
  readonly fingerprint256: string
}

export interface CertificateDirectoryAuditEvent {
  readonly node: string
  readonly reason: string
}

export type CertificateDirectoryAuditSink = (
  event: CertificateDirectoryAuditEvent,
) => void

export interface CertificateDirectoryOptions {
  /** PEM root certificate — the one thing distributed out of band (§5.1). */
  readonly caCertificatePem: string
  /** `<node>=<publicKey>` pairs from `--trust`; always wins over the CA cache. */
  readonly trusted?: Iterable<readonly [string, string]>
  /**
   * Base URL of the registry's HTTP v0 API. Omit to run with no network
   * source at all — {@link refresh} then only re-applies the explicit
   * entries, which is the same state a stale RL degrades to (§6.4). Useful
   * standalone (nothing to poll yet) and as the honest default until a node
   * actually announces to and reads from a live registry.
   */
  readonly registryUrl?: string
  readonly fetch?: DirectoryFetch
  readonly timeoutMs?: number
  /** Defaults to `Date.now`; overridable so tests can move the clock. */
  readonly now?: () => number
  /**
   * Called when an explicit `--trust` entry and the CA-derived cache disagree
   * about the same node's key (§8.2: explicit wins, but silently is not an
   * option for a conflict this sharp).
   */
  readonly onAudit?: CertificateDirectoryAuditSink
}

const DEFAULT_TIMEOUT_MS = 5_000

/** The CA's Ed25519 public key, 43-char form, read out of its certificate. */
function caPublicKeyOf(certificate: X509Certificate): string {
  const jwk = certificate.publicKey.export({ format: 'jwk' })
  const publicKey = jwk.x
  if (!isNodePublicKey(publicKey)) {
    throw new Error('--trust-ca does not carry an Ed25519 public key')
  }
  return publicKey
}

/**
 * `CertificateDirectory` — see the module header for the contract this keeps.
 */
export class CertificateDirectory implements PublicKeyDirectory {
  readonly #caCertificate: X509Certificate
  readonly #caPublicKey: string
  readonly #registryUrl: string | undefined
  readonly #fetch: DirectoryFetch
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #onAudit: CertificateDirectoryAuditSink | undefined

  readonly #explicit = new Map<string, string>()
  #caCache = new Map<string, CachedCertificate>()
  #revocationList: RevocationList | null = null
  #effective = new Map<string, string>()
  #refreshing: Promise<void> | null = null
  #pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: CertificateDirectoryOptions) {
    this.#caCertificate = new X509Certificate(options.caCertificatePem)
    this.#caPublicKey = caPublicKeyOf(this.#caCertificate)
    this.#registryUrl = options.registryUrl?.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? (() => Date.now())
    this.#onAudit = options.onAudit
    for (const [node, key] of options.trusted ?? [])
      this.#explicit.set(node, key)
    this.#rebuildEffective()
  }

  /** Synchronous, zero IO — see the module header on why that is load-bearing. */
  publicKeyOf(node: string): string | null {
    return this.#effective.get(node) ?? null
  }

  /** Publish or replace an explicit (`--trust`-equivalent) entry. */
  put(node: string, publicKey: string): void {
    this.#explicit.set(node, publicKey)
    this.#rebuildEffective()
  }

  delete(node: string): void {
    this.#explicit.delete(node)
    this.#rebuildEffective()
  }

  /** Whether the revocation list currently backing the CA-derived cache is fresh. */
  get revocationListFresh(): boolean {
    return this.#rlFresh()
  }

  /** Number of nodes `publicKeyOf` can currently answer for. */
  get size(): number {
    return this.#effective.size
  }

  /** A snapshot of everything `publicKeyOf` can currently answer — S-2's gauge. */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.#effective)
  }

  /** Start polling the registry on its own timer. No-op with no `registryUrl`. */
  startPolling(intervalMs: number): void {
    if (this.#registryUrl === undefined || this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.refresh()
    }, intervalMs)
    this.#pollTimer.unref?.()
  }

  stopPolling(): void {
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer)
    this.#pollTimer = null
  }

  /**
   * Fetch the registry's agents and revocation list, verify what can be
   * verified, and rebuild the map {@link publicKeyOf} reads. Safe to call
   * concurrently — overlapping calls share one in-flight fetch rather than
   * racing two.
   */
  async refresh(): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing
    const run = this.#doRefresh().finally(() => {
      this.#refreshing = null
    })
    this.#refreshing = run
    return run
  }

  async #doRefresh(): Promise<void> {
    const registryUrl = this.#registryUrl
    if (registryUrl === undefined) {
      this.#rebuildEffective()
      return
    }

    await this.#refreshRevocationList(registryUrl)
    await this.#refreshCertificates(registryUrl)
    this.#rebuildEffective()
  }

  async #getJson(registryUrl: string, path: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.#fetch(`${registryUrl}${path}`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      return undefined
    }
    if (!response.ok) return undefined
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  /**
   * Refresh the cached RL. A failed fetch, a 404 (nothing published yet) or a
   * bad signature all leave the previous cache untouched — §6.4's "拉不到 |
   * 用缓存的那份" is the same code path as "nothing has changed".
   */
  async #refreshRevocationList(registryUrl: string): Promise<void> {
    const body = await this.#getJson(registryUrl, '/v0/revocation-list')
    if (body === undefined) return
    const verified = verifyRevocationList(this.#caPublicKey, body)
    if (verified !== null) this.#revocationList = verified
  }

  async #refreshCertificates(registryUrl: string): Promise<void> {
    const body = await this.#getJson(registryUrl, '/v0/agents')
    if (body === undefined || typeof body !== 'object' || body === null) {
      // Fetch failed outright — keep whatever the last successful refresh
      // produced rather than emptying a cache that may still be correct.
      return
    }
    const agents = (body as Record<string, unknown>)['agents']
    if (!Array.isArray(agents)) return

    const revoked = this.#revokedFingerprints()
    const fresh = new Map<string, CachedCertificate>()
    for (const raw of agents) {
      const evaluated = this.#evaluate(raw, revoked)
      if (evaluated !== null) fresh.set(evaluated.node, evaluated.certificate)
    }
    this.#caCache = fresh
  }

  #revokedFingerprints(): ReadonlySet<string> {
    if (!this.#rlFresh()) return new Set()
    return new Set(
      this.#revocationList?.revoked.map(entry => entry.fingerprint256),
    )
  }

  #rlFresh(): boolean {
    const list = this.#revocationList
    return list !== null && this.#now() < list.nextUpdate
  }

  /**
   * One agent record, checked all the way through §4.2/§5.2/F-2/§6.4. `null`
   * covers every rejection reason at once — the caller only needs "in or
   * out", and each reason is a one-line comment here rather than a second
   * taxonomy nobody reads.
   */
  #evaluate(
    raw: unknown,
    revoked: ReadonlySet<string>,
  ): { readonly node: string; readonly certificate: CachedCertificate } | null {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as AgentBody
    if (typeof record.certificate !== 'string') return null

    const address = parseAddress(record.address)
    if (address === null) return null

    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(record.certificate)
    } catch {
      return null // not even a parseable certificate
    }
    const binding = parseNodeCertificateBinding(certificate.subjectAltName)
    if (binding === null || binding.node !== address.node) return null
    if (
      typeof record.publicKey === 'string' &&
      record.publicKey !== binding.publicKey
    ) {
      return null // nodekey does not match the record's own declared key
    }
    // F-2: this is the entire "was it forged" question, and it needs nothing
    // but the CA's public key.
    if (!certificate.verify(this.#caCertificate.publicKey)) return null

    const now = this.#now()
    if (now < Date.parse(certificate.validFrom)) return null
    if (now >= Date.parse(certificate.validTo)) return null

    if (revoked.has(certificate.fingerprint256)) return null

    return {
      node: binding.node,
      certificate: {
        publicKey: binding.publicKey,
        fingerprint256: certificate.fingerprint256,
      },
    }
  }

  /**
   * Rebuild the map {@link publicKeyOf} reads. The only method allowed to
   * touch `#effective` — every mutation goes through here so the fail-closed
   * rule (§6.4) and the explicit-overrides-CA rule (§8.2) are each written
   * exactly once.
   */
  #rebuildEffective(): void {
    if (!this.#rlFresh()) {
      // Fail-closed: the CA-derived cache is not trustworthy right now
      // (stale or never-fetched RL), so it is not consulted at all — only
      // the explicit entries an operator typed remain.
      this.#effective = new Map(this.#explicit)
      return
    }
    const merged = new Map<string, string>()
    for (const [node, entry] of this.#caCache) merged.set(node, entry.publicKey)
    for (const [node, key] of this.#explicit) {
      const derived = merged.get(node)
      if (derived !== undefined && derived !== key) {
        this.#onAudit?.({
          node,
          reason:
            '--trust overrides a different CA-derived key for the same node (§8.2)',
        })
      }
      merged.set(node, key)
    }
    this.#effective = merged
  }
}

/**
 * The one check no `CertificateDirectory` instance can make for itself:
 * whether *this node's own* certificate actually names *this node's own*
 * Ed25519 identity (§12.1 K-2: "nodekey 与其 identity 文件里的公钥一致").
 *
 * `CertificateDirectory` verifies peers' certificates against a CA root; it
 * has no way to know what a peer's local identity file says, and it should
 * not — that would mean every node needing filesystem access to every other
 * node. This check is different in kind: it is a *local* consistency check a
 * node runs on its own `--cert` at startup, before it ever talks to anyone.
 * A node whose certificate was issued for a different key than the one it
 * actually holds cannot use that certificate for anything (its own
 * signatures will never match its own SAN), so refusing to start is strictly
 * better than starting broken.
 *
 * Returns the parsed binding on success; throws — never returns `null` —
 * because every call site here is a startup-time refusal, not a query.
 */
export function assertOwnCertificateMatchesIdentity(
  certificatePem: string,
  node: string,
  ownPublicKey: string,
): NodeCertificateBinding {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(certificatePem)
  } catch (error) {
    throw new Error(
      `--cert does not parse as a certificate: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const binding = parseNodeCertificateBinding(certificate.subjectAltName)
  if (binding === null) {
    throw new Error(
      '--cert does not carry a valid node certificate binding (key-distribution.md §4.2)',
    )
  }
  if (binding.node !== node) {
    throw new Error(
      `--cert names node ${binding.node}, but this node is ${node}`,
    )
  }
  if (binding.publicKey !== ownPublicKey) {
    // This is the K-2 check, and the one negative case among the four that is
    // NOT about a peer: it fires when an operator hands a node the wrong
    // file — a certificate genuinely signed by the CA, for a real node, just
    // not this one's identity.
    throw new Error(
      `--cert names Ed25519 key ${binding.publicKey}, but this node's ` +
        `identity key is ${ownPublicKey} (nodekey does not match identity)`,
    )
  }
  return binding
}
