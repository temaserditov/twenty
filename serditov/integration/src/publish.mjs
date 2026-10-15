import { signature } from './contract.mjs';

// Call from a durable platform outbox, after the originating transaction commits.
// A 202 response acknowledges persistence, not immediate visibility in Twenty.
export async function publishSnapshot({url, source, secret, event, fetcher = fetch}) {
  if (!['funnel', 'lms'].includes(source) || !secret || secret.length < 32) throw new Error('invalid_publisher_config');
  const endpoint = new URL(`/events/${source}`, url);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new Error('receiver_requires_https');
  const raw = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetcher(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {'content-type': 'application/json', 'x-crm-timestamp': timestamp, 'x-crm-signature': signature(secret, timestamp, raw)},
    body: raw,
  });
  if (response.status !== 202) throw new Error(`crm_publish_http_${response.status}`);
  return {accepted: true};
}
