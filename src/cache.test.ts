import { describe, expect, it } from 'vitest'
import { retryTtlFromHeaders, TtlCache } from './cache.js'

describe('TtlCache', () => {
  it('keeps negative entries distinguishable from cache misses', () => {
    const cache = new TtlCache<string | undefined>(10)
    cache.set('missing', undefined, 1000, 100)

    expect(cache.getEntry('missing', 200)).toEqual({ data: undefined, expires: 1100 })
    expect(cache.getEntry('missing', 1200)).toBeUndefined()
  })

  it('evicts the oldest entry when maxEntries is exceeded', () => {
    const cache = new TtlCache<string>(2)
    cache.set('a', 'A', 60_000)
    cache.set('b', 'B', 60_000)
    cache.set('c', 'C', 60_000) // should evict 'a'

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('B')
    expect(cache.get('c')).toBe('C')
  })

  it('evicts excess entries immediately when setMaxEntries shrinks the limit', () => {
    const cache = new TtlCache<string>(5)
    cache.set('a', 'A', 60_000)
    cache.set('b', 'B', 60_000)
    cache.set('c', 'C', 60_000)

    cache.setMaxEntries(1)

    expect(cache.get('c')).toBe('C')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
  })
})

describe('retryTtlFromHeaders', () => {
  it('uses retry-after before rate limit reset', () => {
    const headers = new Map([
      ['retry-after', '5'],
      ['x-ratelimit-reset', '9999999999'],
    ])

    expect(retryTtlFromHeaders({ get: (name) => headers.get(name) ?? null }, 1_000)).toBe(5_000)
  })

  it('uses x-ratelimit-reset when retry-after is absent', () => {
    const headers = new Map([['x-ratelimit-reset', '10']])
    expect(retryTtlFromHeaders({ get: (name) => headers.get(name) ?? null }, 5_000)).toBe(5_000)
  })
})
