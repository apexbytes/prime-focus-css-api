import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as productService from './product.service.js';
import type {
  CreateProductBody,
  GrantAccessBody,
  ListProductsQuery,
  UpdateProductBody,
} from './product.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListProductsQuery;
  const products = query.mine
    ? await productService.listForActor(actorOf(req))
    : await productService.list(query.activeOnly);

  sendSuccess(res, products);
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await productService.get(req.params.id as string));
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const product = await productService.create(req.body as CreateProductBody, actorOf(req));
  sendSuccess(res, product, { status: 201 });
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await productService.update(
      req.params.id as string,
      req.body as UpdateProductBody,
      actorOf(req),
    ),
  );
}

export async function grantProductAccess(req: Request, res: Response): Promise<void> {
  const { userId } = req.body as GrantAccessBody;
  sendSuccess(res, await productService.grantAccess(req.params.id as string, userId, actorOf(req)));
}

export async function revokeProductAccess(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await productService.revokeAccess(
      req.params.id as string,
      req.params.userId as string,
      actorOf(req),
    ),
  );
}
