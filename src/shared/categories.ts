export type Category = 'video' | 'audio' | 'document' | 'program' | 'archive' | 'other';

/** The kinds of download that can each have their own folder. */
export type FolderKind = Category | 'torrent';
export const FOLDER_KINDS: readonly FolderKind[] = ['video', 'audio', 'document', 'program', 'archive', 'other', 'torrent'];

const GROUPS: Record<Exclude<Category, 'other'>, string[]> = {
  video: ['3gp', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'ogv', 'ts', 'vob', 'webm', 'wmv'],
  audio: ['aac', 'aif', 'aiff', 'alac', 'ape', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'wma'],
  document: ['azw3', 'csv', 'djvu', 'doc', 'docx', 'epub', 'key', 'mobi', 'odp', 'ods', 'odt', 'pages', 'pdf', 'ppt', 'pptx', 'psd', 'rtf', 'xls', 'xlsx'],
  program: ['apk', 'appimage', 'deb', 'dmg', 'exe', 'ipa', 'jar', 'msi', 'msix', 'nupkg', 'pkg', 'rpm'],
  archive: ['7z', 'bin', 'bz2', 'cab', 'gz', 'img', 'iso', 'lz', 'lz4', 'lzma', 'ova', 'qcow2', 'rar', 'tar', 'tgz', 'vhd', 'vmdk', 'wim', 'xz', 'zip', 'zst'],
};

const BY_EXTENSION = new Map<string, Category>(
  (Object.entries(GROUPS) as Array<[Category, string[]]>).flatMap(([category, list]) => list.map((ext) => [ext, category] as [string, Category])),
);

export const CAPTURED_EXTENSIONS: ReadonlySet<string> = new Set(BY_EXTENSION.keys());

export function extensionOf(name: string | null | undefined): string {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function categoryOf(name: string | null | undefined): Category {
  return BY_EXTENSION.get(extensionOf(name)) ?? 'other';
}

/** Reads a user-typed list such as ".dat, nds iso" into plain lowercase extensions. */
export function parseExtensions(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[\s,;]+/).map((part) => part.replace(/^\.+/, '')).filter((part) => /^[a-z0-9]{1,12}$/.test(part)))];
}
