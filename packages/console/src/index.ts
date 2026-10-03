// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/console` — one loopback page for looking at the network and acting
 * on it: the agent roster, the audit trail with message-chain reconstruction,
 * the protocol ceilings, and a wake button.
 *
 * A leaf package with no third-party dependencies and no knowledge of where
 * anything lives: everything it reads or acts on arrives as a port
 * (`deps.ts`), injected by the `occ console` handler.
 */

export type {
  AuditChainState,
  AuditFilter,
  AuditPage,
  AuditPort,
  CertificatePort,
  CertificateSnapshot,
  CertificateStatus,
  ChatAuthor,
  ChatLocalCommand,
  ChatNoticeSeverity,
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatTurnState,
  ChatTurnVariant,
  ChatUpdate,
  ConsoleAgent,
  ConsoleAuditSource,
  ConsoleCaRoot,
  ConsoleCertificate,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
  ConsoleRevocationList,
  HandoffAcceptance,
  HandoffManifestView,
  HandoffPort,
  HandoffResultView,
  HandoffSendView,
  HandoffTaskState,
  HandoffTaskView,
  LimitsSnapshot,
  NodeServer,
  RegisterAgentInput,
  RegistryPort,
  ServerNote,
  ServerNotesPort,
  WakeInput,
  WakeOutcome,
  WakePort,
  WakeTarget,
} from './deps.js'

export {
  CONSOLE_HEADER,
  CONSOLE_HEADER_VALUE,
  LOGIN_PATH,
  MIN_TOKEN_LENGTH,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  TOKEN_QUERY_PARAM,
  bearerOf,
  clearedSessionCookieHeader,
  cookieOf,
  credentialOf,
  isCrossOriginRequest,
  isLoopbackHostname,
  isSecureRequest,
  presentedCredentialOf,
  presentedTokenOf,
  resolveTokens,
  roleOf,
  roleOfToken,
  safeRedirect,
  sessionCookieHeader,
  type ConsoleCredential,
  type ConsoleRole,
  type ConsoleTokens,
  type CredentialSource,
  type ResolveTokensInput,
  type SessionCookieOptions,
} from './auth.js'

export { LoginThrottle } from './throttle.js'

export {
  AccountBook,
  MAX_OPEN_INVITES,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  mayApprove,
  tokenFingerprint,
  type AccountBookOptions,
  type AccountEnded,
  type AccountRole,
  type AccountSubject,
  type ConsolePrincipal,
} from './accounts.js'
export {
  ACCOUNT_SESSION_COOKIE,
  ownerOf,
  principalOf,
  type ConsoleAccounts,
} from './access.js'
export type { LedgerPort } from './deps.js'
export { CHAT_LOCAL_COMMANDS } from './deps.js'

// The action ledger (P15.9): the port the routes call (`deps.ts`), and the
// hash-chained store the host puts behind it.
export {
  CONSOLE_ACTIONS,
  type ActionLedgerPort,
  type ActionOutcome,
  type ActionPage,
  type ActionQuery,
  type ActionRecord,
  type ConsoleAction,
} from './deps.js'
export {
  AUTHZ_DECISION_ACTION_PREFIX,
  ActionLedger,
  verifyActionLedger,
  type ActionLedgerOptions,
  type ActionLedgerStore,
  type ActionLedgerVerdict,
} from './actionLedger.js'

// Model services (P18.6): the port the providers page is written against, and
// the types its host implementation returns. A type stays unexported in
// `deps.ts` until something outside the package names it.
export type {
  ProviderActionName,
  ProviderActivity,
  ProviderApplyResult,
  ProviderAssignment,
  ProviderAutocompactResult,
  ProviderCaller,
  ProviderCandidate,
  ProviderCatalog,
  ProviderCompilePreview,
  ProviderDrift,
  ProviderEffortLevel,
  ProviderExport,
  ProviderFailure,
  ProviderImportInput,
  ProviderImportPreview,
  ProviderIssueView,
  ProviderNodeActual,
  ProviderNodeView,
  ProviderOverview,
  ProviderPort,
  ProviderPresetView,
  ProviderProbeResult,
  ProviderProfileDraft,
  ProviderProfileSummary,
  ProviderProfileView,
  ProviderResult,
} from './deps.js'
// The account book's line format, for the host's other hash-chained books
// (`providers.ndjson`, P18.6 R-3): one chain construction, not two.
export {
  encodeLedgerEntry,
  ledgerDigest,
  nextPrevious,
  readLedger,
  type LedgerData,
  type LedgerEntry,
} from './ledger.js'

export {
  API_PREFIX,
  CHAT_STREAM_HEARTBEAT_MS,
  MAX_AUDIT_LIMIT,
  createConsoleHandler,
  parseAuditFilter,
  startConsoleServer,
  type ClientAddressSource,
  type ConsoleServerHandle,
  type ConsoleServerOptions,
} from './http.js'

export { BRAND, CSP, renderPage, type PageModel } from './view/page.js'
export { renderLoginPage, type LoginPageModel } from './view/login.js'
export {
  agentFilterOptions,
  renderRoster,
  wakeTargetOptions,
  type RosterCertificates,
} from './view/agents.js'
export {
  certificateLine,
  certificateTally,
  reissueCommand,
  renderRevocationBar,
} from './view/certificates.js'
export {
  renderAudit,
  renderAuditSources,
  type AuditSourceRender,
} from './view/audit.js'
export {
  MAX_CHAT_TEXT_LENGTH,
  renderChatSessions,
  renderChatThread,
  type ChatSessionsModel,
  type ChatThreadModel,
} from './view/chat.js'
export { renderChatPage, type ChatPageModel } from './view/chatPage.js'
export { renderLimits } from './view/limits.js'
// The lease the registry actually granted, read off its own records (C-1). The
// host's renewer paces itself by it, so the page and the renewer cannot hold
// two different ideas of how long a registration lives.
export { rosterLease } from './view/format.js'
export {
  MAX_SERVER_NOTE_LENGTH,
  SERVERS_HEADING_ID,
  renderServers,
  serverCards,
  type ServerCard,
  type ServersModel,
} from './view/servers.js'
export { CONSOLE_CSS } from './assets/css.js'
export { CONSOLE_CLIENT_JS } from './assets/client.js'
// 告警与值守作业的两个端口（J5 / J6，P18.15）。宿主 `consolePorts.ts` 实现它们，
// 所以类型要从包入口出去；单独一段放在文件尾，不插进上面那张按字母排的表。
export type {
  AlertAck,
  AlertLevel,
  ConsoleNotice,
  NoticeFeed,
  NotifyPort,
  SchedulerEstop,
  SchedulerPort,
  SchedulerSnapshot,
  SchedulerTick,
  WatchFireOutcome,
  WatchJobStatus,
} from './deps.js'
