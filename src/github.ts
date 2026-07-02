import { retryTtlFromHeaders, TtlCache } from './cache.js'
import { noopLogger, type Logger } from './log.js'
import { parseActionMetadata, parseReusableWorkflowMetadata } from './metadata.js'
import type {
  ActionMetadata,
  LatestActionVersion,
  RemoteActionInfo,
  RemoteRefKind,
  RemoteActionReference,
  ReusableWorkflowReference,
} from './types.js'

// -- Constants --------------------------------------------------------------------------------------------------------

export const DEFAULT_HOST = 'github.com'
const SHA_RE = /^[0-9a-f]{40}$/i
// A valid GitHub host is a DNS name (FQDN), optionally with a port.
// Requiring a dot-separated name whose final label starts with a letter rejects userinfo (`github.com@evil.com`),
// embedded paths (`github.com/x`), `localhost`, and IP literals (`127.0.0.1`, `169.254.169.254`) -- all of which would
// otherwise let workspace-configured hosts redirect token-bearing requests (SSRF / leak).
const HOST_RE =
  /^(?=.{1,253}(?::\d{1,5})?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/i
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

// Cache TTLs. SHAs are immutable; tags rarely change; branches may change hourly.
const SHA_TTL = 30 * 24 * 60 * 60_000
const TAG_TTL = 7 * 24 * 60 * 60_000
const BRANCH_TTL = 60 * 60_000
// Negative / transient results get a short TTL so editors recover quickly after a network blip or
// a race during `git push`.
const NOT_FOUND_TTL = 5 * 60_000
const TRANSIENT_FAILURE_TTL = 30_000
// An oversized action.yml is unlikely to shrink soon; cache the skip for 24 h.
const OVERSIZED_TTL = 24 * 60 * 60_000

// Raw content fetch size limit. Legitimate action.yml files are rarely larger than a few kilobytes;
// 500 KB is orders of magnitude above that.
// Rejecting larger bodies prevents a rogue or misconfigured action from allocating large amounts of memory in the
// extension host process.
export const MAX_RESPONSE_BODY_BYTES = 500_000
// API responses for tags and branch refs are cached for 1 hour.
const TAGS_TTL = 60 * 60_000
const REF_TTL = 60 * 60_000
// A repository's default branch name rarely changes; cache it for a day. The branch HEAD it points at is resolved
// separately through getBranchSha (REF_TTL), so a new commit is still picked up within the hour.
const REPO_TTL = 24 * 60 * 60_000
// Tag pagination: page size and the page cap that bounds requests for repos with very large tag histories
// (MAX_TAG_PAGES * TAGS_PER_PAGE tags covered).
const TAGS_PER_PAGE = 100
const MAX_TAG_PAGES = 10

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

// The settings schema declares a minimum, but settings.json can still contain zero, negative, or non-numeric values.
// A non-positive timeout would disable the timeout entirely (fetchWithTimeout treats it as "no limit"), so fall back
// to the default instead of trusting the configured value.
export function effectiveRequestTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS
}

// -- Types ------------------------------------------------------------------------------------------------------------

export interface RemoteResolverOptions {
  hosts: string[]
  maxEntries: number
  tokenForHost: (host: string) => Promise<string | undefined>
  requestTimeoutMs?: number
  logger?: Logger
  requestId?: string
  operation?: string
}

export interface TagRef {
  name: string
  sha: string
}

interface TagResponse {
  name: string
  commit: { sha: string }
}

interface CommitResponse {
  sha: string
}

interface RepoResponse {
  default_branch: string
}

interface ResolvedRef {
  sha: string
  commitUrl: string
  refKind: RemoteRefKind
  refUrl: string
}

interface VersionedRemoteRef {
  owner: string
  repo: string
  ref: string
  pinInfo: string | undefined
  fullName: string
}

interface RemoteActionInspection {
  action: RemoteActionInfo | undefined
  complete: boolean
}

// Carries the fields logged at resolve.start / resolve.miss without coupling resolveMetadataAcrossHosts to the full
// UsesReference union.
interface RemoteReferenceLogInfo {
  kind: 'remote-action' | 'reusable-workflow'
  raw: string
  owner: string
  repo: string
  ref: string
  path: string
}

// -- Module-level cache state -----------------------------------------------------------------------------------------

// Shared across all provider invocations within the extension's lifetime.
// Call clearRemoteCache() to reset (e.g. after token changes or on demand).

