export const SHUTDOWN_DELAY_MS = 60000;

export interface CountdownSteps {
  /** Shows the choice, and resolves when the user answers. It may stay open past the countdown. */
  ask(): Promise<'cancel' | 'now'>;
  shutDown(): void;
  delayMs?: number;
}

/**
 * Gives the user a minute to stop the computer turning off. With no answer it goes ahead, because
 * the point is to work with nobody there. Returns what happened, and shuts down at most once.
 */
export async function runShutdownCountdown(steps: CountdownSteps): Promise<'cancelled' | 'shut-down'> {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    steps.shutDown();
  };
  const timer = setTimeout(fire, steps.delayMs ?? SHUTDOWN_DELAY_MS);
  const answer = await steps.ask();
  clearTimeout(timer);
  if (fired) return 'shut-down';
  if (answer === 'cancel') return 'cancelled';
  fire();
  return 'shut-down';
}

/**
 * The Windows command to turn off now. "/f" is left out on purpose: without it, another program with
 * unsaved work can hold the shutdown back instead of losing that work.
 */
export const SHUTDOWN_ARGS = ['/s', '/t', '0'];
