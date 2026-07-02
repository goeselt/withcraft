import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearRemoteCache,
  DEFAULT_REQUEST_TIMEOUT_MS,
  effectiveRequestTimeoutMs,
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
    expect(metadata.source.action?.pinInfo).toBe('feature/my-branch')
    expect(metadata.source.action?.pinInfoUrl).toBe('https://github.com/owner/repo/tree/feature%2Fmy-branch')
  })

  it('classifies full commit SHA references as SHA pins without a commit lookup', async () => {
    const urls: string[] = []
    const sha = '1234567890abcdef1234567890abcdef12345678'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        urls.push(requestUrl)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${sha}`)) {
          return textResponse('name: SHA Pinned Action\n')
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
        ref: sha,
        raw: `owner/repo@${sha}`,
      },
      {
        hosts: ['github.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(urls).not.toContain(`https://api.github.com/repos/owner/repo/commits/${sha}`)
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('sha pin')
    expect(metadata.source.action?.pinInfoUrl).toBe(`https://github.com/owner/repo/commit/${sha}`)
    expect(metadata.source.action?.resolvedSha).toBe(sha)
  })

  it('uses an inline pin comment only when it resolves to the same SHA', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'
    const latestSha = '2222222222222222222222222222222222222222'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([
            { name: 'v1.2.1', commit: { sha } },
            { name: 'v1.2.2', commit: { sha: latestSha } },
          ])
        }
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${sha}`)) {
          return textResponse('name: SHA Pinned Action\n')
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
        ref: sha,
        pinInfo: '# v1.2.1',
        raw: `owner/repo@${sha}`,
      },
      {
        hosts: ['github.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('v1.2.1')
    expect(metadata.source.action?.pinInfoUrl).toBe('https://github.com/owner/repo/tree/v1.2.1')
    expect(metadata.source.action?.latest).toMatchObject({
      name: 'v1.2.2',
      sha: latestSha,
      isCurrent: false,
    })
  })

  it('ignores an inline pin comment that resolves to a different SHA', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'
    const staleCommentSha = '2222222222222222222222222222222222222222'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v1.2.1', commit: { sha: staleCommentSha } }])
        }
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${sha}`)) {
          return textResponse('name: SHA Pinned Action\n')
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
        ref: sha,
        pinInfo: '# v1.2.1',
        raw: `owner/repo@${sha}`,
      },
      {
        hosts: ['github.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('sha pin')
    expect(metadata.source.action?.pinInfoUrl).toBe(`https://github.com/owner/repo/commit/${sha}`)
  })

  it('does not resolve a non-ref-like inline pin comment against the API', async () => {
    const urls: string[] = []
    const sha = '1234567890abcdef1234567890abcdef12345678'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        urls.push(requestUrl)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${sha}`)) {
          return textResponse('name: SHA Pinned Action\n')
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
        ref: sha,
        pinInfo: '# bumped by renovate on 2024-01-01',
        raw: `owner/repo@${sha}`,
      },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    // Prose comments must not be turned into a `/commits/<text>` lookup.
    expect(urls.some((url) => url.includes('/commits/'))).toBe(false)
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('sha pin')
  })

  it('reads action metadata from the current tag even when a newer tag exists', async () => {
    const currentSha = '1111111111111111111111111111111111111111'
    const latestSha = '2222222222222222222222222222222222222222'
    const contentRequests: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([
            { name: 'v1', commit: { sha: currentSha } },
            { name: 'v2', commit: { sha: latestSha } },
          ])
        }
        if (requestUrl.includes('/repos/owner/repo/contents/action.yml?ref=')) {
          contentRequests.push(requestUrl)
          if (requestUrl.endsWith('?ref=v1')) {
            return textResponse(
              'name: Current Tag Action\n' +
                'description: From the current tag\n' +
                'inputs:\n' +
                '  current-input:\n' +
                '    description: Only on v1\n' +
                'outputs:\n' +
                '  current-output:\n' +
                '    description: Output from v1\n',
            )
          }
          if (requestUrl.endsWith('?ref=v2')) {
            return textResponse('name: Latest Tag Action\ninputs:\n  latest-input:\n    description: Only on v2\n')
          }
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
        hosts: ['github.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(contentRequests).toEqual(['https://api.github.com/repos/owner/repo/contents/action.yml?ref=v1'])
    expect(metadata?.name).toBe('Current Tag Action')
    expect(metadata?.description).toBe('From the current tag')
    expect(metadata?.inputs.map((input) => input.name)).toEqual(['current-input'])
    expect(metadata?.outputs.map((output) => output.name)).toEqual(['current-output'])
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.resolvedSha).toBe(currentSha)
    expect(metadata.source.action?.latest).toMatchObject({
      name: 'v2',
      sha: latestSha,
      isCurrent: false,
    })
  })

  it('reads action metadata from a SHA pin while still reporting the latest tag', async () => {
    const pinnedSha = '1111111111111111111111111111111111111111'
    const latestSha = '2222222222222222222222222222222222222222'
    const contentRequests: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v2', commit: { sha: latestSha } }])
        }
        if (requestUrl.includes('/repos/owner/repo/contents/action.yml?ref=')) {
          contentRequests.push(requestUrl)
          if (requestUrl.endsWith(`?ref=${pinnedSha}`)) {
            return textResponse('name: SHA Pinned Action\ninputs:\n  pinned-input:\n    description: From the pin\n')
          }
          if (requestUrl.endsWith('?ref=v2')) {
            return textResponse('name: Latest Tag Action\ninputs:\n  latest-input:\n    description: Only on v2\n')
          }
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
        ref: pinnedSha,
        raw: `owner/repo@${pinnedSha}`,
      },
      {
        hosts: ['github.com'],
        maxEntries: 100,
        tokenForHost: () => Promise.resolve<string | undefined>(void 0),
      },
    )

    expect(contentRequests).toEqual([`https://api.github.com/repos/owner/repo/contents/action.yml?ref=${pinnedSha}`])
    expect(metadata?.name).toBe('SHA Pinned Action')
    expect(metadata?.inputs.map((input) => input.name)).toEqual(['pinned-input'])
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('sha pin')
    expect(metadata.source.action?.latest).toMatchObject({
      name: 'v2',
      sha: latestSha,
      isCurrent: false,
    })
  })

  it('upgrades a floating tag ref to the most specific tag at the same SHA', async () => {
    const sha = '1111111111111111111111111111111111111111'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([
            { name: 'v6', commit: { sha } },
            { name: 'v6.0.1', commit: { sha } },
          ])
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v6')) {
          return textResponse('name: Floating Tag Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'v6', raw: 'owner/repo@v6' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('v6.0.1')
    expect(metadata.source.action?.pinInfoUrl).toBe('https://github.com/owner/repo/tree/v6.0.1')
  })

  it('labels a branch ref with the tag that points at the branch head', async () => {
    const headSha = '1111111111111111111111111111111111111111'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v6.0.1', commit: { sha: headSha } }])
        }
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) return jsonResponse({ sha: headSha })
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=main')) {
          return textResponse('name: Branch Head Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'main', raw: 'owner/repo@main' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('v6.0.1')
    expect(metadata.source.action?.pinInfoUrl).toBe('https://github.com/owner/repo/tree/v6.0.1')
  })

  it('falls back to the literal branch name when no tag points at the head', async () => {
    const headSha = '1111111111111111111111111111111111111111'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) return jsonResponse({ sha: headSha })
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=main')) {
          return textResponse('name: Branch Head Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'main', raw: 'owner/repo@main' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('main')
    expect(metadata.source.action?.pinInfoUrl).toBe('https://github.com/owner/repo/tree/main')
  })

  it('paginates the tags endpoint to find a tag beyond the first page', async () => {
    const requestedPages: string[] = []
    const sha = '1111111111111111111111111111111111111111'
    const firstPage = Array.from({ length: 100 }, (_unused, index) => ({
      name: `v0.0.${index}`,
      commit: { sha: `0${index.toString().padStart(39, '0')}` },
    }))

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)

        if (requestUrl.includes('/repos/owner/repo/tags?per_page=100')) {
          requestedPages.push(requestUrl)
          if (requestUrl.includes('&page=2')) return jsonResponse([{ name: 'v9.9.9', commit: { sha } }])
          return jsonResponse(firstPage)
        }
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${sha}`)) {
          return textResponse('name: Paginated Tag Action\n')
        }

        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: sha, raw: `owner/repo@${sha}` },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(requestedPages).toEqual([
      'https://api.github.com/repos/owner/repo/tags?per_page=100',
      'https://api.github.com/repos/owner/repo/tags?per_page=100&page=2',
    ])
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('v9.9.9')
    expect(metadata.source.action?.latest).toMatchObject({ name: 'v9.9.9', sha, isCurrent: true })
  })

  it('reports the default branch HEAD as latest for a bare SHA pin of a tagless repo', async () => {
    const pinnedSha = '1111111111111111111111111111111111111111'
    const headSha = '2222222222222222222222222222222222222222'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo')) return jsonResponse({ default_branch: 'main' })
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) return jsonResponse({ sha: headSha })
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${pinnedSha}`)) {
          return textResponse('name: Tagless Action\n')
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: pinnedSha, raw: `owner/repo@${pinnedSha}` },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.pinInfo).toBe('sha pin')
    expect(metadata.source.action?.latest).toEqual({
      name: 'main',
      url: 'https://github.com/owner/repo/tree/main',
      sha: headSha,
      commitUrl: `https://github.com/owner/repo/commit/${headSha}`,
      isCurrent: false,
    })
  })

  it('marks the default branch latest current when the bare SHA pin already is the HEAD', async () => {
    const sha = '1111111111111111111111111111111111111111'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo')) return jsonResponse({ default_branch: 'main' })
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) return jsonResponse({ sha })
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${sha}`)) {
          return textResponse('name: Tagless Action\n')
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: sha, raw: `owner/repo@${sha}` },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.latest?.isCurrent).toBe(true)
  })

  it('does not look up the default branch when the repo has a semver tag', async () => {
    const pinnedSha = '1111111111111111111111111111111111111111'
    const latestSha = '2222222222222222222222222222222222222222'
    const urls: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        urls.push(requestUrl)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v2', commit: { sha: latestSha } }])
        }
        if (requestUrl.endsWith(`/repos/owner/repo/contents/action.yml?ref=${pinnedSha}`)) {
          return textResponse('name: Tagged Action\n')
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: pinnedSha, raw: `owner/repo@${pinnedSha}` },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(urls).not.toContain('https://api.github.com/repos/owner/repo')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.latest).toMatchObject({ name: 'v2', sha: latestSha, isCurrent: false })
  })

  it('does not fall back to the default branch for a tagless branch pin', async () => {
    const headSha = '1111111111111111111111111111111111111111'
    const urls: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        urls.push(requestUrl)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) return jsonResponse({ sha: headSha })
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=main')) {
          return textResponse('name: Branch Action\n')
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'main', raw: 'owner/repo@main' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(urls).not.toContain('https://api.github.com/repos/owner/repo')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.latest).toBeUndefined()
  })

  it('falls back to latest metadata when a pinned SHA does not exist but the repo has a tag', async () => {
    const missingSha = '01ceeba31f0d26eaaf8fbb4a60162001ee138d5c'
    const latestSha = '2222222222222222222222222222222222222222'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) {
          return jsonResponse([{ name: 'v1.2.0', commit: { sha: latestSha } }])
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=v1.2.0')) {
          return textResponse('name: Intent\ndescription: Latest description\ninputs:\n  token:\n    description: t\n')
        }
        // The pinned commit does not exist: content at that ref is absent.
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: missingSha,
        raw: `owner/repo@${missingSha}`,
      },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.name).toBe('Intent')
    expect(metadata?.description).toBe('Latest description')
    // Inputs/outputs belong to a different version and must not be shown for the pinned commit.
    expect(metadata?.inputs).toEqual([])
    expect(metadata?.outputs).toEqual([])
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.url).toBe('https://github.com/owner/repo/blob/v1.2.0/action.yml')
    expect(metadata.source.action?.currentUnresolved).toBe(true)
    expect(metadata.source.action?.resolvedSha).toBe(missingSha)
    expect(metadata.source.action?.latest).toMatchObject({ name: 'v1.2.0', sha: latestSha })
  })

  it('falls back to the default branch HEAD when a pinned SHA is missing in a tagless repo', async () => {
    const missingSha = '01ceeba31f0d26eaaf8fbb4a60162001ee138d5c'
    const headSha = '2222222222222222222222222222222222222222'

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo')) return jsonResponse({ default_branch: 'main' })
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) return jsonResponse({ sha: headSha })
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=main')) {
          return textResponse('name: Intent Main\n')
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
        ref: missingSha,
        raw: `owner/repo@${missingSha}`,
      },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.name).toBe('Intent Main')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action?.currentUnresolved).toBe(true)
    expect(metadata.source.action?.latest).toMatchObject({ name: 'main', sha: headSha, isCurrent: false })
  })

  it('does not fall back when a pinned SHA is missing and the repo does not exist', async () => {
    const missingSha = '01ceeba31f0d26eaaf8fbb4a60162001ee138d5c'

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Response('not found', { status: 404 })),
    )

    const metadata = await resolveRemoteMetadata(
      {
        kind: 'remote-action',
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: missingSha,
        raw: `owner/repo@${missingSha}`,
      },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata).toBeUndefined()
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
    expect(metadata.source.action?.pinInfo).toBe('v1.0.23')
    expect(metadata.source.action?.pinInfoUrl).toBe(
      'https://github.example.com/example-org/action-workflows/tree/v1.0.23',
    )
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

  it('does not inspect tags or version on a host where the action file is absent', async () => {
    const urls: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        urls.push(requestUrl)
        // Every request 404s: the repo does not exist on this host.
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'v1', raw: 'owner/repo@v1' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata).toBeUndefined()
    // Only the two content candidates are probed; no tag/branch/repo lookups once the file is known to be absent.
    expect(urls).toEqual([
      'https://api.github.com/repos/owner/repo/contents/action.yml?ref=v1',
      'https://api.github.com/repos/owner/repo/contents/action.yaml?ref=v1',
    ])
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

  it('rejects an oversized JSON API response instead of buffering it', async () => {
    // Valid JSON above the limit and without a Content-Length header: only the
    // streamed size guard can reject it. Without the guard `res.json()` would
    // parse the commit and version inspection would succeed; with the guard the
    // commit lookup fails, so the resolved version info is dropped.
    const oversizedCommit = JSON.stringify({
      sha: '1234567890abcdef1234567890abcdef12345678',
      padding: 'x'.repeat(MAX_RESPONSE_BODY_BYTES),
    })

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const requestUrl = String(url)
        if (requestUrl.endsWith('/repos/owner/repo/tags?per_page=100')) return jsonResponse([])
        if (requestUrl.endsWith('/repos/owner/repo/commits/main')) {
          return new Response(oversizedCommit, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (requestUrl.endsWith('/repos/owner/repo/contents/action.yml?ref=main')) {
          return textResponse('name: Branch Action\n')
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const metadata = await resolveRemoteMetadata(
      { kind: 'remote-action', owner: 'owner', repo: 'repo', path: '', ref: 'main', raw: 'owner/repo@main' },
      { hosts: ['github.com'], maxEntries: 100, tokenForHost: () => Promise.resolve<string | undefined>(void 0) },
    )

    expect(metadata?.name).toBe('Branch Action')
    expect(metadata?.source.kind).toBe('remote')
    if (metadata?.source.kind !== 'remote') throw new Error('expected remote metadata')
    expect(metadata.source.action).toBeUndefined()
  })
})

describe('effectiveRequestTimeoutMs', () => {
  it('falls back to the default for values that would disable the timeout', () => {
    expect(effectiveRequestTimeoutMs(undefined)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(effectiveRequestTimeoutMs(0)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(effectiveRequestTimeoutMs(-1)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(effectiveRequestTimeoutMs(Number.NaN)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(effectiveRequestTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REQUEST_TIMEOUT_MS)
  })

  it('keeps positive finite values', () => {
    expect(effectiveRequestTimeoutMs(2500)).toBe(2500)
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
