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
  resolvedSha: string
  commitUrl: string
  version: string | undefined
  versionUrl: string | undefined
  latest: LatestActionVersion | undefined
}

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