const remoteCache = new TtlCache<ActionMetadata | undefined>(1000)
const tagsCache = new TtlCache<TagRef[] | undefined>(1000)
const refCache = new TtlCache<ResolvedRef | undefined>(1000)
const repoCache = new TtlCache<string | undefined>(1000)
const inFlight = new Map<string, Promise<ActionMetadata | undefined>>()
const apiInFlight = new Map<string, Promise<unknown>>()
let nextRequestId = 1

// -- Host validation --------------------------------------------------------------------------------------------------

export function isValidHost(host: string): boolean {
  return HOST_RE.test(host)
}

// Canonical form of a single host: scheme and trailing slashes stripped and lower-cased (DNS is case-insensitive).
// Returns undefined for invalid hosts.
// Used both for resolution and for the token storage key so that a token set as `https://GitHub.com/` is still found
// when looking up the normalized `github.com`.
export function normalizeHost(host: string): string | undefined {
  const normalized = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .toLowerCase()
  return isValidHost(normalized) ? normalized : undefined
}

export function normalizeHosts(hosts: string[]): string[] {
  const normalized = hosts.map(normalizeHost).filter((host): host is string => host !== undefined)
  return [...new Set(normalized.length > 0 ? normalized : [DEFAULT_HOST])]
}

// -- Public API -------------------------------------------------------------------------------------------------------

export function clearRemoteCache() {
  remoteCache.clear()
  tagsCache.clear()
  refCache.clear()
  repoCache.clear()
  inFlight.clear()
  apiInFlight.clear()
}

export function resolveRemoteMetadata(
  uses: RemoteActionReference,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  remoteCache.setMaxEntries(options.maxEntries)
  return resolveMetadataAcrossHosts(
    options,
    {
      kind: uses.kind,
      raw: uses.raw,
      owner: uses.owner,
      repo: uses.repo,
      ref: uses.ref,
      path: uses.path || 'action.yml|action.yaml',
    },
    (host, hostOptions) => resolveRemoteMetadataOnHost(uses, host, hostOptions),
  )
}

export function resolveReusableWorkflowMetadata(
  uses: ReusableWorkflowReference,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  remoteCache.setMaxEntries(options.maxEntries)
  return resolveMetadataAcrossHosts(
    options,
    {
      kind: uses.kind,
      raw: uses.raw,
      owner: uses.owner,
      repo: uses.repo,
      ref: uses.ref,
      path: uses.workflowPath,
    },
    (host, hostOptions) => resolveReusableWorkflowMetadataOnHost(uses, host, hostOptions),
  )
}

// -- Multi-host resolution --------------------------------------------------------------------------------------------

async function resolveMetadataAcrossHosts(
  options: RemoteResolverOptions,
  reference: RemoteReferenceLogInfo,
  resolveOnHost: (host: string, options: RemoteResolverOptions) => Promise<ActionMetadata | undefined>,
): Promise<ActionMetadata | undefined> {
  const hosts = normalizeHosts(options.hosts)
  const logger = options.logger ?? noopLogger
  const requestId = `r${nextRequestId++}`
  const started = Date.now()

  logger.debug('resolve.start', {
    id: requestId,
    operation: options.operation,
    kind: reference.kind,
    reference: reference.raw,
    owner: reference.owner,
    repo: reference.repo,
    ref: reference.ref,
    path: reference.path,
    hosts,
    timeoutMs: effectiveRequestTimeoutMs(options.requestTimeoutMs),
  })

  for (const [index, host] of hosts.entries()) {
    const hostStarted = Date.now()
    const metadata = await resolveOnHost(host, { ...options, requestId })
    logger.debug('resolve.host', {
      id: requestId,
      host,
      hostIndex: index,
      status: metadata ? 'found' : 'miss',
      durationMs: Date.now() - hostStarted,
    })

    if (metadata) {
      logger.info('resolve.selected', {
        id: requestId,
        operation: options.operation,
        kind: reference.kind,
        reference: reference.raw,
        host,
        hostIndex: index,
        durationMs: Date.now() - started,
        source: remoteSourceSummary(metadata),
        action: remoteActionSummary(metadata),
      })
      return metadata
    }
  }

  logger.info('resolve.miss', {
    id: requestId,
    operation: options.operation,
    kind: reference.kind,
    reference: reference.raw,
    durationMs: Date.now() - started,
    hosts,
  })
  return undefined
}

