import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseActionMetadata, parseReusableWorkflowMetadata } from './metadata.js'
import type { ActionMetadata, LocalActionReference, LocalReusableWorkflowReference } from './types.js'

export interface LocalFileSystem {
  readFile(path: string): Promise<string>
  pathExists(path: string): Promise<boolean>
}

export async function resolveLocalMetadata(
  uses: LocalActionReference,
  workflowPath: string,
  workspaceRoot: string | undefined,
  fs: LocalFileSystem,
): Promise<ActionMetadata | undefined> {
  const baseDir = (await findRepoRoot(path.dirname(workflowPath), fs)) ?? workspaceRoot ?? path.dirname(workflowPath)
  const resolved = path.resolve(baseDir, uses.workspacePath)
  if (!isWithin(baseDir, resolved)) return undefined
  const candidates = metadataCandidates(resolved)

  for (const candidate of candidates) {
    let text: string
    try {
      text = await fs.readFile(candidate)
    } catch (err) {
      if (isFileNotFound(err)) continue
      throw err
    }
    return parseActionMetadata(text, {
      kind: 'local',
      path: candidate,
      uri: pathToFileURL(candidate).toString(),
    })
  }

  return undefined
}

export async function resolveLocalReusableWorkflowMetadata(
  uses: LocalReusableWorkflowReference,
  workflowPath: string,
  workspaceRoot: string | undefined,
  fs: LocalFileSystem,
): Promise<ActionMetadata | undefined> {
  const baseDir = (await findRepoRoot(path.dirname(workflowPath), fs)) ?? workspaceRoot ?? path.dirname(workflowPath)
  const resolved = path.resolve(baseDir, uses.workspacePath)
  if (!isWithin(baseDir, resolved)) return undefined

  let text: string
  try {
    text = await fs.readFile(resolved)
  } catch (err) {
    if (isFileNotFound(err)) return undefined
    throw err
  }

  return parseReusableWorkflowMetadata(text, {
    kind: 'local',
    path: resolved,
    uri: pathToFileURL(resolved).toString(),
  })
}

// `uses: ./path` is always resolved relative to the root of the repository checked out by the
// workflow run, not relative to the workflow file's directory or the VS Code workspace folder --
// the two diverge for nested repos (e.g. project/<repo>/.github/workflows/ci.yml under a workspace
// folder that is itself not a git repo).
async function findRepoRoot(startDir: string, fs: LocalFileSystem): Promise<string | undefined> {
  let dir = startDir
  for (;;) {
    if (await fs.pathExists(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// `uses: ./path` references are resolved relative to the checked-out repository
// root and -- like GitHub Actions itself -- must not escape it. `workspacePath`
// is untrusted workflow content, so reject any `../` traversal that would read
// `action.yml` files outside the repo/workspace boundary.
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function metadataCandidates(resolvedPath: string): string[] {
  if (/action\.ya?ml$/i.test(resolvedPath)) return [resolvedPath]
  return [path.join(resolvedPath, 'action.yml'), path.join(resolvedPath, 'action.yaml')]
}
