import { eq, sql } from 'drizzle-orm';
import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { categories } from '../../modules/category/category.model.js';
import { products } from '../../modules/product/product.model.js';
import { db } from '../client.js';

const log = createModuleLogger('db:seed');

/**
 * Placeholder product catalogue so tickets, categories and SLA policies have
 * something to hang off from the first run. These are ordinary rows — rename or
 * replace them through `PATCH /products/:id` once the real list is known.
 */
const PRODUCTS = [
  {
    code: 'pf_wallet',
    name: 'Prime Focus Wallet',
    description: 'Mobile wallet: balances, transfers and airtime',
    categories: [
      'Failed transfer',
      'Airtime purchase',
      'Account access',
      'Statement request',
      'Other',
    ],
  },
  {
    code: 'pf_lending',
    name: 'Prime Focus Lending',
    description: 'Loan applications, disbursements and repayments',
    categories: [
      'Loan application',
      'Repayment query',
      'Disbursement delay',
      'Settlement letter',
      'Other',
    ],
  },
  {
    code: 'pf_payments',
    name: 'Prime Focus Payments',
    description: 'Merchant payments, settlements and terminals',
    categories: [
      'Settlement query',
      'Terminal fault',
      'Chargeback',
      'Merchant onboarding',
      'Other',
    ],
  },
] as const;

export async function seedCatalogue(): Promise<void> {
  for (const definition of PRODUCTS) {
    const [product] = await db
      .insert(products)
      .values({
        code: definition.code,
        name: definition.name,
        description: definition.description,
        // Per-product support addresses are what route inbound mail.
        supportEmail: `${definition.code.replace(/^pf_/, '')}@${env.SUPPORT_INBOX_DOMAIN}`,
      })
      .onConflictDoUpdate({
        target: products.code,
        // Name and description are editable through the API, so the seed must
        // not stamp on them after the first run.
        set: { updatedAt: sql`now()` },
      })
      .returning();

    if (!product) throw new Error(`failed to upsert product ${definition.code}`);

    for (const [index, name] of definition.categories.entries()) {
      await db
        .insert(categories)
        .values({ productId: product.id, name, sortOrder: index * 10 })
        .onConflictDoNothing();
    }

    const [counted] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(categories)
      .where(eq(categories.productId, product.id));

    log.info('product seeded', {
      code: product.code,
      supportEmail: product.supportEmail,
      categories: counted?.count ?? 0,
    });
  }
}