// -- Per-host resolution ----------------------------------------------------------------------------------------------

function resolveReusableWorkflowMetadataOnHost(
  uses: ReusableWorkflowReference,
  host: string,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  const key = `metadata:v1:${host}:${uses.owner}/${uses.repo}:${uses.workflowPath}@${uses.ref}`

  const entry = remoteCache.getEntry(key)
  if (entry) {
    logCacheHit(options, 'metadata', host, entry.data ? 'hit' : 'negative', key)
    return Promise.resolve(entry.data)
  }

  let promise = inFlight.get(key)
  if (!promise) {
    promise = fetchReusableWorkflowMetadataFile(uses, host, options)
    inFlight.set(key, promise)
    void promise.then(
      () => inFlight.delete(key),
      () => inFlight.delete(key),
    )
  }
  return promise
}

async function fetchReusableWorkflowMetadataFile(
  uses: ReusableWorkflowReference,
  host: string,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  const key = `metadata:v1:${host}:${uses.owner}/${uses.repo}:${uses.workflowPath}@${uses.ref}`
  const url = `${apiBaseUrl(host)}/repos/${encode(uses.owner)}/${encode(uses.repo)}/contents/${encodePath(uses.workflowPath)}?ref=${encode(uses.ref)}`
  const result = await fetchRawGitHubContent(url, host, options)
  if (!result.ok) {
    remoteCache.set(key, undefined, result.cacheMs)
    return undefined
  }
  const inspection = await inspectReusableWorkflow(uses, host, options)
  const metadata = parseReusableWorkflowMetadata(result.text, {
    kind: 'remote',
    host,
    owner: uses.owner,
    repo: uses.repo,
    path: uses.workflowPath,
    ref: uses.ref,
    url: blobUrl(host, uses.owner, uses.repo, uses.ref, uses.workflowPath),
    action: inspection.action,
  })
  remoteCache.set(key, metadata, metadataTtlForInspection(uses.ref, inspection))
  return metadata
}

async function resolveRemoteMetadataOnHost(
  uses: RemoteActionReference,
  host: string,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  const actionPath = uses.path ? `${uses.path}/` : ''
  const files = [`${actionPath}action.yml`, `${actionPath}action.yaml`]
  const keys = files.map((file) => `metadata:v1:${host}:${uses.owner}/${uses.repo}:${file}@${uses.ref}`)

  // Return immediately on a positive cache hit -- skips all API calls.
  for (const key of keys) {
    const entry = remoteCache.getEntry(key)
    if (entry?.data) {
      logCacheHit(options, 'metadata', host, 'hit', key)
      return entry.data
    }
  }

  for (const [i, file] of files.entries()) {
    const key = keys[i]
    const entry = remoteCache.getEntry(key)
    if (entry) {
      logCacheHit(options, 'metadata', host, entry.data ? 'hit' : 'negative', key)
      if (entry.data) return entry.data
      continue // negatively cached; try the next candidate
    }

    let promise = inFlight.get(key)
    if (!promise) {
      promise = fetchRemoteMetadataFile(uses, host, file, options)
      inFlight.set(key, promise)
      void promise.then(
        () => inFlight.delete(key),
        () => inFlight.delete(key),
      )
    }
    const metadata = await promise
    if (metadata) return metadata
  }

  // The pinned ref was not found on this host. For a SHA pin that may just mean the commit no longer exists while the
  // repo is fine, so fall back to metadata from the latest version (title/description/link only).
  return resolveLatestFallback(uses, host, options)
}

