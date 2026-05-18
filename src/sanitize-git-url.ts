/**
 * Sanitize and validate a git URL against command injection.
 * Strips embedded credentials and rejects dangerous patterns.
 */
export function sanitizeGitUrl(url: string): string {
  // 1. Reject empty or excessively long URLs
  if (!url || url.length > 2048) {
    throw new Error("Invalid repository URL: empty or exceeds maximum length.");
  }

  // 2. Reject whitespace (spaces, tabs, newlines, etc.)
  if (/\s/.test(url)) {
    throw new Error("Invalid repository URL: must not contain whitespace.");
  }

  // 3. Reject git argument injection patterns
  //    ext:: is a git remote helper protocol specifier
  if (/ext::/i.test(url)) {
    throw new Error("Invalid repository URL: ext:: protocol is not allowed.");
  }

  // 4. Reject shell metacharacters that could be dangerous
  //    even in non-shell exec contexts (defense in depth)
  const shellMetaChars = /[;|`$(){}!\\'"]/.test(url);
  if (shellMetaChars) {
    throw new Error("Invalid repository URL: contains shell metacharacters.");
  }

  // 4b. Reject control characters (0x00-0x1f) beyond what \s catches
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code >= 0x00 && code <= 0x1f) {
      throw new Error("Invalid repository URL: contains control characters.");
    }
  }

  // 5. Strict character allowlist:
  //    alphanumeric, -, _, ., /, :, @, #, ?, =, &
  const allowedChars = /^[a-zA-Z0-9\-_./:@#?=&]+$/;
  if (!allowedChars.test(url)) {
    throw new Error("Invalid repository URL: contains disallowed characters.");
  }

  // 6. Strip embedded credentials using URL API (unified approach with detect-repo-url)
  //    https://user:pass@github.com/org/repo → https://github.com/org/repo
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // Not a URL-parseable string (e.g., SSH URL); fall through
  }

  return url;
}
