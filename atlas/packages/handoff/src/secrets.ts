// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Vendor secret detection: a precision-first subset of the gitleaks rule set
 * (https://github.com/gitleaks/gitleaks, `config/gitleaks.toml`, MIT).
 *
 * Only rules whose key shape is distinctive enough to fire almost never on
 * ordinary text are included — no keyword-context rules — because the shadow
 * commit refuses outright on any hit. The broader, noisier transcript pass is
 * `redact.ts`.
 *
 * Rule ids are the gitleaks ids, and they are what callers report: a hit
 * names the rule, never the matched text.
 *
 * Go → JS: gitleaks' inline `(?i)` / `(?-i:…)` groups are spelled as explicit
 * character classes. Where a gitleaks rule wraps the key in boundary
 * characters, the key itself is the named group `key`, and redaction replaces
 * only that group so the surrounding quote, space or `;` survives.
 */

/** One rule that fired. Deliberately carries no matched text. */
export interface SecretMatch {
  /** gitleaks rule id, e.g. `github-pat`, `aws-access-token`. */
  readonly ruleId: string
}

/** Trailing boundary gitleaks puts after most prefixed keys. */
const END = String.raw`(?:[\x60'"\s;]|\\[nr]|$)`

/** Rule id → pattern. Order is the report order. */
const RULES: ReadonlyArray<
  readonly [id: string, source: string, flags?: string]
> = [
  // Cloud
  [
    'aws-access-token',
    String.raw`\b(?<key>(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b`,
  ],
  ['gcp-api-key', String.raw`\b(?<key>AIza[\w-]{35})${END}`],
  [
    'azure-ad-client-secret',
    String.raw`(?:^|[\\'"\x60\s>=:(,)])(?<key>[a-zA-Z0-9_~.]{3}\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\'"\x60\s<),])`,
  ],
  ['digitalocean-pat', String.raw`\b(?<key>dop_v1_[a-f0-9]{64})${END}`],
  [
    'digitalocean-access-token',
    String.raw`\b(?<key>doo_v1_[a-f0-9]{64})${END}`,
  ],
  // AI APIs
  [
    'anthropic-api-key',
    String.raw`\b(?<key>sk-ant-api03-[a-zA-Z0-9_\-]{93}AA)${END}`,
  ],
  [
    'anthropic-admin-api-key',
    String.raw`\b(?<key>sk-ant-admin01-[a-zA-Z0-9_\-]{93}AA)${END}`,
  ],
  [
    'openai-api-key',
    String.raw`\b(?<key>sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})${END}`,
  ],
  ['huggingface-access-token', String.raw`\b(?<key>hf_[a-zA-Z]{34})${END}`],
  // Version control
  ['github-pat', String.raw`ghp_[0-9a-zA-Z]{36}`],
  ['github-fine-grained-pat', String.raw`github_pat_\w{82}`],
  ['github-app-token', String.raw`(?:ghu|ghs)_[0-9a-zA-Z]{36}`],
  ['github-oauth', String.raw`gho_[0-9a-zA-Z]{36}`],
  ['github-refresh-token', String.raw`ghr_[0-9a-zA-Z]{36}`],
  ['gitlab-pat', String.raw`glpat-[\w-]{20}`],
  ['gitlab-deploy-token', String.raw`gldt-[0-9a-zA-Z_\-]{20}`],
  // Messaging
  ['slack-bot-token', String.raw`xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*`],
  [
    'slack-user-token',
    String.raw`xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}`,
  ],
  ['slack-app-token', String.raw`xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+`, 'i'],
  ['twilio-api-key', String.raw`SK[0-9a-fA-F]{32}`],
  ['sendgrid-api-token', String.raw`\b(?<key>SG\.[a-zA-Z0-9=_\-.]{66})${END}`],
  // Developer tooling
  ['npm-access-token', String.raw`\b(?<key>npm_[a-zA-Z0-9]{36})${END}`],
  ['pypi-upload-token', String.raw`pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}`],
  [
    'databricks-api-token',
    String.raw`\b(?<key>dapi[a-f0-9]{32}(?:-\d)?)${END}`,
  ],
  [
    'hashicorp-tf-api-token',
    String.raw`[a-zA-Z0-9]{14}\.atlasv1\.[a-zA-Z0-9\-_=]{60,70}`,
  ],
  ['pulumi-api-token', String.raw`\b(?<key>pul-[a-f0-9]{40})${END}`],
  [
    'postman-api-token',
    String.raw`\b(?<key>PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})${END}`,
  ],
  // Observability
  [
    'grafana-api-key',
    String.raw`\b(?<key>eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})${END}`,
  ],
  [
    'grafana-cloud-api-token',
    String.raw`\b(?<key>glc_[A-Za-z0-9+/]{32,400}={0,3})${END}`,
  ],
  [
    'grafana-service-account-token',
    String.raw`\b(?<key>glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})${END}`,
  ],
  ['sentry-user-token', String.raw`\b(?<key>sntryu_[a-f0-9]{64})${END}`],
  [
    'sentry-org-token',
    String.raw`\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}`,
  ],
  // Payments and commerce
  [
    'stripe-access-token',
    String.raw`\b(?<key>(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})${END}`,
  ],
  ['shopify-access-token', String.raw`shpat_[a-fA-F0-9]{32}`],
  ['shopify-shared-secret', String.raw`shpss_[a-fA-F0-9]{32}`],
  // Key material
  [
    'private-key',
    String.raw`-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----`,
    'i',
  ],
]

let compiled: ReadonlyArray<{ id: string; once: RegExp; all: RegExp }> | null =
  null

function rules() {
  compiled ??= RULES.map(([id, source, flags = '']) => ({
    id,
    once: new RegExp(source, flags),
    all: new RegExp(source, `${flags}g`),
  }))
  return compiled
}

/** Placeholder a vendor secret is replaced with. */
export const REDACTED = '[REDACTED]'

/** The rules that fire on `content`, at most one match per rule. */
export function scanForSecrets(content: string): SecretMatch[] {
  return rules()
    .filter(rule => rule.once.test(content))
    .map(rule => ({ ruleId: rule.id }))
}

/**
 * `content` with every vendor secret replaced by {@link REDACTED}. Only the
 * key is replaced; boundary characters a rule matched around it are kept.
 */
export function redactSecrets(content: string): string {
  let out = content
  for (const rule of rules()) {
    out = out.replace(rule.all, (match: string, ...rest: unknown[]) => {
      const groups = rest.at(-1)
      const key =
        groups && typeof groups === 'object' && 'key' in groups
          ? groups.key
          : undefined
      return typeof key === 'string' ? match.replace(key, REDACTED) : REDACTED
    })
  }
  return out
}
