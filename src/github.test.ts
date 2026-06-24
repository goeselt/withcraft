import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearRemoteCache,
  isValidHost,
  MAX_RESPONSE_BODY_BYTES,
  normalizeHost,
  normalizeHosts,
  resolveRemoteMetadata,
  resolveReusableWorkflowMetadata,
} from './github.js'

describe('resolveRemoteMetadata', () => {
  afterEach(() => {
    clearRemoteCache()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('encodes branch refs with slashes as a single GitHub commit path segment', async () => {
    const urls: string[] = []
    const sha = '1234567890abcdef1234567890abcdef12345678'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        urls.push(requestUrl)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo/commits/feature%2Fmy-branch')) {
          return jsonResponse({ sha })
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=feature%2Fmy-branch')) {
          return textResponse('name: Branch Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: 'feature/my-branch',
        raw: 'owner/repo@feature/my-branch',
      },
      {
        hosts: ['github.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(urls).toContain('https://api.github.com/repos/owner/repo/commits/feature%2Fmy-branch')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.resolvedSha).toBe(sha)
  })

  it('includes version metadata for remote reusable workflows', async () => {
    const sha = 'df4cb1c069e1874edd31b4311f1884172cec0e10'
    const latestSha = 'a81bbbf8298c0fa03ea29cdc473d45769f953675'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/example-org/action-workflows/tags?per_page=100')) {
          return jsonResponse([
            { name: 'v1.0.23', commit: { sha } },
            { name: 'v1.0.24', commit: { sha: latestSha } },
          ])
        }

        if (
          requestUrl.endsWith(
            '/repos/example-org/action-workflows/contents/.github/workflows/_check.super-linter.yml?ref=v1.0.23',
          )
        ) {
          return textResponse(
            'name: Super Linter\non:\n  workflow_call:\n    inputs:\n      mode:\n        required: true\n',
          )
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveReusableWorkflowMetadata(
      {
        kind: 'reusable-workflow',
        owner: 'example-org',
        repo: 'action-workflows',
        workflowPath: '.github/workflows/_check.super-linter.yml',
        ref: 'v1.0.23',
        raw: 'example-org/action-workflows/.github/workflows/_check.super-linter.yml@v1.0.23',
      },
      {
        hosts: ['github.example.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.fullName).toBe(
      'example-org/action-workflows/.github/workflows/_check.super-linter.yml',
    )
    expect(metadata.source.action?.resolvedSha).toBe(sha)
    expect(metadata.source.action?.version).toBe('v1.0.23')
    expect(metadata.source.action?.latest?.name).toBe('v1.0.24')
    expect(metadata.source.action?.latest?.isCurrent).toBe(false)
  })

  it('continues to the next configured host when a host request times out', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url)

        if (requestUrl.startsWith('https://api.github.com/')) return abortWhenSignalled(init)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v1', commit: { sha } }])
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v1')) {
          return textResponse('name: Enterprise Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: 'v1',
        raw: 'owner/repo@v1',
      },
      {
        hosts: ['github.com', 'company.ghe.com'],
        maxEntries: 100,
        requestTimeoutMs: 1,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(metadata?.name).toBe('Enterprise Action')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.host).toBe('company.ghe.com')
    expect(metadata.source.action?.latest?.isCurrent).toBe(true)
  })

  it('does not query a lower-priority host once a higher-priority host has a result', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'
    let enterpriseRequested = false

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.startsWith('https://company.ghe.com/')) enterpriseRequested = true
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v1', commit: { sha } }])
        }
        if (requestUrl === 'https://api.github.com/repos/owner/repo/contents/action.yml?ref=v1') {
          return textResponse('name: Public Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: 'v1',
        raw: 'owner/repo@v1',
      },
      {
        hosts: ['github.com', 'company.ghe.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(metadata?.name).toBe('Public Action')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.host).toBe('github.com')
    expect(enterpriseRequested).toBe(false)
  })

  it('shares a single in-flight request across concurrent identical lookups', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'
    let tagRequests = 0

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          tagRequests += 1
          return jsonResponse([{ name: 'v1', commit: { sha } }])
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v1')) {
          return textResponse('name: Public Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const uses = {
      kind: 'remote-action' as const,
      owner: 'owner',
      repo: 'repo',
      path: '',
      ref: 'v1',
      raw: 'owner/repo@v1',
    }
    const options = {
      hosts: ['github.com'],
      maxEntries: 100,
      tokenForHost: () => Promise.resolve<string | undefined>(void 0),
    }

    await Promise.all([resolveRemoteMetadata(uses, options), resolveRemoteMetadata(uses, options)])

    expect(tagRequests).toBe(1)
  })

  it('fetches metadata again when the ref changes', async () => {
    const v1Sha = '1111111111111111111111111111111111111111'
    const v2Sha = '2222222222222222222222222222222222222222'
    const contentRequests: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([
            { name: 'v1', commit: { sha: v1Sha } },
            { name: 'v2', commit: { sha: v2Sha } },
          ])
        }

        if (requestUrl.includes('/repos/owner/repo/contents/action.yml?ref=')) {
          contentRequests.push(requestUrl)
          if (requestUrl.endsWith('?ref=v1')) return textResponse('name: Version One\n')
          if (requestUrl.endsWith('?ref=v2')) return textResponse('name: Version Two\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const options = {
      hosts: ['github.com'],
      maxEntries: 100,
      tokenForHost: () => Promise.resolve<string | undefined>(void 0),
    }

    const first = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: 'v1',
        raw: 'owner/repo@v1',
      },
      options,
    )
    const second = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: 'v2',
        raw: 'owner/repo@v2',
      },
      options,
    )

    expect(first?.name).toBe('Version One')
    expect(second?.name).toBe('Version Two')
    expect(contentRequests).toEqual([
      'https://api.github.com/repos/owner/repo/contents/action.yml?ref=v1',
      'https://api.github.com/repos/owner/repo/contents/action.yml?ref=v2',
    ])
  })

  it('retries incomplete version inspection after the short metadata cache ttl', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const sha = '1234567890abcdef1234567890abcdef12345678'
    let tagRequests = 0

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          tagRequests += 1
          if (tagRequests === 1) return new Response('temporary error', { status: 500 })
          return jsonResponse([{ name: 'v1.0.0', commit: { sha } }])
        }
        if (requestUrl.endsWith('/repos/owner/repo/commits/v1')) return jsonResponse({ sha })
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v1')) {
          return textResponse('name: Cached Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const uses = {
      kind: 'remote-action' as const,
      owner: 'owner',
      repo: 'repo',
      path: '',
      ref: 'v1',
      raw: 'owner/repo@v1',
    }
    const options = {
      hosts: ['github.com'],
      maxEntries: 100,
      tokenForHost: () => Promise.resolve<string | undefined>(void 0),
    }

    const first = await resolveRemoteMetadata(uses, options)
    expect(first?.source.kind).toBe('remote')
    if (first?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(first.source.action?.latest).toBeUndefined()

    const cached = await resolveRemoteMetadata(uses, options)
    expect(tagRequests).toBe(1)
    expect(cached?.source.kind).toBe('remote')
    if (cached?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(cached.source.action?.latest).toBeUndefined()

    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))

    const refreshed = await resolveRemoteMetadata(uses, options)
    expect(tagRequests).toBe(2)
    expect(refreshed?.source.kind).toBe('remote')
    if (refreshed?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(refreshed.source.action?.version).toBe('v1.0.0')
    expect(refreshed.source.action?.latest?.name).toBe('v1.0.0')
    expect(refreshed.source.action?.latest?.isCurrent).toBe(true)
  })
})