// Builds a degraded hover for a SHA pin whose commit does not exist: title, description, and link come from the latest
// version (tag, or default branch HEAD when untagged), inputs/outputs are omitted rather than guessed from a different
// version, and the hover marks the pinned SHA as not found. Returns undefined for non-SHA refs or repos with no
// resolvable latest (e.g. the repo itself is absent on this host).
async function resolveLatestFallback(
  uses: RemoteActionReference,
  host: string,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  if (!SHA_RE.test(uses.ref)) return undefined

  const cacheKey = `fallback:v1:${host}:${uses.owner}/${uses.repo}:${uses.path}@${uses.ref}`
  const cached = remoteCache.getEntry(cacheKey)
  if (cached) {
    logCacheHit(options, 'metadata', host, cached.data ? 'hit' : 'negative', cacheKey)
    return cached.data
  }

  const inspection = await inspectRemoteAction(uses, host, options)
  const latest = inspection.action?.latest
  if (!inspection.action || !latest) {
    remoteCache.set(cacheKey, undefined, inspection.complete ? NOT_FOUND_TTL : TRANSIENT_FAILURE_TTL)
    return undefined
  }

  const actionPath = uses.path ? `${uses.path}/` : ''
  for (const file of [`${actionPath}action.yml`, `${actionPath}action.yaml`]) {
    const url = `${apiBaseUrl(host)}/repos/${encode(uses.owner)}/${encode(uses.repo)}/contents/${encodePath(file)}?ref=${encode(latest.name)}`
    const result = await fetchRawGitHubContent(url, host, options)
    if (!result.ok) continue

    const parsed = parseActionMetadata(result.text, {
      kind: 'remote',
      host,
      owner: uses.owner,
      repo: uses.repo,
      path: file,
      ref: uses.ref,
      url: blobUrl(host, uses.owner, uses.repo, latest.name, file),
      action: { ...inspection.action, currentUnresolved: true },
    })
    // Keep title/description/link from latest, but drop inputs/outputs -- they belong to a different version.
    const metadata: ActionMetadata = { ...parsed, inputs: [], outputs: [] }
    remoteCache.set(cacheKey, metadata, metadataTtlForInspection(uses.ref, inspection))
    return metadata
  }

  remoteCache.set(cacheKey, undefined, NOT_FOUND_TTL)
  return undefined
}

// -- GitHub API helpers -----------------------------------------------------------------------------------------------

type RawFileResult = { ok: true; text: string } | { ok: false; cacheMs: number }

async function fetchRawGitHubContent(
  url: string,
  host: string,
  options: RemoteResolverOptions,
): Promise<RawFileResult> {
  const token = await options.tokenForHost(host)
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'withcraft-vscode',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const res = await fetchWithTimeout(url, { headers }, effectiveRequestTimeoutMs(options.requestTimeoutMs))
    if (!res.ok) {
      if (res.status === 404) return { ok: false, cacheMs: NOT_FOUND_TTL }
      if (res.status === 403 || res.status === 429) return { ok: false, cacheMs: retryTtlFromHeaders(res.headers) }
      return { ok: false, cacheMs: TRANSIENT_FAILURE_TTL }
    }
    const text = await readBoundedBody(res)
    if (text === undefined) return { ok: false, cacheMs: OVERSIZED_TTL }
    return { ok: true, text }
  } catch {
    return { ok: false, cacheMs: TRANSIENT_FAILURE_TTL }
  }
}

async function fetchRemoteMetadataFile(
  uses: RemoteActionReference,
  host: string,
  path: string,
  options: RemoteResolverOptions,
): Promise<ActionMetadata | undefined> {
  const key = `metadata:v1:${host}:${uses.owner}/${uses.repo}:${path}@${uses.ref}`
  const url = `${apiBaseUrl(host)}/repos/${encode(uses.owner)}/${encode(uses.repo)}/contents/${encodePath(path)}?ref=${encode(uses.ref)}`
  const result = await fetchRawGitHubContent(url, host, options)
  if (!result.ok) {
    remoteCache.set(key, undefined, result.cacheMs)
    return undefined
  }
  // Only inspect tags/version once the file is confirmed present on this host, so a host that lacks the repo (e.g. a
  // GHE instance where the action does not exist) does not incur tag/branch/repo lookups on every resolution.
  const inspection = await inspectRemoteAction(uses, host, options)
  const metadata = parseActionMetadata(result.text, {
    kind: 'remote',
    host,
    owner: uses.owner,
    repo: uses.repo,
    path,
    ref: uses.ref,
    url: blobUrl(host, uses.owner, uses.repo, uses.ref, path),
    action: inspection.action,
  })
  remoteCache.set(key, metadata, metadataTtlForInspection(uses.ref, inspection))
  return metadata
}

function inspectRemoteAction(
  uses: RemoteActionReference,
  host: string,
  options: RemoteResolverOptions,
): Promise<RemoteActionInspection> {
  return inspectVersionedRemoteRef(
    {
      owner: uses.owner,
      repo: uses.repo,
      ref: uses.ref,
      pinInfo: uses.pinInfo,
      fullName: uses.path ? `${uses.owner}/${uses.repo}/${uses.path}` : `${uses.owner}/${uses.repo}`,
    },
    host,
    options,
  )
}

