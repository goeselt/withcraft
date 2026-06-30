import { DEFAULT_HOST } from './github.js'

const ENV_TOKEN_VARS = ['WITHCRAFT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const

// Environment tokens are not bound to a specific host: `GITHUB_TOKEN` / `GH_TOKEN` are public-github.com credentials by
// convention, and `WITHCRAFT_GITHUB_TOKEN` is host-agnostic.
// Sending them to a workspace-configured host would leak the credential to an arbitrary (possibly attacker-controlled)
// endpoint, so they are only ever sent to the public github.com host.
// Per-host tokens stored in secret storage (explicit user intent) and `gh auth token --hostname <host>`
// (only returns a token for hosts the user authenticated to) remain host-scoped.
export function envTokenForHost(
  host: string,
  env: NodeJS.ProcessEnv,
  defaultHost: string = DEFAULT_HOST,
): string | undefined {
  if (host !== defaultHost) return undefined
  for (const name of ENV_TOKEN_VARS) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}
