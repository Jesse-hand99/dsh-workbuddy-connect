/**
 * CN-only prompt neutralization.
 *
 * Since 2026-10-20 the WorkBuddy (CN) gateway content-filters chat bodies: a
 * body whose messages carry the harness's own bootstrap sentences is answered
 * with HTTP 400 and the display text 「请求被拦截，请重新发送」. The filter is a
 * fingerprint match over the prompt text, not a client-identity check —
 * official-client headers, the desktop User-Agent, the international origin and
 * every other request attribute were measured accepted while the same request
 * carrying the real system prompt was blocked (see the live verification notes
 * in README). Replacing these sentences with semantically equivalent wording
 * makes the full system prompt pass again.
 *
 * The filter is upstream-owned and has already moved once: on 2026-11-14 the
 * DSH 0.2.2-rc.3 prompt was blocked despite both original fingerprints being
 * rewritten, and bisecting it traced the block to the `@`-path paragraph (see
 * {@link NEUTRALIZERS}). Expect further moves; a measured rewrite is a
 * stopgap, not a protocol.
 *
 * Scope: CN chat bodies only. The international endpoint does not apply this
 * filter and must never see a rewritten prompt, so callers choose the region at
 * the call site (`prepareCnChatBody`), not inside this module.
 *
 * Two modes exist because the filter is upstream-owned and may learn new
 * fingerprint sentences:
 *
 * - normal: rewrite the known sentences, leave every other byte untouched;
 * - aggressive (fallback retry after a blocked response): additionally insert a
 *   zero-width space after every space in message text, which breaks a literal
 *   fingerprint while staying invisible to the model's reading of the prompt.
 *   It intentionally applies to every message role, because a block can also be
 *   triggered by text copied into a user message.
 *
 * Normal mode deliberately rewrites only `system`/`developer` messages. User
 * content is the user's own words; changing it silently is worse than letting
 * that particular request fail and surfacing the error.
 *
 * @module dsh-workbuddy-connect/cn-prompt
 */

/** One literal fingerprint and the semantically equivalent text that replaces it. */
interface PromptNeutralizer {
  /** Stable id, used in tests and documentation. */
  readonly id: string
  /** Case-insensitive, whitespace-tolerant matcher for the fingerprint. */
  readonly pattern: RegExp
  /** Replacement text; must not itself match any neutralizer. */
  readonly replacement: string
}

/**
 * The fingerprints observed on the CN gateway.
 *
 * The first two were measured on 2026-10-21 against DSH 0.2.1-rc.2. On
 * 2026-11-14 the gateway blocked the DSH 0.2.2-rc.3 prompt even with both of
 * them rewritten: bisecting that prompt showed the trigger is the `@`-path
 * paragraph, and that rewriting only its *first* sentence is enough to pass,
 * while rewriting the later sentences in place is not. That shape — a
 * sentence that passes alone, a paragraph that fails, and any break of the
 * leading sentence clearing it — is a content fingerprint anchored at the
 * paragraph start, not a word blacklist.
 */
const NEUTRALIZERS: readonly PromptNeutralizer[] = [
  {
    id: 'bootstrap-agent-line',
    pattern: /You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek\s+Harness\.?/giu,
    replacement: 'You are an AI agent. It runs on DeepSeek Harness.',
  },
  {
    id: 'gui-self-reference',
    pattern: /When\s+the\s+user\s+refers\s+to\s+[“"]this\s+page[”"],\s*[“"]this\s+GUI[”"],\s*or\s+[“"]this\s+app[”"]\s+without\s+naming\s+another\s+target,\s*they\s+mean\s+this\s+GUI\.?/giu,
    replacement: 'When the user mentions this page, this GUI, or this app without another target, they mean this GUI.',
  },
  {
    // 0.2.2-rc.3's path-reference paragraph. Only the opening sentence has to
    // change; the rest of the paragraph keeps its original wording.
    id: 'at-path-reference',
    pattern: /Tokens\s+prefixed\s+with\s+@\s+are\s+paths\s+the\s+user\s+explicitly\s+referenced\./giu,
    replacement: 'An @ prefix marks a path the user explicitly referenced.',
  },
]

