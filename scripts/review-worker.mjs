import { setTimeout as sleep } from 'node:timers/promises';

// A separate process, never a Next.js in-process interval. Production needs only Node.
const env = process.env;
if (env.REVIEW_WORKER_ENABLED === 'true') {
  const secret = env.REVIEW_SCHEDULER_SECRET;
  const provider = env.AI_PROVIDER || 'anthropic';
  const providerKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.AI_API_KEY;
  const interval = Number(env.REVIEW_WORKER_INTERVAL_SECONDS || '60');
  const port = Number(env.REVIEW_WORKER_PORT || env.PORT || '3000');
  let endpoint;
  let validProviderURL = false;
  try {
    endpoint = new URL(env.REVIEW_WORKER_URL || `http://127.0.0.1:${port}/api/reviews/run`);
    const base = new URL(env.AI_BASE_URL || (provider === 'anthropic' ? 'https://api.anthropic.com' : ''));
    validProviderURL = (base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) && !base.username && !base.password && !base.search && !base.hash;
  } catch { /* Validated below without logging environment values. */ }
  if (!secret || secret.trim().length < 32 || /^(replace|change|example|your[-_ ]|placeholder)/i.test(secret.trim()) || secret === env.ADMIN_PASSWORD || secret === env.SESSION_SECRET ||
      env.AI_ENABLED !== 'true' || !['anthropic', 'openai-compatible'].includes(provider) || !providerKey?.trim() ||
      (provider === 'openai-compatible' && !env.AI_MODEL?.trim()) || (env.AI_MODEL?.trim().length || 0) > 200 || !validProviderURL ||
      !Number.isInteger(interval) || interval < 1 || interval > 86400 || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) {
    console.error('Review worker configuration is invalid; worker not started.');
    process.exitCode = 1;
  } else {
    const shutdown = new AbortController();
    process.once('SIGTERM', () => shutdown.abort());
    process.once('SIGINT', () => shutdown.abort());
    while (!shutdown.signal.aborted) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${secret}` }, redirect: 'error',
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(330_000)]),
        });
        await response.body?.cancel();
        if (!response.ok) console.error('Review scheduler request was not accepted.');
      } catch {
        if (!shutdown.signal.aborted) console.error('Review scheduler request failed.');
      }
      // Await both request and delay: this worker never overlaps its own requests.
      try { await sleep(interval * 1000, undefined, { signal: shutdown.signal }); } catch { break; }
    }
  }
}
