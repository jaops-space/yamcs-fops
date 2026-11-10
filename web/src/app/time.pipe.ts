import { Pipe, PipeTransform } from '@angular/core';

/**
 * ISO time as "2026-11-06 16:35:52.295 UTC". The SDK's datetime pipe reads
 * the host app's time zone preferences, which an extension's own Angular
 * application does not have.
 */
@Pipe({ name: 'utc' })
export class UtcPipe implements PipeTransform {
  transform(v: string | null | undefined, ms = true): string {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const s = d.toISOString().replace('T', ' ').replace('Z', '');
    return (ms ? s : s.slice(0, 19)) + ' UTC';
  }
}