function inspectReusableWorkflow(
  uses: ReusableWorkflowReference,
  host: string,
  options: RemoteResolverOptions,
): Promise<RemoteActionInspection> {
  return inspectVersionedRemoteRef(
    {
      owner: uses.owner,
      repo: uses.repo,
      ref: uses.ref,
      pinInfo: uses.pinInfo,
      fullName: `${uses.owner}/${uses.repo}/${uses.workflowPath}`,
    },
    host,
    options,
  )
}

async function inspectVersionedRemoteRef(
  refData: VersionedRemoteRef,
  host: string,
  options: RemoteResolverOptions,
): Promise<RemoteActionInspection> {
  const maybeTags = await getTags(refData.owner, refData.repo, host, options)
  const complete = maybeTags !== undefined
  const tags = maybeTags ?? []
  const resolved = await resolveSha(refData, tags, complete, host, options)
  if (!resolved) return { action: undefined, complete: false }
  const tag = selectVersion(tags, resolved.sha)
  // Resolved semver tag for diagnostics logging only (undefined for a bare SHA with no matching tag). Distinct from
  // pinInfo, which is the hover label and may instead echo a verified pin comment or 'sha pin'.
  const version = tag ?? (SHA_RE.test(refData.ref) ? undefined : refData.ref)
  const pinInfo = await resolvePinInfo(refData, tags, complete, resolved, tag, host, options)
  // For a bare SHA pin of a repo with no semver tag there is no release to call "latest", so fall back to the default
  // branch HEAD (labelled with the branch name). Gated on `complete` so a transient tags-API failure is not mistaken
  // for a tagless repo.
  const latest =
    buildLatest(refData, tags, resolved.sha, host) ??
    (complete && resolved.refKind === 'sha'
      ? await resolveDefaultBranchLatest(refData, resolved.sha, host, options)
      : undefined)

  return {
    action: {
      fullName: refData.fullName,
      repoUrl: repoUrl(host, refData.owner, refData.repo),
      pinInfo: pinInfo.label,
      pinInfoUrl: pinInfo.url,
      resolvedSha: resolved.sha,
      commitUrl: resolved.commitUrl,
      version,
      latest,
    },
    complete,
  }
}

function getTags(
  owner: string,
  repo: string,
  host: string,
  options: RemoteResolverOptions,
): Promise<TagRef[] | undefined> {
  return cachedApi(
    `tags:${host}:${owner}/${repo}`,
    tagsCache,
    TAGS_TTL,
    () => fetchAllTags(owner, repo, host, options),
    options,
  )
}

// The tags endpoint is paginated at TAGS_PER_PAGE entries. A repo with more tags than one page would otherwise hide the
// latest release and misclassify tag refs as branches, so follow pages until a short (final) page arrives.
// MAX_TAG_PAGES bounds the request count for repos with thousands of tags.
async function fetchAllTags(
  owner: string,
  repo: string,
  host: string,
  options: RemoteResolverOptions,
): Promise<TagRef[]> {
  const tags: TagRef[] = []
  for (let page = 1; page <= MAX_TAG_PAGES; page++) {
    const query = page === 1 ? `?per_page=${TAGS_PER_PAGE}` : `?per_page=${TAGS_PER_PAGE}&page=${page}`
    const data = await github<TagResponse[]>(`/repos/${encode(owner)}/${encode(repo)}/tags${query}`, host, options)
    for (const tag of data) tags.push({ name: tag.name, sha: tag.commit.sha })
    if (data.length < TAGS_PER_PAGE) break
  }
  return tags
}

// Derives the human-readable label shown after the resolved SHA. Precedence:
//   - SHA pin: a verified inline comment (resolves to the same SHA) wins, else the most specific tag at the SHA,
//     else 'sha pin'.
//   - tag/branch/ref: the most specific tag at the SHA wins (so `@v6` or `@main` is upgraded to the concrete release
//     behind it), else the literal ref the user pinned.
async function resolvePinInfo(
  refData: VersionedRemoteRef,
  tags: TagRef[],
  tagsComplete: boolean,
  resolved: ResolvedRef,
  tag: string | undefined,
  host: string,
  options: RemoteResolverOptions,
): Promise<{ label: string; url: string }> {
  if (resolved.refKind === 'sha') {
    const candidate = cleanPinInfo(refData.pinInfo)
    if (candidate && candidate !== refData.ref) {
      const candidateResolved = await resolveSha(
        { owner: refData.owner, repo: refData.repo, ref: candidate },
        tags,
        tagsComplete,
        host,
        options,
      )
      if (candidateResolved?.sha === resolved.sha) return { label: candidate, url: candidateResolved.refUrl }
    }
    if (tag) return { label: tag, url: treeUrl(host, refData.owner, refData.repo, tag) }
    return { label: 'sha pin', url: resolved.refUrl }
  }

  if (tag) return { label: tag, url: treeUrl(host, refData.owner, refData.repo, tag) }
  return { label: refData.ref, url: resolved.refUrl }
}

