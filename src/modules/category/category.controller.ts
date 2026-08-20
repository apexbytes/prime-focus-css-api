import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as categoryService from './category.service.js';
import type {
  CreateCategoryBody,
  ListCategoriesQuery,
  UpdateCategoryBody,
} from './category.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListCategoriesQuery;
  sendSuccess(
    res,
    await categoryService.listForProduct(query.productId, query.activeOnly, actorOf(req)),
  );
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const category = await categoryService.create(req.body as CreateCategoryBody, actorOf(req));
  sendSuccess(res, category, { status: 201 });
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await categoryService.update(
      req.params.id as string,
      req.body as UpdateCategoryBody,
      actorOf(req),
    ),
  );
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  await categoryService.remove(req.params.id as string, actorOf(req));
  sendNoContent(res);
}
