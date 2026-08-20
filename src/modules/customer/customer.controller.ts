import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as customerService from './customer.service.js';
import type {
  CreateCustomerBody,
  LinkAccountBody,
  ListCustomersQuery,
  MergeCustomerBody,
  UpdateCustomerBody,
} from './customer.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listCustomers(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListCustomersQuery;
  const rows = await customerService.list({ ...query, limit: query.limit + 1 });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.email ?? null) : null,
    },
  });
}

export async function getCustomer(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await customerService.get(req.params.id as string));
}

export async function createCustomer(req: Request, res: Response): Promise<void> {
  const customer = await customerService.create(req.body as CreateCustomerBody, actorOf(req));
  sendSuccess(res, customer, { status: 201 });
}

export async function updateCustomer(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await customerService.update(
      req.params.id as string,
      req.body as UpdateCustomerBody,
      actorOf(req),
    ),
  );
}

export async function linkAccount(req: Request, res: Response): Promise<void> {
  const customer = await customerService.addAccount(
    req.params.id as string,
    req.body as LinkAccountBody,
    actorOf(req),
  );
  sendSuccess(res, customer, { status: 201 });
}

export async function unlinkAccount(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await customerService.removeAccount(
      req.params.id as string,
      req.params.accountId as string,
      actorOf(req),
    ),
  );
}

export async function mergeCustomer(req: Request, res: Response): Promise<void> {
  const { duplicateId } = req.body as MergeCustomerBody;
  sendSuccess(res, await customerService.merge(req.params.id as string, duplicateId, actorOf(req)));
}