function cleanPinInfo(pinInfo: string | undefined): string | undefined {
  const cleaned = pinInfo
    ?.trim()
    .replace(/^#+\s*/, '')
    .trim()
  if (!cleaned || !looksLikeRef(cleaned)) return undefined
  return cleaned
}

// A pin comment is only resolved against the API when it could be a git ref.
// Git ref names use a restricted character set and forbid spaces and `..` (see git-check-ref-format),
// so prose like `# bumped by renovate` cannot drive a wasteful `/commits/<text>` request against the configured host.
const REF_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._\-/]*[A-Za-z0-9])?$/
const MAX_REF_LENGTH = 128

function looksLikeRef(value: string): boolean {
  return value.length <= MAX_REF_LENGTH && !value.includes('..') && REF_RE.test(value)
}

function resolveSha(
  uses: Pick<VersionedRemoteRef, 'owner' | 'repo' | 'ref'>,
  tags: TagRef[],
  tagsComplete: boolean,
  host: string,
  options: RemoteResolverOptions,
): Promise<ResolvedRef | undefined> {
  if (SHA_RE.test(uses.ref)) {
    const url = commitUrl(host, uses.owner, uses.repo, uses.ref)
    return Promise.resolve({ sha: uses.ref, commitUrl: url, refKind: 'sha', refUrl: url })
  }
  const tag = tags.find((entry) => entry.name === uses.ref)
  if (tag)
    return Promise.resolve({
      sha: tag.sha,
      commitUrl: commitUrl(host, uses.owner, uses.repo, tag.sha),
      refKind: 'tag',
      refUrl: treeUrl(host, uses.owner, uses.repo, uses.ref),
    })
  return getBranchSha(uses.owner, uses.repo, uses.ref, tagsComplete ? 'branch' : 'ref', host, options)
}

function getBranchSha(
  owner: string,
  repo: string,
  ref: string,
  refKind: RemoteRefKind,
  host: string,
  options: RemoteResolverOptions,
): Promise<ResolvedRef | undefined> {
  return cachedApi(
    `ref:${host}:${owner}/${repo}:${ref}`,
    refCache,
    REF_TTL,
    async () => {
      const commit = await github<CommitResponse>(
        `/repos/${encode(owner)}/${encode(repo)}/commits/${encode(ref)}`,
        host,
        options,
      )
      return {
        sha: commit.sha,
        commitUrl: commitUrl(host, owner, repo, commit.sha),
        refKind,
        refUrl: treeUrl(host, owner, repo, ref),
      }
    },
    options,
  )
}

async function github<T>(path: string, host: string, options: RemoteResolverOptions): Promise<T> {
  const token = await options.tokenForHost(host)
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'withcraft-vscode',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetchWithTimeout(
    `${apiBaseUrl(host)}${path}`,
    { headers },
    effectiveRequestTimeoutMs(options.requestTimeoutMs),
  )
  if (!res.ok) throw new GitHubResponseError(res.status, retryTtlFromHeaders(res.headers))
  const text = await readBoundedBody(res)
  if (text === undefined) throw new Error('GitHub API response body exceeds the size limit')
  return JSON.parse(text) as T
}

// Reads a response body, aborting once it exceeds MAX_RESPONSE_BODY_BYTES.
// The Content-Length header is rejected up front, then the stream is consumed incrementally so a host that omits or
// understates the header still cannot force the extension to buffer an unbounded body into memory.
// Returns undefined when the limit is exceeded.
async function readBoundedBody(res: Response): Promise<string | undefined> {
  const contentLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BODY_BYTES) return undefined

  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    return text.length > MAX_RESPONSE_BODY_BYTES ? undefined : text
  }

  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel()
      return undefined
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

