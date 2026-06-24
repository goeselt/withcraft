export interface CacheEntry<T> {
  data: T
  expires: number
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  constructor(private maxEntries: number) {}

  get(key: string, now = Date.now()): T | undefined {
    return this.getEntry(key, now)?.data
  }

  getEntry(key: string, now = Date.now()): CacheEntry<T> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (now >= entry.expires) {
      this.entries.delete(key)
      return undefined
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, data: T, ttl: number, now = Date.now()) {
    for (const [entryKey, entry] of this.entries) {
      if (now >= entry.expires) this.entries.delete(entryKey)
    }

    this.entries.delete(key)
    this.entries.set(key, { data, expires: now + ttl })

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (!oldest) break
      this.entries.delete(oldest)
    }
  }

  setMaxEntries(n: number) {
    this.maxEntries = n
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (!oldest) break
      this.entries.delete(oldest)
    }
  }

  clear() {
    this.entries.clear()
  }
}

export interface HeaderReader {
  get(name: string): string | null
}

const MIN_RETRY_TTL = 1_000
const DEFAULT_RETRY_TTL = 30_000
const MAX_RETRY_TTL = 15 * 60_000

export function retryTtlFromHeaders(headers: HeaderReader, now = Date.now()): number {
  const retryAfter = parseRetryAfter(headers.get('retry-after'), now)
  if (retryAfter !== undefined) return clampRetryTtl(retryAfter)

  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return clampRetryTtl(reset * 1000 - now)

  return DEFAULT_RETRY_TTL
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return date - now
  return undefined
}

function clampRetryTtl(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRY_TTL
  return Math.min(MAX_RETRY_TTL, Math.max(MIN_RETRY_TTL, value))
}
