import { beforeEach, describe, expect, it } from 'vitest';
import { clearMemoryCache, forget, forgetPrefix, getJson, remember, setJson } from './index.js';

/**
 * The `memory` driver, which is what the test suite and a database-less
 * checkout run on. The Redis driver is exercised by the integration suites,
 * where one is actually running.
 */
describe('cache store (memory driver)', () => {
  beforeEach(() => {
    clearMemoryCache();
  });

  it('returns what was written, and null for what was not', async () => {
    await setJson('thing:1', { hits: 3 }, 60);

    expect(await getJson<{ hits: number }>('thing:1')).toEqual({ hits: 3 });
    expect(await getJson('thing:2')).toBeNull();
  });

  it('treats a zero TTL as "do not cache" rather than "cache forever"', async () => {
    await setJson('thing:1', { hits: 3 }, 0);
    expect(await getJson('thing:1')).toBeNull();
  });

  it('computes once and serves the rest from the cache', async () => {
    let computed = 0;
    const load = () => {
      computed += 1;
      return Promise.resolve(['article-1']);
    };

    expect(await remember('kb:suggest:abc', 60, load)).toEqual(['article-1']);
    expect(await remember('kb:suggest:abc', 60, load)).toEqual(['article-1']);
    expect(computed).toBe(1);
  });

  it('recomputes after the entry is forgotten', async () => {
    let computed = 0;
    const load = () => {
      computed += 1;
      return Promise.resolve(computed);
    };

    await remember('kb:suggest:abc', 60, load);
    await forget('kb:suggest:abc');
    await remember('kb:suggest:abc', 60, load);

    expect(computed).toBe(2);
  });

  /**
   * What a knowledge base write does. The cache is keyed by the customer's
   * words, so there is no way to know which entries a changed article ranked in
   * — the whole prefix goes.
   */
  it('drops a whole prefix without touching anything else', async () => {
    await setJson('kb:suggest:one', 1, 60);
    await setJson('kb:suggest:two', 2, 60);
    await setJson('other:thing', 3, 60);

    await forgetPrefix('kb:suggest:');

    expect(await getJson('kb:suggest:one')).toBeNull();
    expect(await getJson('kb:suggest:two')).toBeNull();
    expect(await getJson('other:thing')).toBe(3);
  });
});
