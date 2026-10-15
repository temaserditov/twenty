import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractError, validateEvent, verifySignature } from './contract.mjs';
import { Store } from './store.mjs';
import { Twenty } from './twenty.mjs';
import { processNext } from './worker.mjs';

export function createReceiver(store, secrets) {
  return createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return reply(200, {ok: true});
      const source = /^\/events\/(funnel|lms)$/.exec(req.url ?? '')?.[1];
      if (req.method !== 'POST' || !source) return reply(404, {error: 'not_found'});
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ContractError('json_required', 415);
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32_768) throw new ContractError('body_too_large', 413);
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      verifySignature(secrets[source], req.headers['x-crm-timestamp'], req.headers['x-crm-signature'], raw);
      let input;
      try { input = JSON.parse(raw); } catch { throw new ContractError('invalid_json'); }
      const inserted = store.enqueue(validateEvent(input, source));
      reply(202, {accepted: true, duplicate: !inserted});
    } catch (error) {
      reply(error instanceof ContractError ? error.status : 503, {error: error instanceof ContractError ? error.message : 'temporarily_unavailable'});
    }
  });
}

export function startReceiver(twenty) {
  const { CRM_FUNNEL_HMAC, CRM_LMS_HMAC } = process.env;
  if (!CRM_FUNNEL_HMAC || !CRM_LMS_HMAC || CRM_FUNNEL_HMAC.length < 32 || CRM_LMS_HMAC.length < 32 || CRM_FUNNEL_HMAC === CRM_LMS_HMAC) {
    throw new Error('distinct_source_secrets_required');
  }
  const path = process.env.CRM_QUEUE_PATH ?? '/data/crm.sqlite';
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const store = new Store(path);
  const server = createReceiver(store, {funnel: CRM_FUNNEL_HMAC, lms: CRM_LMS_HMAC});
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(Number(process.env.PORT ?? 3034), process.env.HOST ?? '127.0.0.1', () => console.log('crm_receiver_ready'));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await processNext(store, twenty); } finally { busy = false; }
  }, 1000);
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      const wait = setInterval(() => { if (!busy) { clearInterval(wait); store.close(); process.exit(0); } }, 100);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return {server, store};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startReceiver(new Twenty(process.env.TWENTY_URL, process.env.TWENTY_TOKEN));
}
