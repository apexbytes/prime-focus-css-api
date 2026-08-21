import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as slaService from './sla.service.js';
import type {
  CreateHolidayBody,
  CreatePolicyBody,
  ListPoliciesQuery,
  UpdateBusinessHoursBody,
  UpdatePolicyBody,
} from './sla.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

// -- business hours ----------------------------------------------------------

export async function listBusinessHours(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await slaService.listCalendars());
}

export async function getBusinessHours(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await slaService.getCalendar(req.params.id as string));
}

export async function replaceBusinessHours(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await slaService.replaceCalendar(
      req.params.id as string,
      req.body as UpdateBusinessHoursBody,
      actorOf(req),
    ),
  );
}

export async function createHoliday(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await slaService.addHoliday(
      req.params.id as string,
      req.body as CreateHolidayBody,
      actorOf(req),
    ),
    { status: 201 },
  );
}

export async function deleteHoliday(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await slaService.removeHoliday(
      req.params.id as string,
      req.params.holidayId as string,
      actorOf(req),
    ),
  );
}

// -- policies ----------------------------------------------------------------

export async function listPolicies(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListPoliciesQuery;
  sendSuccess(res, await slaService.listPolicies(query.productId, actorOf(req)));
}

export async function createPolicy(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await slaService.createPolicy(req.body as CreatePolicyBody, actorOf(req)), {
    status: 201,
  });
}

export async function updatePolicy(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await slaService.updatePolicy(
      req.params.id as string,
      req.body as UpdatePolicyBody,
      actorOf(req),
    ),
  );
}

/** The SLA panel for one ticket: where each clock stands, plus any breaches. */
export async function getTicketSla(req: Request, res: Response): Promise<void> {
  const ticketId = req.params.ticketId as string;

  sendSuccess(res, {
    targets: await slaService.targetsForTicket(ticketId),
    breaches: await slaService.breachesForTicket(ticketId),
  });
}

/**
 * Runs the breach scan now instead of waiting for the cron.
 *
 * Useful to an operator who has just fixed a calendar, and the only way to
 * exercise the breach path when `QUEUE_DRIVER=inline` — where no schedule fires.
 */
export async function runScan(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await slaService.scanAndEscalate());
}
