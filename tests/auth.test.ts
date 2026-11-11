import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { getAuthConfig, requireAdmin, signAdminSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { proxy, config as proxyConfig } from '@/proxy';

const PASSWORD = 'N7!vT4$rK9@qL2';
const SECRET = '76d0973c0a4be2819f635ae84702dc15';
const encoder = new TextEncoder();
const env: Record<string, string | undefined> = process.env;

function request(token?: string) {
  return new Request('http://localhost/api/surveys', {
    headers: token === undefined ? {} : { cookie: `other=value; ${SESSION_COOKIE}=${token}; trailing=value` },
  });
}

function loginRequest(body: string) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
}

async function token(overrides: Record<string, unknown> = {}, algorithm = 'HS256', secret = SECRET) {
  return new SignJWT({
    role: 'admin', iss: 'feud-survey', aud: 'feud-survey-admin',
    exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
  }).setProtectedHeader({ alg: algorithm }).sign(encoder.encode(secret));
}

describe('admin authentication', { concurrency: false }, () => {
  let original: Record<string, string | undefined>;
  beforeEach(() => {
    original = {
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
      SESSION_SECRET: process.env.SESSION_SECRET,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const [key, values] of Object.entries({
    ADMIN_PASSWORD: [undefined, '', '   ', '12345678901', 'changeme', 'CHANGE-ME-please', 'your-admin-password', 'password123456', 'example-password-for-testing'],
    SESSION_SECRET: [undefined, '', '   ', 'x'.repeat(31), ' '.repeat(32), 'replace-with-a-long-random-string', 'replace-with-a-long-random-string-at-least-32-bytes', 'dev-secret-change-me'.repeat(2), 'your-session-secret-at-least-32-bytes', 'example-secret-do-not-use-in-production'],
  })) {
    for (const value of values) {
      it(`fails closed for ${key}=${JSON.stringify(value)}`, async () => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        assert.equal(getAuthConfig(), null);
        const denied = await requireAdmin(request(await token()));
        assert.equal(denied?.status, 503);
        assert.deepEqual(await denied?.json(), { error: 'Authentication unavailable' });
        const response = await login(loginRequest(JSON.stringify({ password: PASSWORD })));
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'Authentication unavailable' });
        assert.equal(response.headers.get('set-cookie'), null);
      });
    }
  }

  it('accepts minimum lengths and measures the secret in UTF-8 bytes', async () => {
    process.env.ADMIN_PASSWORD = 'N7!vT4$rK9@q';
    assert.equal(process.env.ADMIN_PASSWORD.length, 12);
    process.env.SESSION_SECRET = '\u00e9'.repeat(16);
    const config = getAuthConfig();
    assert.ok(config);
    assert.equal(config.secret.byteLength, 32);
    assert.equal(await requireAdmin(request(await signAdminSession(config))), null);
    process.env.SESSION_SECRET = '\u00e9'.repeat(15);
    assert.equal(getAuthConfig(), null);
  });

  it('accepts signed admin sessions from Request and NextRequest cookies', async () => {
    const config = getAuthConfig();
    assert.ok(config);
    const session = await signAdminSession(config);
    assert.equal(await requireAdmin(request(session)), null);
    assert.equal(await requireAdmin(new NextRequest(request(session))), null);
    assert.equal((await requireAdmin(request()))?.status, 401);
  });

  for (const [name, makeToken] of Object.entries({
    malformed: async (): Promise<string> => 'not-a-jwt',
    empty: async (): Promise<string> => '',
    'wrong signature': () => token({}, 'HS256', 'a'.repeat(32)),
    expired: () => token({ exp: Math.floor(Date.now() / 1000) - 60 }),
    'missing expiration': () => token({ exp: undefined }),
    'wrong role': () => token({ role: 'viewer' }),
    'missing role': () => token({ role: undefined }),
    'wrong algorithm': () => token({}, 'HS384'),
    'wrong issuer': () => token({ iss: 'another-app' }),
    'wrong audience': () => token({ aud: 'another-app' }),
    'legacy session': () => token({ iss: undefined, aud: undefined }),
    'not yet valid': () => token({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
  })) {
    it(`rejects ${name} JWTs uniformly`, async () => {
      const response = await requireAdmin(request(await makeToken()));
      assert.equal(response?.status, 401);
      assert.deepEqual(await response?.json(), { error: 'Unauthorized' });
    });
  }

  for (const body of ['{', '', 'null', '[]', '42', '"password"', '{}', '{"password":null}', '{"password":42}', '{"password":{}}', '{"password":[]}', '{"password":""}', '{"password":"wrong"}']) {
    it(`rejects invalid login body ${JSON.stringify(body)} uniformly`, async () => {
      const response = await login(loginRequest(body));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
      assert.equal(response.headers.get('set-cookie'), null);
    });
  }

  for (const environment of ['production', 'development']) {
    it(`sets secure session cookie attributes in ${environment}`, async () => {
      env.NODE_ENV = environment;
      const response = await login(loginRequest(JSON.stringify({ password: PASSWORD })));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      const cookie = response.cookies.get(SESSION_COOKIE);
      assert.ok(cookie);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, 'lax');
      assert.equal(cookie.secure, environment === 'production');
      assert.equal(cookie.path, '/');
      assert.equal(cookie.maxAge, SESSION_MAX_AGE);
      assert.equal(await requireAdmin(request(cookie.value)), null);
    });
  }

  it('logout is idempotent even with invalid configuration and stale cookies', async () => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
    env.NODE_ENV = 'production';
    // The handler intentionally ignores requests, including any invalid cookie.
    const handler: (request: Request) => ReturnType<typeof logout> = logout;
    for (const session of [undefined, 'invalid', await token({ exp: 1 }), 'invalid']) {
      const response = await handler(request(session));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      const cookie = response.cookies.get(SESSION_COOKIE);
      assert.ok(cookie);
      assert.equal(cookie.value, '');
      assert.equal(cookie.maxAge, 0);
      assert.ok(cookie.expires instanceof Date);
      assert.equal(cookie.expires.getTime(), 0);
      assert.equal(cookie.path, '/');
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, 'lax');
      assert.equal(cookie.secure, true);
    }
    assert.ok(!proxyConfig.matcher.includes('/api/auth/logout'));
  });

  it('proxy redirects admin pages and preserves API auth failures', async () => {
    const response = await proxy(new NextRequest('http://localhost/admin/surveys'));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), 'http://localhost/login');
    assert.equal((await proxy(new NextRequest(request())))?.status, 401);
    assert.equal((await proxy(new NextRequest(request(await token())))).headers.get('x-middleware-next'), '1');
    delete process.env.SESSION_SECRET;
    assert.equal((await proxy(new NextRequest(request())))?.status, 503);
  });
});
