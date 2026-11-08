const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidTime = (value: string): boolean => TIME.test(value);

const minutesOf = (value: string): number => {
  const match = TIME.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
};

/** True when `now` falls inside the daily window. The end is excluded, and a window may cross midnight. */
export function withinWindow(now: Date, start: string, end: string): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(start);
  const to = minutesOf(end);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}
