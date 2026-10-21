import { ConfigurationError, ProviderError } from '../domain/errors/index.js'
import { redactText } from '../utils/redact.js'
import type { FetchLike } from './types.js'

/**
 * Shared HTTP transport for provider adapters.
 *
 * Responsibilities:
 * - POST JSON with an optional abort signal
 * - map HTTP/network failures onto structured `ProviderError`s with
 *   actionable hints, without ever exposing credentials or full payloads
 */

export interface PostJsonOptions {
  url: string
  /** Provider id, used in error messages. */
  providerId: string
  /** Human-readable provider name, used in error messages. */
  providerName: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
  /** Transport override (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike
}

/** Truncates provider-supplied detail so error output stays concise. */
function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Extract a safe, concise error description from a non-2xx response body.
 * Only the provider's own `error.message` is used — request headers and
 * credentials are never part of the body we echo back.
 */
async function errorDetail(response: Response): Promise<string | undefined> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = parsed['error']
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message']
      if (typeof message === 'string' && message !== '') {
        return truncate(redactText(message))
      }
    }
    if (typeof parsed['message'] === 'string') return truncate(redactText(parsed['message']))
  } catch {
    // Not JSON — fall through (never echo arbitrary payloads).
  }
  return undefined
}

/** Turn a non-2xx HTTP response into a structured, user-actionable error. */
async function toProviderError(response: Response, providerName: string): Promise<ProviderError> {
  const detail = await errorDetail(response)
  const suffix = detail !== undefined ? ` (${detail})` : ''
  const status = response.status

  if (status === 401 || status === 403) {
    return new ProviderError(`Invalid API key for ${providerName}${suffix}`, {
      hint: 'Check LUNAR_API_KEY (or "apiKey" in ~/.lunar/config.json).',
      details: { status },
    })
  }
  if (status === 404) {
    return new ProviderError(`Model or endpoint not found on ${providerName}${suffix}`, {
      hint: 'Check LUNAR_MODEL — the configured model may not exist on this provider.',
      details: { status },
    })
  }
  if (status === 429) {
    return new ProviderError(`Rate limited by ${providerName}${suffix}`, {
      hint: 'Wait a moment, then retry.',
      details: { status },
    })
  }
  if (status >= 500) {
    return new ProviderError(`${providerName} is currently unavailable${suffix}`, {
      hint: 'The provider had a server error. Try again shortly.',
      details: { status },
    })
  }
  return new ProviderError(`${providerName} request failed${suffix}`, {
    hint: 'Run with --debug for diagnostics.',
    details: { status },
  })
}

/** POST JSON and return the (successful) response. */
export async function postJson(options: PostJsonOptions): Promise<Response> {
  const fetchImpl: FetchLike = options.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // Preserve cancellation: the runtime recognizes aborts by the signal.
    if (options.signal?.aborted === true) throw error
    throw new ProviderError(`Unable to contact ${options.providerName}`, {
      hint: 'Check your network connection and try again.',
      cause: error,
      details: { provider: options.providerId },
    })
  }

  if (!response.ok) {
    throw await toProviderError(response, options.providerName)
  }
  return response
}

/** Parse a provider payload, converting malformed JSON into a Lunar error. */
export function parseProviderJson(providerName: string, data: string): unknown {
  try {
    return JSON.parse(data)
  } catch (error) {
    throw new ProviderError(`Malformed response from ${providerName}`, {
      hint: 'The provider returned data Lunar could not parse. Retry, or run with --debug.',
      cause: error,
    })
  }
}

/**
 * Resolve the API key for a provider that requires one. Missing keys are
 * configuration errors (not provider failures) and the key itself is never
 * echoed into any message.
 */
export function requireApiKey(apiKey: string | undefined, providerName: string): string {
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(`No API key configured for ${providerName}`, {
      hint: 'Set LUNAR_API_KEY or add "apiKey" to ~/.lunar/config.json.',
    })
  }
  return apiKey
}
