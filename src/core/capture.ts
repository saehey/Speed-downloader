import { CAPTURED_EXTENSIONS, extensionOf } from '../shared/categories.ts';
import { filenameFromUrl } from './names.ts';
import type { ProbeRequest, ProbeResult } from './probe.ts';

export interface BrowserDownload {
  id: number;
  url: string;
  finalUrl?: string | null;
  filename?: string | null;
  referrer?: string | null;
  mime?: string | null;
  totalBytes?: number | null;
  userAgent?: string | null;
  cookie?: string | null;
}

export interface CaptureDecision {
  accept: boolean;
  reason: string;
  /** The address to download from, when accepted. */
  url?: string;
}

const MIN_BYTES = 256 * 1024;
// These names stay in the browser even when the server or browser reports a binary type.
const BROWSER_EXTENSIONS = new Set([
  'asp', 'aspx', 'avif', 'css', 'gif', 'htm', 'html', 'ico', 'ics', 'jpeg', 'jpg', 'js', 'json', 'jsp', 'log', 'md', 'mjs', 'php', 'png', 'svg', 'torrent', 'txt', 'vcf', 'webp', 'xml',
]);
const BINARY_MIME = /^(application\/(octet-stream|zip|x-zip-compressed|x-msdownload|x-msi|x-7z-compressed|x-rar-compressed|vnd\.rar|gzip|x-tar|x-iso9660-image|pdf)|video\/.+|audio\/.+)$/;

/** Decides from Chrome's own information, before contacting the server again. */
export function matchesCaptureRules(download: BrowserDownload, extra: readonly string[] = []): { match: boolean; reason: string } {
  const target = download.finalUrl || download.url;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { match: false, reason: 'invalid-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { match: false, reason: 'unsupported-scheme' };
  // Chrome reports 0 or -1 when it does not know the size yet, so only a positive value counts.
  const size = download.totalBytes ?? -1;
  if (size > 0 && size < MIN_BYTES) return { match: false, reason: 'too-small' };
  const name = download.filename || filenameFromUrl(target);
  const extension = extensionOf(name);
  if (extra.includes(extension)) return { match: true, reason: 'extra-extension' };
  if (BROWSER_EXTENSIONS.has(extension)) return { match: false, reason: 'browser-file-type' };
  if (CAPTURED_EXTENSIONS.has(extension)) return { match: true, reason: 'extension' };
  if (BINARY_MIME.test((download.mime ?? '').toLowerCase())) return { match: true, reason: 'mime' };
  return { match: false, reason: 'not-a-captured-type' };
}

/**
 * Checks that this app can really fetch what the browser is fetching. A single-use link or a
 * POST download fails this check, and the browser then simply carries on with its own request.
 */
export async function decideCapture(
  download: BrowserDownload,
  enabled: boolean,
  probeFn: (request: ProbeRequest) => Promise<ProbeResult>,
  extra: readonly string[] = [],
): Promise<CaptureDecision> {
  if (!enabled) return { accept: false, reason: 'capture-off' };
  const rules = matchesCaptureRules(download, extra);
  if (!rules.match) return { accept: false, reason: rules.reason };
  const target = download.finalUrl || download.url;
  let found: ProbeResult;
  try {
    found = await probeFn({ url: target, cookie: download.cookie, referrer: download.referrer, userAgent: download.userAgent, timeoutMs: 8000 });
  } catch {
    return { accept: false, reason: 'probe-failed' };
  }
  if (found.status !== 200 && found.status !== 206) return { accept: false, reason: `probe-status-${found.status}` };
  const size = download.totalBytes ?? -1;
  if (size > 0 && found.validator.size !== null && found.validator.size !== size) return { accept: false, reason: 'size-differs' };
  if (found.validator.size !== null && found.validator.size < MIN_BYTES) return { accept: false, reason: 'too-small' };
  const mime = (download.mime ?? '').toLowerCase();
  if (found.contentType === 'text/html' && mime !== 'text/html') return { accept: false, reason: 'got-html-instead' };
  return { accept: true, reason: 'ok', url: found.finalUrl };
}
