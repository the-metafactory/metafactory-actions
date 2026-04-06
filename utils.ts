/** Extract base domain from URL (e.g. "sub.example.com" → "example.com") */
export function baseDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return url;
  }
}

/** Escape a string for safe use as a shell argument (single-quote wrapping) */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
