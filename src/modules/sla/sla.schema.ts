import { z } from 'zod';
import { parseTimeOfDay, weeklyOpenMinutes } from './sla.clock.js';

const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const idParams = z.object({ id: z.uuid() });

/** `HH:MM`, validated against the same parser the clock uses. */
const timeOfDay = z.string().refine((value) => parseTimeOfDay(value) !== null, {
  message: 'must be HH:MM between 00:00 and 24:00',
});

const window = z
  .object({
    /** 0 = Sunday, matching `Date.getUTCDay()`. */
    day: z.coerce.number().int().min(0).max(6),
    opensAt: timeOfDay,
    closesAt: timeOfDay,
  })
  .refine(
    (value) => (parseTimeOfDay(value.closesAt) ?? 0) > (parseTimeOfDay(value.opensAt) ?? 0),
    'closesAt must be later than opensAt',
  );

/**
 * A whole working week. Rejected if it adds up to no open time, because the SLA
 * clock cannot place a deadline on a calendar that is never open — better a 422
 * here than a target that can never be met.
 */
const weekly = z
  .array(window)
  .min(1)
  .max(21)
  .refine((value) => weeklyOpenMinutes(value) > 0, 'the week must contain at least one open window')
  .refine((value) => !hasOverlap(value), 'windows on the same day must not overlap');

/** Overlapping windows would double-count the overlap as available time. */
function hasOverlap(windows: { day: number; opensAt: string; closesAt: string }[]): boolean {
  for (let day = 0; day <= 6; day += 1) {
    const spans = windows
      .filter((entry) => entry.day === day)
      .map((entry) => ({
        start: parseTimeOfDay(entry.opensAt) ?? 0,
        end: parseTimeOfDay(entry.closesAt) ?? 0,
      }))
      .sort((left, right) => left.start - right.start);

    for (let index = 1; index < spans.length; index += 1) {
      const previous = spans[index - 1];
      const current = spans[index];
      if (previous && current && current.start < previous.end) return true;
    }
  }

  return false;
}

export const updateBusinessHoursBody = z.object({
  name: z.string().trim().min(2).max(96).optional(),
  /** Validated by the clock at use time; an unknown zone throws there. */
  timezone: z.string().trim().min(3).max(64).optional(),
  weekly,
});

export const createHolidayBody = z.object({
  /** A local calendar date, not an instant. */
  observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  name: z.string().trim().min(2).max(96),
});

export const holidayParams = z.object({ id: z.uuid(), holidayId: z.uuid() });

export const listPoliciesQuery = z.object({
  productId: z.uuid().optional(),
});

/**
 * Minutes rather than hours: an SLA is quoted in minutes for a first response
 * and the resolution figure has to use the same unit or the two get confused.
 * Capped at a year of working minutes, which is far past anything sane and still
 * stops a typo from creating an unreachable deadline.
 */
const minutes = z.coerce.number().int().min(1).max(525_600);

export const createPolicyBody = z
  .object({
    productId: z.uuid(),
    priority: z.enum(TICKET_PRIORITIES),
    firstResponseMinutes: minutes,
    resolutionMinutes: minutes,
    businessHoursId: z.uuid().optional(),
  })
  .refine(
    (value) => value.resolutionMinutes >= value.firstResponseMinutes,
    'resolutionMinutes must be at least firstResponseMinutes',
  );

export const updatePolicyBody = z
  .object({
    firstResponseMinutes: minutes.optional(),
    resolutionMinutes: minutes.optional(),
    businessHoursId: z.uuid().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

export type UpdateBusinessHoursBody = z.infer<typeof updateBusinessHoursBody>;
export type CreateHolidayBody = z.infer<typeof createHolidayBody>;
export type ListPoliciesQuery = z.infer<typeof listPoliciesQuery>;
export type CreatePolicyBody = z.infer<typeof createPolicyBody>;
export type UpdatePolicyBody = z.infer<typeof updatePolicyBody>;
