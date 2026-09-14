import { Pipe, type PipeTransform } from '@angular/core';

const UNITS: readonly [name: string, seconds: number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/**
 * Formats an ISO date string as "x seconds/minutes/hours/days/months/years
 * ago" (or "just now" for anything under 5 seconds). `pure: false` so it
 * keeps advancing (e.g. "5 seconds ago" -> "6 seconds ago") across change
 * detection runs, without needing its own timer.
 */
@Pipe({ name: 'relativeTime', pure: false })
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 5) return 'just now';

    for (const [name, unitSeconds] of UNITS) {
      const count = Math.floor(seconds / unitSeconds);
      if (count >= 1) return `${count} ${name}${count === 1 ? '' : 's'} ago`;
    }
    return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  }
}
