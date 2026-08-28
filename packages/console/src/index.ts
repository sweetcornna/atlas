// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

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
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatTurnState,
  ChatUpdate,
  ConsoleAgent,
  ConsoleAuditSource,
  ConsoleCertificate,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
  ConsoleRevocationList,
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
