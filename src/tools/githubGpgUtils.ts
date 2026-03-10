export function isGithubNoGpgPlaceholder(content: string): boolean {
  const normalized = content.toLowerCase()
  return normalized.includes("this user hasn't uploaded any gpg keys") ||
    normalized.includes('this user has not uploaded any gpg keys') ||
    normalized.includes("this user hasn’t uploaded any gpg keys")
}

export function hasUsableGithubGpgKey(content: string): boolean {
  return content.includes('BEGIN PGP PUBLIC KEY BLOCK') && !isGithubNoGpgPlaceholder(content)
}