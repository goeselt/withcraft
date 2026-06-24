import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  capabilities?: { untrustedWorkspaces?: { supported?: string; restrictedConfigurations?: string[] } }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('package.json security configuration', () => {
  it('restricts the host setting in untrusted workspaces', () => {
    const untrusted = manifest.capabilities?.untrustedWorkspaces
    expect(untrusted?.supported).toBe('limited')
    // githubHosts decides where token-bearing requests go, so a repository must
    // not be able to override it via .vscode/settings.json in an untrusted workspace.
    expect(untrusted?.restrictedConfigurations).toContain('withcraft.githubHosts')
  })

  it('pins every dependency to an exact version', () => {
    const ranges = /^[\^~*]|x|\s|\|\|/
    for (const deps of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, version] of Object.entries(deps ?? {})) {
        expect(ranges.test(version), `${name} must be pinned, got "${version}"`).toBe(false)
      }
    }
  })
})
