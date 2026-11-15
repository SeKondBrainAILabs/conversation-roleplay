/** Shared-channel text contract from Basanti server/communications/messages.ts (7e152db9).
 * This is message rendering, not WhatsApp delivery or the richer browser cards.
 */
import { assert, isObject } from './util.mjs';

export function renderBasantiReply(reply) {
  assert(isObject(reply) && typeof reply.text === 'string', 'Invalid Basanti reply');
  const tasks = reply.tasks ?? [];
  const translations = reply.translations ?? [];
  const candidates = reply.candidates ?? [];
  assert(
    [tasks, translations, candidates].every(Array.isArray) &&
      tasks.every(task => isObject(task) && Number.isInteger(task.id) && typeof task.title === 'string') &&
      translations.every(t => isObject(t) && Number.isInteger(t.taskId) &&
        (t.title == null || typeof t.title === 'string') &&
        (t.instructions == null || typeof t.instructions === 'string')) &&
      candidates.every(candidate => isObject(candidate) &&
        typeof candidate.displayName === 'string' && typeof candidate.sourceRole === 'string' &&
        (candidate.whatsappVerified === undefined || typeof candidate.whatsappVerified === 'boolean')),
    'Invalid Basanti structured reply',
  );
  return [
    reply.text,
    ...tasks.map(task => {
      const t = translations.find(t => t.taskId === task.id);
      return `${task.id}: ${t?.title ?? task.title}${t?.instructions ? ` — ${t.instructions}` : ''}`;
    }),
    ...candidates.map(candidate =>
      `${candidate.displayName} · ${candidate.sourceRole}${candidate.whatsappVerified ? ' · WhatsApp verified' : ''}`),
  ].join('\n').slice(0, 4000);
}

export function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localFormatter(timezone) {
  assert(typeof timezone === 'string' && timezone.length > 0, 'Missing household timezone');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

export function assertHouseholdClock(context) {
  assert(validCalendarDate(context.date), 'Basanti binding needs a real YYYY-MM-DD household date');
  localFormatter(context.timezone);
}

export function checkBasantiClock(reply, submitted) {
  const reported = { date: reply?.date, timezone: reply?.timezone };
  try {
    assertHouseholdClock(reported);
  } catch {
    return { status: 'unavailable', reason: 'Native reply did not report a valid household clock; fixture qualification is unavailable' };
  }
  return reported.date === submitted.date && reported.timezone === submitted.timezone
    ? { status: 'passed', reason: 'Submitted fixture clock matches native household clock' }
    : { status: 'failed', reason: 'Submitted fixture clock differs from native household clock; reconcile test setup before judging relative dates' };
}

export function assertLocalDateTime(expected) {
  assert(isObject(expected) && validCalendarDate(expected.date) &&
    typeof expected.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(expected.time),
  'localDateTime needs an exact date, HH:mm:ss time and timezone');
  localFormatter(expected.timezone);
}

export function matchesLocalDateTime(value, expected) {
  assertLocalDateTime(expected);
  // Naive dates and normalized impossible dates must never inherit the runner's timezone.
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) ||
    !validCalendarDate(value.slice(0, 10))) return false;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.getUTCMilliseconds() !== 0) return false;
  const parts = Object.fromEntries(localFormatter(expected.timezone).formatToParts(instant).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}` === expected.date &&
    `${parts.hour}:${parts.minute}:${parts.second}` === expected.time;
}