describe('isValidHost', () => {
  it('accepts GitHub and GitHub Enterprise Server host names', () => {
    for (const host of [
      'github.com',
      'github.company.example',
      'github.example.com',
      'company.ghe.com',
      'host.example:8443',
    ]) {
      expect(isValidHost(host)).toBe(true)
    }
  })

  it('rejects hosts that could redirect token-bearing requests', () => {
    for (const host of [
      'github.com@attacker.example.com',
      'github.com/api/v3',
      'github.com#@evil',
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      '[::1]',
      'has space.com',
      '',
    ]) {
      expect(isValidHost(host)).toBe(false)
    }
  })
})

describe('normalizeHost', () => {
  it('canonicalizes scheme, trailing slash, and casing so token keys match lookups', () => {
    expect(normalizeHost('https://GitHub.com/')).toBe('github.com')
    expect(normalizeHost('  github.com  ')).toBe('github.com')
    expect(normalizeHost('GitHub.Example.COM')).toBe('github.example.com')
  })

  it('returns undefined for invalid hosts', () => {
    expect(normalizeHost('localhost')).toBeUndefined()
    expect(normalizeHost('github.com/api')).toBeUndefined()
    expect(normalizeHost('')).toBeUndefined()
  })
})

describe('normalizeHosts', () => {
  it('strips scheme and trailing slashes, dedupes, and drops invalid hosts', () => {
    expect(normalizeHosts(['https://github.com/', 'github.com', 'localhost', '169.254.169.254'])).toEqual([
      'github.com',
    ])
  })

  it('falls back to github.com when every configured host is invalid', () => {
    expect(normalizeHosts(['github.com@attacker.example.com', 'localhost'])).toEqual(['github.com'])
  })

  it('preserves valid Enterprise hosts in order', () => {
    expect(normalizeHosts(['github.com', 'company.ghe.com'])).toEqual(['github.com', 'company.ghe.com'])
  })
})

describe('remote metadata URL encoding', () => {
  afterEach(() => {
    clearRemoteCache()
    vi.unstubAllGlobals()
  })

  it('percent-encodes untrusted owner/repo segments in generated web URLs', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/a%29b/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v1', commit: { sha } }])
        }
        if (requestUrl.endsWith('/repos/a%29b/repo/contents/action.yml?ref=v1')) {
          return textResponse('name: Injected\n')
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'a)b', repo: 'repo', path: '', ref: 'v1', raw: 'a)b/repo@v1' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    // A raw ')' would break out of a Markdown link target in the hover.
    expect(metadata.source.url).not.toContain(')')
    expect(metadata.source.url).toContain('a%29b')
    expect(metadata.source.action?.repoUrl).toBe('https://github.com/a%29b/repo')
  })
})

describe('response body size limit', () => {
  afterEach(() => {
    clearRemoteCache()
    vi.unstubAllGlobals()
  })

  it('skips an action.yml whose Content-Length exceeds the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo/commits/v1')) {
          return jsonResponse({ sha: '1234567890abcdef1234567890abcdef12345678' })
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v1')) {
          return new Response('name: Big Action\n', {
            status: 200,
            headers: { 'content-length': String(MAX_RESPONSE_BODY_BYTES + 1) },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'v1', raw: 'owner/repo@v1' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata).toBeUndefined()
  })

  it('skips an action.yml whose body length exceeds the limit even without Content-Length', async () => {
    const oversizedBody = 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 1)

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo/commits/v1')) {
          return jsonResponse({ sha: '1234567890abcdef1234567890abcdef12345678' })
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v1')) {
          return new Response(oversizedBody, { status: 200 })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'v1', raw: 'owner/repo@v1' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata).toBeUndefined()
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

function abortWhenSignalled(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}
