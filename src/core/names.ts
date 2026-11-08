const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_LENGTH = 200;

/** Turns a server or URL supplied name into one safe file name inside the target folder. */
export function sanitizeFilename(input: string | null | undefined): string {
  const base = (input ?? '').split(/[\\/]/).pop() ?? '';
  let name = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '');
  if (!name) name = 'download';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > MAX_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_LENGTH - ext.length) + ext;
  }
  return name;
}

export function filenameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    return sanitizeFilename(safeDecode(last));
  } catch {
    return 'download';
  }
}

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1]) return sanitizeFilename(safeDecode(extended[1].trim()));
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const value = plain?.[1] ?? plain?.[2];
  return value ? sanitizeFilename(safeDecode(value.trim())) : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Returns `name`, or `name (n).ext`, whichever `taken` reports as free. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 10000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('No free file name');
}

/** True when a value can be sent as one HTTP header value. */
export function isSafeHeaderValue(value: string): boolean {
  return !/[\r\n\u0000]/.test(value);
}
