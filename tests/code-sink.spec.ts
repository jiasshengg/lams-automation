import { expect, test } from '@playwright/test';
import { assertIdentifier, assertLessonCode, resolveSinkEndpoint, sendCodeToSheet } from '../src/sheets/code-sink.js';

const endpoint = { url: 'https://script.example/exec', secret: 'test-secret' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('rejects codes that are not exactly five digits', () => {
  expect(assertLessonCode('12345')).toBe('12345');
  expect(() => assertLessonCode('1234')).toThrow(/5-digit/);
  expect(() => assertLessonCode('12345 ')).toThrow(/5-digit/);
  expect(() => assertIdentifier('   ')).toThrow(/must not be empty/);
  expect(assertIdentifier(' FOM TBL06 030926 2026Y1 ')).toBe('FOM TBL06 030926 2026Y1');
});

test('requires the endpoint and secret to be configured', () => {
  const url = process.env.LAMS_SHEET_WEBHOOK_URL;
  const secret = process.env.LAMS_SHEET_SECRET;
  delete process.env.LAMS_SHEET_WEBHOOK_URL;
  delete process.env.LAMS_SHEET_SECRET;
  try {
    expect(() => resolveSinkEndpoint()).toThrow(/LAMS_SHEET_WEBHOOK_URL/);
    expect(() => resolveSinkEndpoint({ url: 'https://x/exec' })).toThrow(/LAMS_SHEET_SECRET/);
  } finally {
    if (url) process.env.LAMS_SHEET_WEBHOOK_URL = url;
    if (secret) process.env.LAMS_SHEET_SECRET = secret;
  }
});

test('posts the agreed payload and accepts an ok status', async () => {
  const seen: { url: string; body: unknown; contentType: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      contentType: new Headers(init?.headers).get('Content-Type')
    });
    return jsonResponse({ status: 'ok' });
  }) as unknown as typeof fetch;

  const result = await sendCodeToSheet('12345', 'FOM TBL06 030926 2026Y1', { ...endpoint, fetchImpl });

  expect(result.status).toBe('ok');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(endpoint.url);
  expect(seen[0]!.contentType).toBe('application/json');
  expect(seen[0]!.body).toEqual({ code: '12345', identifier: 'FOM TBL06 030926 2026Y1', secret: 'test-secret' });
});

test('retries a transient failure and then succeeds', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return jsonResponse({ status: 'ok' });
  }) as unknown as typeof fetch;

  await sendCodeToSheet('12345', 'FOM TBL06 030926 2026Y1', { ...endpoint, fetchImpl, attempts: 2 });
  expect(calls).toBe(2);
});

test('fails loudly on a rejected status, an HTTP error, and a non-JSON body', async () => {
  const withBody = (response: () => Response) =>
    sendCodeToSheet('12345', 'FOM TBL06 030926 2026Y1', {
      ...endpoint,
      attempts: 1,
      fetchImpl: (async () => response()) as unknown as typeof fetch
    });

  await expect(withBody(() => jsonResponse({ status: 'error', message: 'identifier not found' }))).rejects.toThrow(
    /identifier not found/
  );
  await expect(withBody(() => jsonResponse({ status: 'error' }, 500))).rejects.toThrow(/HTTP 500/);
  await expect(withBody(() => new Response('<html>Sign in</html>'))).rejects.toThrow(/did not return JSON/);
});
