/** The app's mark, a dotted arrow into a tray. The window, tray and app icon all draw from this. */
export const MARK = [
  '...#...',
  '...#...',
  '.#.#.#.',
  '..###..',
  '...#...',
  '.......',
  '.#####.',
];

/**
 * Draws the mark as RGBA-independent coverage: for each pixel, how much of it the dots cover, from
 * 0 to 1. Each dot is sampled at several points so it stays round at small sizes.
 */
export function markCoverage(size: number, padding = 0): number[] {
  const cell = (size - padding * 2) / MARK.length;
  // A dot only two or three pixels wide fades out unless it fills its cell.
  const radius = cell * (cell < 4 ? 0.56 : 0.4);
  const SAMPLES = 4;
  const coverage = new Array<number>(size * size).fill(0);
  MARK.forEach((row, rowIndex) => [...row].forEach((value, column) => {
    if (value !== '#') return;
    const cx = padding + (column + 0.5) * cell;
    const cy = padding + (rowIndex + 0.5) * cell;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(size - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(size - 1, Math.ceil(cx + radius)); x++) {
        let inside = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const px = x + (sx + 0.5) / SAMPLES - cx;
            const py = y + (sy + 0.5) / SAMPLES - cy;
            if (px * px + py * py <= radius * radius) inside++;
          }
        }
        const i = y * size + x;
        coverage[i] = Math.max(coverage[i] ?? 0, inside / (SAMPLES * SAMPLES));
      }
    }
  }));
  return coverage;
}
