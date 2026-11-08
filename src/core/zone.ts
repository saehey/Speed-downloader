import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows remembers that a file came from the internet in a hidden "Zone.Identifier" stream beside it,
 * the "Mark of the Web". SmartScreen and Office Protected View check files that carry it. Browsers add
 * it to what they download, but aria2 and yt-dlp do not, so without this a file taken over from the
 * browser would lose those checks.
 */

const INTERNET_ZONE = 3;
/** A torrent can hold many files. Past this, the rest stay unmarked rather than stall the queue. */
const MAX_TREE_FILES = 20_000;

/**
 * Keeps only where a file came from. The query and fragment often hold sign-in tokens, and the
 * user name and password should never be written to disk, so all three are dropped.
 */
export function addressForZone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

export function zoneText(source?: string | null, referrer?: string | null): string {
  const lines = ['[ZoneTransfer]', `ZoneId=${INTERNET_ZONE}`];
  const referrerUrl = addressForZone(referrer);
  const hostUrl = addressForZone(source);
  if (referrerUrl) lines.push(`ReferrerUrl=${referrerUrl}`);
  if (hostUrl) lines.push(`HostUrl=${hostUrl}`);
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Marks one file. Returns false where the disk cannot hold the mark, such as FAT32, exFAT and some
 * network shares; the download itself is still fine there.
 */
export function markFile(file: string, text: string): boolean {
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, text);
    return true;
  } catch {
    return false;
  }
}

/** Marks a file, or every file inside a folder, which is what a finished torrent can be. */
export function markFromInternet(target: string, source?: string | null, referrer?: string | null): number {
  const text = zoneText(source, referrer);
  let marked = 0;
  let seen = 0;
  const walk = (entry: string): void => {
    if (seen >= MAX_TREE_FILES) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      return;
    }
    // Links could point anywhere on the disk, so they are left alone.
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      seen += 1;
      if (markFile(entry, text)) marked += 1;
      return;
    }
    if (!stat.isDirectory()) return;
    let names: string[];
    try {
      names = fs.readdirSync(entry);
    } catch {
      return;
    }
    for (const name of names) walk(path.join(entry, name));
  };
  walk(target);
  return marked;
}

/**
 * Windows lets an administrator turn this off with the "Do not preserve zone information in file
 * attachments" policy, stored as SaveZoneInformation = 1. Takes the text of `reg query` for each hive.
 */
export function policyKeepsZone(regOutputs: string[]): boolean {
  return !regOutputs.some((output) => /SaveZoneInformation\s+REG_DWORD\s+0x0*1\b/i.test(output));
}
