import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { businessHours } from '../../src/modules/sla/sla.model.js';
import { invalidateCalendarCache } from '../../src/modules/sla/sla.service.js';

/**
 * Opens the default calendar on all seven days, for the handful of cases that
 * measure elapsed *working* time.
 *
 * The seeded calendar is Monday to Friday, 08:00–17:00, which is what almost
 * every SLA case wants to assert against — that a deadline skips a weekend is
 * the whole point of having a calendar at all. But two cases assert the
 * opposite direction: that pausing a clock gives measurable time back, and that
 * a breach records minutes overdue. Both put an interval of real time between
 * two instants and expect the clock to have moved, and on a Saturday the clock
 * correctly does not move at all — so those two failed every weekend and passed
 * every weekday, which is a test telling the truth about the wrong thing.
 *
 * Applied per case rather than in `resetDatabase`, so the working week stays the
 * real one everywhere else.
 */
export async function openEveryDay(): Promise<void> {
  await db
    .update(businessHours)
    .set({
      weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day,
        opensAt: '00:00',
        closesAt: '23:59',
      })),
    })
    .where(eq(businessHours.isDefault, true));

  // Calendars are cached in process and the SLA clock would otherwise keep
  // computing against the week this just replaced.
  invalidateCalendarCache();
}