// Deduplicates concurrent requests for the same key and stores the result in cache.
// In-flight cleanup happens in the .finally() so it runs whether the promise resolves or rejects.
function cachedApi<T>(
  key: string,
  cache: TtlCache<T | undefined>,
  ttl: number,
  load: () => Promise<T | undefined>,
  options: RemoteResolverOptions,
): Promise<T | undefined> {
  const cached = cache.getEntry(key)
  if (cached) {
    logCacheHit(options, 'api', keyHost(key), cached.data ? 'hit' : 'negative', key)
    return Promise.resolve(cached.data)
  }

  const existing = apiInFlight.get(key) as Promise<T | undefined> | undefined
  if (existing) {
    const logger = options.logger ?? noopLogger
    logger.debug('cache.api.inflight', { id: options.requestId, key: cacheKeySummary(key) })
    return existing
  }

  const promise = load()
    .then((data) => {
      cache.set(key, data, data ? ttl : NOT_FOUND_TTL)
      return data
    })
    .catch((err) => {
      const retryTtl = err instanceof GitHubResponseError ? err.retryTtl : TRANSIENT_FAILURE_TTL
      cache.set(key, undefined, retryTtl)
      const logger = options.logger ?? noopLogger
      logger.debug('cache.api.store-negative', {
        id: options.requestId,
        key: cacheKeySummary(key),
        retryTtlMs: retryTtl,
      })
      return void 0 as T | undefined
    })
    .finally(() => apiInFlight.delete(key))

  apiInFlight.set(key, promise)
  return promise
}

// -- Tag and version selection ----------------------------------------------------------------------------------------

// When multiple tags point to the same SHA (e.g. `v1`, `v1.2`, `v1.2.3`), prefer the most specific semver tag.
// Falls back to the raw ref when no tag matches the SHA.
export function selectVersion(tags: TagRef[], sha: string): string | undefined {
  let best: { name: string; segments: number; parts: [number, number, number] } | undefined
  for (const tag of tags) {
    if (tag.sha !== sha) continue
    const version = parseVersion(tag.name)
    const candidate = {
      name: tag.name,
      segments: version?.segments ?? 0,
      parts: version?.parts ?? ([0, 0, 0] as [number, number, number]),
    }
    if (
      !best ||
      candidate.segments > best.segments ||
      (candidate.segments === best.segments && compareParts(candidate.parts, best.parts) > 0)
    ) {
      best = candidate
    }
  }
  return best?.name
}

export function selectLatest(tags: TagRef[]): TagRef | undefined {
  let best: { tag: TagRef; parts: [number, number, number] } | undefined
  for (const tag of tags) {
    const version = parseVersion(tag.name)
    if (!version) continue
    if (!best || compareParts(version.parts, best.parts) > 0) best = { tag, parts: version.parts }
  }
  return best?.tag
}

function buildLatest(
  uses: Pick<VersionedRemoteRef, 'owner' | 'repo'>,
  tags: TagRef[],
  sha: string,
  host: string,
): LatestActionVersion | undefined {
  const latest = selectLatest(tags)
  if (!latest) return undefined
  return {
    name: latest.name,
    url: treeUrl(host, uses.owner, uses.repo, latest.name),
    sha: latest.sha,
    commitUrl: commitUrl(host, uses.owner, uses.repo, latest.sha),
    isCurrent: latest.sha === sha,
  }
}

// Latest for a tagless repo: the default branch HEAD, labelled with the branch name. isCurrent is set when the pinned
// SHA already is that HEAD, so the caller/render suppresses a redundant line.
async function resolveDefaultBranchLatest(
  refData: VersionedRemoteRef,
  pinnedSha: string,
  host: string,
  options: RemoteResolverOptions,
): Promise<LatestActionVersion | undefined> {
  const branch = await getDefaultBranch(refData.owner, refData.repo, host, options)
  if (!branch) return undefined
  const head = await getBranchSha(refData.owner, refData.repo, branch, 'branch', host, options)
  if (!head) return undefined
  return {
    name: branch,
    url: head.refUrl,
    sha: head.sha,
    commitUrl: head.commitUrl,
    isCurrent: head.sha === pinnedSha,
  }
}

function getDefaultBranch(
  owner: string,
  repo: string,
  host: string,
  options: RemoteResolverOptions,
): Promise<string | undefined> {
  return cachedApi(
    `repo:${host}:${owner}/${repo}`,
    repoCache,
    REPO_TTL,
    async () => {
      const data = await github<RepoResponse>(`/repos/${encode(owner)}/${encode(repo)}`, host, options)
      return data.default_branch
    },
    options,
  )
}

