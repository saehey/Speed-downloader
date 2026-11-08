/**
 * What the app knows about each browser's extension. It learns this only from connections the
 * extension makes anyway, for a download or a video, because the native host starts the app when
 * the extension connects, and a regular check would reopen an app the user had quit.
 */

export type BrowserName = 'Chrome' | 'Edge';

export interface BrowserLink {
  browser: BrowserName;
  /** When the extension last connected, in milliseconds since 1970. */
  lastSeen: number;
  /** null for extensions older than 1.5.0, which do not say their version. */
  version: string | null;
}

export interface ExtensionStatus {
  /** false when the browser connection could not be registered. null when unknown, as in development. */
  registered: boolean | null;
  /** The version of the extension that ships with this app. */
  shippedVersion: string;
  links: BrowserLink[];
}

export type LinkState = 'current' | 'outdated';

const VERSION = /^\d{1,4}(\.\d{1,5}){0,3}$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}

/** Edge says "Edg/" in its user agent. Every other Chromium browser is treated as Chrome. */
export function browserOf(userAgent: unknown): BrowserName {
  return typeof userAgent === 'string' && /\bEdg\//.test(userAgent) ? 'Edge' : 'Chrome';
}

export function linkState(link: BrowserLink, shippedVersion: string): LinkState {
  return link.version === shippedVersion ? 'current' : 'outdated';
}

/** Returns the list with this browser's entry replaced. A later connection never loses a known version. */
export function recordLink(links: BrowserLink[], browser: BrowserName, version: string | null, now: number): BrowserLink[] {
  const others = links.filter((link) => link.browser !== browser);
  return [...others, { browser, lastSeen: now, version }].sort((a, b) => a.browser.localeCompare(b.browser));
}

/** Reads a saved list, dropping anything that does not look right. */
export function parseLinks(value: unknown): BrowserLink[] {
  if (!Array.isArray(value)) return [];
  const links: BrowserLink[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { browser, lastSeen, version } = item as Record<string, unknown>;
    if ((browser !== 'Chrome' && browser !== 'Edge') || typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) continue;
    if (links.some((link) => link.browser === browser)) continue;
    links.push({ browser, lastSeen, version: isVersion(version) ? version : null });
  }
  return links;
}
