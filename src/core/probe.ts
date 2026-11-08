import type { Validator } from '../shared/types.ts';
import { filenameFromDisposition } from './names.ts';

export interface ProbeRequest {
  url: string;
  cookie?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
  timeoutMs?: number;
}

export interface ProbeResult {
  status: number;
  finalUrl: string;
  acceptsRanges: boolean;
  validator: Validator;
  filename: string | null;
  contentType: string | null;
  retryAfterSeconds: number | null;
}

const MAX_REDIRECTS = 10;

/**
 * Reads a file's identity with a one-byte request. Redirects are followed by hand so the
 * cookie is dropped when the origin changes.
 */
export async function probe(req: ProbeRequest): Promise<ProbeResult> {
  let current = new URL(req.url);
  const originalOrigin = current.origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' };
    if (req.userAgent) headers['User-Agent'] = req.userAgent;
    if (req.referrer) headers.Referer = req.referrer;
    if (req.cookie && current.origin === originalOrigin) headers.Cookie = req.cookie;

    const res = await fetch(current, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs ?? 20000),
    });
    await res.body?.cancel().catch(() => {});

    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      current = new URL(res.headers.get('location') as string, current);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error(`Redirect to unsupported scheme ${current.protocol}`);
      }
      continue;
    }

    return {
      status: res.status,
      finalUrl: current.href,
      acceptsRanges: res.status === 206,
      validator: {
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        size: sizeFrom(res.status, res.headers),
      },
      filename: filenameFromDisposition(res.headers.get('content-disposition')),
      contentType: res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null,
      retryAfterSeconds: /^\d+$/.test(res.headers.get('retry-after') ?? '') ? Number(res.headers.get('retry-after')) : null,
    };
  }
  throw new Error('Too many redirects');
}

function sizeFrom(status: number, headers: Headers): number | null {
  if (status === 206) {
    const total = /\/(\d+)\s*$/.exec(headers.get('content-range') ?? '');
    return total?.[1] ? Number(total[1]) : null;
  }
  const length = headers.get('content-length');
  return status === 200 && length ? Number(length) : null;
}

export type Comparison = 'same' | 'changed' | 'unknown';

/**
 * Decides whether a partial file still matches the server. Only a strong ETag or an equal
 * Last-Modified counts as proof; a different size or validator counts as changed.
 */
export function compareValidators(saved: Validator | null, now: Validator): Comparison {
  if (!saved) return 'unknown';
  if (saved.size !== null && now.size !== null && saved.size !== now.size) return 'changed';
  if (saved.etag && now.etag && saved.etag !== now.etag) return 'changed';
  if (saved.lastModified && now.lastModified && saved.lastModified !== now.lastModified) return 'changed';
  if (saved.etag && now.etag && !saved.etag.startsWith('W/')) return 'same';
  if (saved.lastModified && now.lastModified) return 'same';
  return 'unknown';
}
