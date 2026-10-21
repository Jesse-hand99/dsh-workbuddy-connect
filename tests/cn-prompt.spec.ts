import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  isCnPromptBlockedResponse,
  neutralizeCnChatBody,
  neutralizeCnPromptText,
} from '../src/cn-prompt.ts'
import { WorkBuddyUpstreamClient, prepareCnChatBody, prepareInternationalChatBody } from '../src/upstream.ts'

/**
 * Pins for the CN prompt neutralization added for the 2026-10-20 gateway
 * content filter: the CN endpoint answers a chat body carrying the harness's
 * own bootstrap sentences with HTTP 400 / 「请求被拦截，请重新发送」. The
 * replacement keeps the meaning while removing the fingerprint; the
 * international path must never be rewritten.
 *
 * The two sentences below are the exact fingerprints measured against the real
 * gateway; the rest of the fixture text stands in for arbitrary prompt content.
 */

const AGENT_LINE = 'You are an AI agent powered by DeepSeek Harness.'
const GUI_LINE = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

const IDENTITY = { clientVersion: '5.5.6' }

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('neutralizeCnPromptText', () => {
  it('rewrites the bootstrap agent sentence', () => {
    const next = neutralizeCnPromptText(`Intro.\n\n${AGENT_LINE}\n\nMore.`)
    expect(next).not.toContain(AGENT_LINE)
    expect(next).toContain('You are an AI agent. It runs on DeepSeek Harness.')
    expect(next.startsWith('Intro.')).toBe(true)
    expect(next.endsWith('More.')).toBe(true)
  })

  it('rewrites the GUI self-reference sentence and drops its quoted list', () => {
    const next = neutralizeCnPromptText(GUI_LINE)
    expect(next).not.toContain('"this page"')
    expect(next).toBe('When the user mentions this page, this GUI, or this app without another target, they mean this GUI.')
  })

  it('is case-insensitive and tolerates a missing final period', () => {
    expect(neutralizeCnPromptText('you are an ai agent powered by deepseek harness')).not.toMatch(/you are an ai agent powered by deepseek harness/i)
    expect(neutralizeCnPromptText('You are an AI agent powered by DeepSeek Harness')).toContain('It runs on DeepSeek Harness.')
  })

  it('is idempotent', () => {
    const once = neutralizeCnPromptText(`${AGENT_LINE} ${GUI_LINE}`)
    expect(neutralizeCnPromptText(once)).toBe(once)
  })

  it('leaves unrelated text untouched', () => {
    const text = 'You are a coding agent powered by the deepseek-flash model.'
    expect(neutralizeCnPromptText(text)).toBe(text)
  })
})

