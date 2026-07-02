export interface OffsetRange {
  start: number
  end: number
}

export interface WorkflowActionStep {
  uses: UsesReference
  id: string | undefined
  stepRange: OffsetRange
  scopeRange: OffsetRange
  usesRange: OffsetRange
  withRange: OffsetRange | undefined
  withInputs: Map<string, OffsetRange>
}

export type UsesReference =
  | RemoteActionReference
  | LocalActionReference
  | LocalReusableWorkflowReference
  | DockerImageReference
  | ReusableWorkflowReference

export interface RemoteActionReference {
  kind: 'remote-action'
  owner: string
  repo: string
  path: string
  ref: string
  pinInfo?: string | undefined
  raw: string
}

export interface LocalActionReference {
  kind: 'local-action'
  workspacePath: string
  raw: string
}

export interface LocalReusableWorkflowReference {
  kind: 'local-reusable-workflow'
  workspacePath: string
  raw: string
}

export interface DockerImageReference {
  kind: 'docker-image'
  image: string
  raw: string
}

export interface ReusableWorkflowReference {
  kind: 'reusable-workflow'
  owner: string
  repo: string
  workflowPath: string
  ref: string
  pinInfo?: string | undefined
  raw: string
}

export interface ActionMetadata {
  name: string | undefined
  description: string | undefined
  inputs: ActionInput[]
  outputs: ActionOutput[]
  source: RemoteMetadataSource | LocalMetadataSource
}

export interface RemoteMetadataSource {
  kind: 'remote'
  host: string
  owner: string
  repo: string
  path: string
  ref: string
  url: string
  action: RemoteActionInfo | undefined
}

export interface LocalMetadataSource {
  kind: 'local'
  path: string
  uri: string
}

export interface RemoteActionInfo {
  fullName: string
  repoUrl: string
  // Human-readable identity of the resolved SHA shown after the `#`: the most specific tag pointing at it, the literal
  // ref the user pinned, a verified inline pin comment, or 'sha pin' when nothing maps. Always populated, with a link
  // target in pinInfoUrl; see resolvePinInfo.
  pinInfo: string
  pinInfoUrl: string
  resolvedSha: string
  commitUrl: string
  // Resolved semver tag, used for diagnostics logging only (the hover uses pinInfo). Undefined for a bare SHA.
  version: string | undefined
  latest: LatestActionVersion | undefined
  // Set when the pinned SHA itself could not be fetched (does not exist) and this metadata was resolved from `latest`
  // as a fallback. The hover then labels current as not found, shows latest, and omits inputs/outputs (which would
  // otherwise be guessed from a different version). resolvedSha holds the unresolved pinned SHA.
  currentUnresolved?: boolean
}

// How a `uses:` ref was resolved. Internal to remote resolution; not exposed on RemoteActionInfo because no consumer
// of the metadata needs it yet.
export type RemoteRefKind = 'sha' | 'tag' | 'branch' | 'ref'

export interface LatestActionVersion {
  name: string
  url: string
  sha: string
  commitUrl: string
  isCurrent: boolean
}

export interface ActionInput {
  name: string
  description: string
  required: boolean
  default: string | undefined
  deprecationMessage: string | undefined
}

export interface ActionOutput {
  name: string
  description: string
}