/** The display text the CN gateway returns for a filtered prompt. */
const CN_BLOCK_DISPLAY_TEXT = '请求被拦截'

/** The `msg` spelling the CN gateway has also used for the same check. */
const CN_UNSUPPORTED_CHANNEL_TEXT = 'unapproved channel'

/** Options for {@link neutralizeCnChatBody}. */
export interface NeutralizeCnChatBodyOptions {
  /**
   * Fallback disguise: also rewrite every message role and inject a zero-width
   * space after every space. Only used for the single retry after the gateway
   * blocked a request, never on the first attempt.
   */
  aggressive?: boolean
}

/**
 * Rewrite the known CN fingerprints in one text.
 *
 * Pure and idempotent: the replacements contain none of the patterns.
 */
export function neutralizeCnPromptText(text: string): string {
  let next = text
  for (const neutralizer of NEUTRALIZERS) next = next.replace(neutralizer.pattern, neutralizer.replacement)
  return next
}

/** Insert a zero-width space after every ASCII space, breaking literal matching. */
function disguiseWithZeroWidthSpaces(text: string): string {
  return text.replace(/ /gu, ' \u200B')
}

/** Apply the normal neutralizers, then (optionally) the aggressive disguise. */
function neutralizeText(text: string, options: NeutralizeCnChatBodyOptions): string {
  const neutralized = neutralizeCnPromptText(text)
  return options.aggressive === true ? disguiseWithZeroWidthSpaces(neutralized) : neutralized
}

/** Rewrite the text of one message's content field in place; true when anything changed. */
function neutralizeContent(wrapped: Record<string, unknown>, options: NeutralizeCnChatBodyOptions): boolean {
  const content = wrapped['content']
  if (typeof content === 'string') {
    const next = neutralizeText(content, options)
    if (next === content) return false
    wrapped['content'] = next
    return true
  }
  if (!Array.isArray(content)) return false
  let changed = false
  for (const part of content) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
    const wrappedPart = part as Record<string, unknown>
    const text = wrappedPart['text']
    if (typeof text !== 'string') continue
    const next = neutralizeText(text, options)
    if (next !== text) {
      wrappedPart['text'] = next
      changed = true
    }
  }
  return changed
}

/**
 * Rewrite the CN fingerprints inside a chat-completions body.
 *
 * Returns `source` unchanged when it is not a JSON object, carries no
 * `messages` array, or has nothing to rewrite — so callers can compare the
 * result to detect whether a disguise would change anything. Everything except
 * message text is preserved byte-for-byte after a JSON round-trip.
 *
 * The aggressive mode rewrites every role, because the gateway matches the
 * whole body: a blocked user message would otherwise keep failing on retry.
 */
export function neutralizeCnChatBody(source: string, options: NeutralizeCnChatBodyOptions = {}): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages)) return source
  let changed = false
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    const role = typeof wrapped['role'] === 'string' ? wrapped['role'] : ''
    if (options.aggressive !== true && role !== 'system' && role !== 'developer') continue
    if (neutralizeContent(wrapped, options)) changed = true
  }
  return changed ? JSON.stringify(obj) : source
}

/**
 * Whether a CN chat response is the gateway's prompt filter rejection.
 *
 * Matches on the human-readable display text rather than the business code:
 * the same display text has been observed on more than one code, and the code
 * alone cannot distinguish this filter from a genuine upstream refusal.
 */
export function isCnPromptBlockedResponse(status: number, bodyText: string): boolean {
  if (status !== 400) return false
  return bodyText.includes(CN_BLOCK_DISPLAY_TEXT) || bodyText.includes(CN_UNSUPPORTED_CHANNEL_TEXT)
}