function parseVersion(name: string): { parts: [number, number, number]; segments: number } | undefined {
  const match = VERSION_RE.exec(name)
  if (!match) return undefined
  return {
    parts: [Number(match[1]), match[2] ? Number(match[2]) : 0, match[3] ? Number(match[3]) : 0],
    segments: 1 + (match[2] ? 1 : 0) + (match[3] ? 1 : 0),
  }
}

function compareParts(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function ttlForRef(ref: string): number {
  if (SHA_RE.test(ref)) return SHA_TTL
  if (/^v?\d+(?:\.\d+){0,2}$/.test(ref)) return TAG_TTL
  return BRANCH_TTL
}

function metadataTtlForInspection(ref: string, inspection: RemoteActionInspection): number {
  // If tag resolution was incomplete (e.g. tags API failed), use a short TTL so we retry soon instead of serving stale
  // version info for hours.
  return inspection.complete && inspection.action ? ttlForRef(ref) : TRANSIENT_FAILURE_TTL
}

// -- Logging helpers --------------------------------------------------------------------------------------------------

function remoteSourceSummary(metadata: ActionMetadata): Record<string, unknown> | undefined {
  if (metadata.source.kind !== 'remote') return undefined
  return {
    host: metadata.source.host,
    owner: metadata.source.owner,
    repo: metadata.source.repo,
    path: metadata.source.path,
    ref: metadata.source.ref,
  }
}

function remoteActionSummary(metadata: ActionMetadata): Record<string, unknown> | undefined {
  if (metadata.source.kind !== 'remote' || !metadata.source.action) return undefined
  return {
    resolvedSha: metadata.source.action.resolvedSha,
    version: metadata.source.action.version,
    latest: metadata.source.action.latest?.name,
    isLatest: metadata.source.action.latest?.isCurrent,
  }
}

function logCacheHit(
  options: RemoteResolverOptions,
  scope: 'metadata' | 'api',
  host: string,
  status: 'hit' | 'negative',
  key: string,
) {
  const logger = options.logger ?? noopLogger
  logger.debug('cache.hit', {
    id: options.requestId,
    scope,
    host,
    status,
    key: cacheKeySummary(key),
  })
}

function cacheKeySummary(key: string): string {
  return key.length > 160 ? `${key.slice(0, 157)}...` : key
}

function keyHost(key: string): string {
  const match = /^(?:tags|ref):([^:]+):/.exec(key)
  return match?.[1] ?? 'unknown'
}

// -- HTTP -------------------------------------------------------------------------------------------------------------

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(url, init)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// -- URL builders -----------------------------------------------------------------------------------------------------

// All values that originate from untrusted workflow content (owner, repo, ref, path) are passed through encode() so
// they cannot inject characters that break out of a Markdown link target in the hover (e.g. a raw `)` closes the link).

function apiBaseUrl(host: string): string {
  return host === DEFAULT_HOST ? 'https://api.github.com' : `${webBaseUrl(host)}/api/v3`
}

function webBaseUrl(host: string): string {
  return `https://${host}`
}

function repoUrl(host: string, owner: string, repo: string): string {
  return `${webBaseUrl(host)}/${encode(owner)}/${encode(repo)}`
}

function treeUrl(host: string, owner: string, repo: string, ref: string): string {
  return `${repoUrl(host, owner, repo)}/tree/${encode(ref)}`
}

function commitUrl(host: string, owner: string, repo: string, sha: string): string {
  return `${repoUrl(host, owner, repo)}/commit/${encode(sha)}`
}

function blobUrl(host: string, owner: string, repo: string, ref: string, filePath: string): string {
  return `${repoUrl(host, owner, repo)}/blob/${encode(ref)}/${encodePath(filePath)}`
}

function encode(value: string): string {
  // encodeURIComponent leaves `!'()*` unescaped, but `)` (and `(`) break out of a Markdown link target in the hover,
  // so escape them too.
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodePath(value: string): string {
  return value
    .split('/')
    .map((part) => encode(part))
    .join('/')
}

// -- Error types ------------------------------------------------------------------------------------------------------

class GitHubResponseError extends Error {
  constructor(
    readonly status: number,
    readonly retryTtl: number,
  ) {
    super(`GitHub API request failed with ${status}`)
  }
}