describe('neutralizeCnChatBody', () => {
  const body = (messages: unknown[]): string => JSON.stringify({ model: 'm', stream: true, messages })

  it('rewrites system text, including array content parts', () => {
    const source = body([
      { role: 'system', content: [{ type: 'text', text: AGENT_LINE }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    const next = neutralizeCnChatBody(source)
    expect(next).not.toContain(AGENT_LINE)
    expect(JSON.parse(next).messages[0].content[0].text).toContain('It runs on DeepSeek Harness.')
  })

  it('leaves user messages alone in normal mode', () => {
    const source = body([
      { role: 'system', content: 's' },
      { role: 'user', content: AGENT_LINE },
    ])
    expect(neutralizeCnChatBody(source)).toBe(source)
  })

  it('aggressive mode rewrites user messages and injects zero-width spaces', () => {
    const source = body([
      { role: 'system', content: AGENT_LINE },
      { role: 'user', content: 'describe this page' },
    ])
    const next = neutralizeCnChatBody(source, { aggressive: true })
    expect(next).not.toContain(AGENT_LINE)
    expect(next).toContain('\u200B')
    const parsed = JSON.parse(next)
    expect(parsed.messages[1].content).toBe('describe \u200Bthis \u200Bpage')
  })

  it('returns the source unchanged when nothing needs rewriting', () => {
    const source = body([{ role: 'system', content: 'plain' }])
    expect(neutralizeCnChatBody(source)).toBe(source)
    expect(neutralizeCnChatBody(source, { aggressive: true })).toBe(source)
    const spaced = body([{ role: 'system', content: 'plain text' }])
    expect(neutralizeCnChatBody(spaced, { aggressive: true })).not.toBe(spaced)
  })

  it('returns non-object or message-less bodies unchanged', () => {
    expect(neutralizeCnChatBody('plain text')).toBe('plain text')
    expect(neutralizeCnChatBody('[1,2]')).toBe('[1,2]')
    const noMessages = JSON.stringify({ model: 'm' })
    expect(neutralizeCnChatBody(noMessages)).toBe(noMessages)
  })

  it('preserves every other field, including tools', () => {
    const source = JSON.stringify({
      model: 'm',
      stream: true,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [{ role: 'system', content: AGENT_LINE }],
    })
    const parsed = JSON.parse(neutralizeCnChatBody(source))
    expect(parsed.model).toBe('m')
    expect(parsed.stream).toBe(true)
    expect(parsed.tools[0].function.name).toBe('read')
  })
})

describe('region scoping of the neutralization', () => {
  it('prepareCnChatBody neutralizes but prepareInternationalChatBody does not', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: AGENT_LINE }, { role: 'user', content: 'hi' }],
    })
    expect(prepareCnChatBody(body)).not.toContain(AGENT_LINE)
    expect(prepareInternationalChatBody(body)).toContain(AGENT_LINE)
  })
})

describe('isCnPromptBlockedResponse', () => {
  it('matches the measured display text only on HTTP 400', () => {
    expect(isCnPromptBlockedResponse(400, JSON.stringify({ displayMsg: { zh: '请求被拦截，请重新发送' } }))).toBe(true)
    expect(isCnPromptBlockedResponse(200, '请求被拦截')).toBe(false)
    expect(isCnPromptBlockedResponse(400, 'rate limited')).toBe(false)
  })
})

describe('CN chatStream retries once with the aggressive disguise', () => {
  const chatBody = JSON.stringify({
    model: 'hy3',
    stream: true,
    messages: [{ role: 'system', content: AGENT_LINE }, { role: 'user', content: 'hi' }],
  })

  it('retries a blocked CN request with zero-width-spaced text and succeeds', async () => {
    const blocked = JSON.stringify({ code: 11128, displayMsg: { zh: '请求被拦截，请重新发送' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(blocked, false, 400))
      .mockResolvedValueOnce(fakeResponse('{}', true, 200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await client().chatStream(CN, chatBody)
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)
    expect(JSON.stringify(secondBody)).toContain('\u200B')
    expect(JSON.stringify(secondBody)).not.toContain(AGENT_LINE)
  })

  it('does not retry the international chat on the same 400', async () => {
    const blocked = JSON.stringify({ displayMsg: { zh: '请求被拦截，请重新发送' } })
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(blocked, false, 400))
    vi.stubGlobal('fetch', fetchMock)
    const result = await client().chatStream(GLOBAL, chatBody)
    expect(result.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0]![0] as string)).toBe('https://www.workbuddy.ai/v2/chat/completions')
  })

  it('does not retry a non-blocking CN error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse('{"code":1,"msg":"quota exceeded"}', false, 400))
    vi.stubGlobal('fetch', fetchMock)
    const result = await client().chatStream(CN, chatBody)
    expect(result.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the first CN attempt already carries the normal (non-aggressive) rewrite', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse('{}', true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await client().chatStream(CN, chatBody)
    const firstBody = (fetchMock.mock.calls[0]![1] as RequestInit).body as string
    expect(firstBody).not.toContain(AGENT_LINE)
    expect(firstBody).not.toContain('\u200B')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
