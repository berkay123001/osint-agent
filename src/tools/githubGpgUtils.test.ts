import assert from 'node:assert/strict'
import test from 'node:test'
import { hasUsableGithubGpgKey, isGithubNoGpgPlaceholder } from './githubGpgUtils.js'

test('detects GitHub placeholder response wrapped in a fake armored block', () => {
  const content = `-----BEGIN PGP PUBLIC KEY BLOCK-----
Note: This user hasn't uploaded any GPG keys.

=twTO
-----END PGP PUBLIC KEY BLOCK-----`

  assert.equal(isGithubNoGpgPlaceholder(content), true)
  assert.equal(hasUsableGithubGpgKey(content), false)
})

test('accepts a real armored public key response', () => {
  const content = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGQfakeBEADKfakefakefakefake
=abcd
-----END PGP PUBLIC KEY BLOCK-----`

  assert.equal(isGithubNoGpgPlaceholder(content), false)
  assert.equal(hasUsableGithubGpgKey(content), true)
})