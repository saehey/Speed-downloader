interface Tracked {
  id: string;
  status: string;
}

/**
 * Returns a function that reports which downloads have just begun. Each file counts once until it
 * finishes, so a server that makes a file wait and try again does not set it off repeatedly. Whatever
 * is already running at the first look is not new: reopening the window or the app is not a fresh start.
 */
export function startTracker(): (downloads: readonly Tracked[]) => string[] {
  let seen: Set<string> | null = null;
  return (downloads) => {
    const running = downloads.filter((d) => d.status === 'downloading').map((d) => d.id);
    if (!seen) {
      seen = new Set(running);
      return [];
    }
    const fresh = running.filter((id) => !seen!.has(id));
    for (const id of fresh) seen.add(id);
    const unfinished = new Set(downloads.filter((d) => d.status !== 'completed').map((d) => d.id));
    for (const id of seen) if (!unfinished.has(id)) seen.delete(id);
    return fresh;
  };
}
