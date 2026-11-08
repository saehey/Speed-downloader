import fs from 'node:fs';
import path from 'node:path';
import type { Download, Settings } from '../shared/types.ts';

/** Encrypts cookies at rest. When unavailable, cookies are kept in memory only. */
export interface SecretStore {
  available: boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export const memoryOnlySecrets: SecretStore = {
  available: false,
  encrypt: () => { throw new Error('Secret storage is not available'); },
  decrypt: () => { throw new Error('Secret storage is not available'); },
};

export interface StoredState {
  version: 1;
  settings: Partial<Settings>;
  downloads: Download[];
  cookies: Record<string, string>;
}

export class JsonStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'downloads.json');
  }

  load(): StoredState {
    const empty: StoredState = { version: 1, settings: {}, downloads: [], cookies: {} };
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(text) as StoredState;
      return { ...empty, ...parsed };
    } catch {
      // Keep the unreadable file so it can be inspected rather than overwriting it.
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return empty;
    }
  }

  /** Writes to a temporary file first so a crash cannot leave half a queue. */
  save(state: StoredState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
