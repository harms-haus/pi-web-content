/** Timeout for fetch requests (30 seconds) */
export const FETCH_TIMEOUT_MS = 30_000;

/** Timeout for git clone operations (2 minutes for large repos) */
export const GIT_CLONE_TIMEOUT_MS = 120_000;

/** Maximum allowed response size (10 MB) */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Maximum number of redirects to follow */
export const MAX_REDIRECTS = 10;

/** User-Agent header for fetch requests */
export const USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Accept header for fetch requests */
export const ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8";

/** Accept-Language header for fetch requests */
export const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** MIME type prefixes/subtypes that indicate binary content (non-textual). */
export const BINARY_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "application/zip",
  "application/octet-stream",
  "application/x-gzip",
  "application/x-tar",
];
