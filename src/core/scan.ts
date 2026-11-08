import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Asks Microsoft Defender to check a finished file. Defender's real-time protection usually checks
 * files as they are written, so this mostly lets the user see that the check happened, and covers a
 * computer where real-time protection is off. A threat is reported, not removed: the user decides.
 */

export type ScanVerdict =
  | { result: 'clean' }
  | { result: 'threat'; name: string | null }
  /** Defender is missing, turned off, replaced by another antivirus, or the file is gone. */
  | { result: 'unavailable' };

export interface Scanner {
  scan(target: string): Promise<ScanVerdict>;
}

/** A big file can take a while, but a scan that never ends must not hold the queue forever. */
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

/**
 * MpCmdRun exits with 2 both for a threat and for a failure, such as a missing file, so the text decides.
 * Its messages are in English whatever the Windows language.
 */
export function parseDefenderOutput(output: string): ScanVerdict {
  if (/found no threats/i.test(output)) return { result: 'clean' };
  const count = /found (\d+) threats?/i.exec(output);
  if (count && Number(count[1]) > 0) {
    const name = /^\s*Threat\s*:\s*(.+?)\s*$/im.exec(output)?.[1] ?? null;
    return { result: 'threat', name: name && name.length <= 200 ? name : null };
  }
  return { result: 'unavailable' };
}

export function findDefender(): string | null {
  const exe = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
  return fs.existsSync(exe) ? exe : null;
}

export function defenderScanner(exe: string): Scanner {
  return {
    scan: (target) => new Promise((resolve) => {
      // -DisableRemediation reports without quarantining, so a false alarm never deletes a file.
      const child = spawn(exe, ['-Scan', '-ScanType', '3', '-File', target, '-DisableRemediation'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // A scan at normal priority is still correct, only less polite.
      }
      let output = '';
      const collect = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString('utf8'); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT_MS);
      child.once('error', () => { clearTimeout(timer); resolve({ result: 'unavailable' }); });
      child.once('close', () => { clearTimeout(timer); resolve(parseDefenderOutput(output)); });
    }),
  };
}
