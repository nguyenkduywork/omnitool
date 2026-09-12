import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

type TestRequest = { url: string; method: 'GET'; mode: 'cors' | 'navigate' };
type TestResponse = { ok: boolean; clone(): TestResponse };
type FetchEvent = {
  request: TestRequest;
  respondWith(response: Promise<TestResponse> | TestResponse): void;
};

const source = readFileSync(new URL('../../src/sw.ts', import.meta.url), 'utf8');
const script = `const __PRECACHE__ = [];\n${transpileModule(source, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText}`;

function response(): TestResponse {
  const value: TestResponse = { ok: true, clone: () => value };
  return value;
}

function harness(dependencies: {
  match: (request: TestRequest, options?: { ignoreVary?: boolean }) => Promise<TestResponse | undefined>;
  open: (name: string) => Promise<{ put: (request: TestRequest, value: TestResponse) => Promise<void> }>;
  fetch: (request: TestRequest) => Promise<TestResponse>;
}) {
  let onFetch: ((event: FetchEvent) => void) | undefined;
  const scope = {
    URL,
    caches: { match: dependencies.match, open: dependencies.open },
    fetch: dependencies.fetch,
    registration: { scope: 'https://example.test/' },
    location: { origin: 'https://example.test' },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => {
      if (type === 'fetch') onFetch = listener;
    },
  };
  runInNewContext(script, scope);
  return async (request: TestRequest): Promise<TestResponse> => {
    let result: Promise<TestResponse> | undefined;
    onFetch?.({ request, respondWith: (value) => { result = Promise.resolve(value); } });
    if (!result) throw new Error('service worker did not intercept the request');
    return result;
  };
}

describe('service worker asset cache', () => {
  it('serves a precached shell asset despite an Origin variant when offline', async () => {
    const cached = response();
    const match = vi.fn(async (_request: TestRequest, options?: { ignoreVary?: boolean }) =>
      options?.ignoreVary ? cached : undefined);
    const fetch = vi.fn(async (): Promise<TestResponse> => { throw new Error('offline'); });
    const dispatch = harness({ match, fetch, open: async () => { throw new Error('no runtime cache'); } });
    const request: TestRequest = { url: 'https://example.test/assets/index-hash.js', method: 'GET', mode: 'cors' };

    expect(await dispatch(request)).toBe(cached);
    expect(match).toHaveBeenCalledWith(request, { ignoreVary: true });
  });

  it.each(['asset', 'navigation'] as const)('keeps a successful %s response when cache.put rejects', async (kind) => {
    const fresh = response();
    const put = vi.fn(async () => { throw new Error('quota exceeded'); });
    const open = vi.fn(async () => ({ put }));
    const dispatch = harness({ match: async () => undefined, open, fetch: async () => fresh });
    const request: TestRequest = {
      url: kind === 'asset' ? 'https://example.test/assets/workspace-hash.js' : 'https://example.test/',
      method: 'GET',
      mode: kind === 'asset' ? 'cors' : 'navigate',
    };

    expect(await dispatch(request)).toBe(fresh);
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledWith(kind === 'asset' ? 'omnitool-runtime' : 'omnitool-shell');
  });
});
