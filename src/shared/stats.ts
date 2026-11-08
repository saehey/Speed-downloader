import type { ProblemKind } from './types.ts';

/**
 * What the app has done for the user, counted on this computer only. It holds numbers, never a
 * link, a file name or a site, so it can be shown and kept without exposing what was downloaded.
 */
export interface ReliabilityStats {
  /** When counting began, in milliseconds since 1970. */
  since: number;
  completed: number;
  completedBytes: number;
  /** Files that had part downloaded when the app closed or stopped, and later finished from there. */
  resumedAfterClose: number;
  /** The part those files already had, which did not have to be downloaded again. */
  bytesKept: number;
  /** Expired links replaced with a new one, keeping what was already downloaded. */
  linksReplaced: number;
  problems: Partial<Record<ProblemKind, number>>;
  /** Finished files Microsoft Defender checked, and how many of them it flagged. */
  scanned: number;
  threats: number;
}

export function emptyStats(now: number): ReliabilityStats {
  return { since: now, completed: 0, completedBytes: 0, resumedAfterClose: 0, bytesKept: 0, linksReplaced: 0, problems: {}, scanned: 0, threats: 0 };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** Reads saved numbers, starting again from zero for anything that does not look right. */
export function parseStats(value: unknown, now: number): ReliabilityStats {
  if (typeof value !== 'object' || value === null) return emptyStats(now);
  const v = value as Record<string, unknown>;
  const problems: Partial<Record<ProblemKind, number>> = {};
  if (typeof v.problems === 'object' && v.problems !== null) {
    for (const [kind, n] of Object.entries(v.problems as Record<string, unknown>)) {
      if (/^[a-z-]{1,40}$/.test(kind) && count(n) > 0) problems[kind as ProblemKind] = count(n);
    }
  }
  const since = count(v.since);
  return {
    since: since > 0 && since <= now ? since : now,
    completed: count(v.completed),
    completedBytes: count(v.completedBytes),
    resumedAfterClose: count(v.resumedAfterClose),
    bytesKept: count(v.bytesKept),
    linksReplaced: count(v.linksReplaced),
    problems,
    scanned: count(v.scanned),
    threats: count(v.threats),
  };
}
