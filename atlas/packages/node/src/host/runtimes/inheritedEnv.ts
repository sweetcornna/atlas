// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The part of the node's environment a process it starts for an agent may
 * see: locale, paths, proxies and certificates. Everything else in the node's
 * environment (transport keys, model credentials, qianmo settings) stays with
 * the node; credentials a runtime needs are added on purpose.
 */
export const INHERITED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]

/** {@link INHERITED_ENV} from `source`, plus the named variables `keep`. */
export function inheritedEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
  keep: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...INHERITED_ENV, ...keep]) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}
