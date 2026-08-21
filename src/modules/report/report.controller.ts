import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as reportService from './report.service.js';
import type { AgentReportQuery, ReportQuery } from './report.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function overview(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await reportService.overview(req.query as unknown as ReportQuery, actorOf(req)));
}

export async function sla(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await reportService.sla(req.query as unknown as ReportQuery, actorOf(req)));
}

export async function volume(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await reportService.volume(req.query as unknown as ReportQuery, actorOf(req)));
}

export async function agents(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await reportService.agents(req.query as unknown as AgentReportQuery, actorOf(req)),
  );
}

export async function csat(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await reportService.csat(req.query as unknown as ReportQuery, actorOf(req)));
}

/**
 * Rebuilds the views now instead of waiting for the schedule.
 *
 * For the operator who has just corrected a policy and wants the dashboard to
 * agree — and the only way to see a report at all under `QUEUE_DRIVER=inline`,
 * where no cron fires.
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await reportService.refreshAll(actorOf(req)));
}
