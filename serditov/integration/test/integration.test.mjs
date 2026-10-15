import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {signature, verifySignature, validateEvent, recordUuid} from '../src/contract.mjs';
import {createReceiver} from '../src/server.mjs';
import {processNext} from '../src/worker.mjs';
import {Twenty} from '../src/twenty.mjs';
import {publishSnapshot} from '../src/publish.mjs';

const funnel = 'test-funnel-'.repeat(4), lms = 'test-lms-'.repeat(4);
const lead = (overrides = {}) => ({schemaVersion: 1, eventId: 'lead-1-v1', entity: 'lead', recordId: 'fl_test', revision: 1,
  occurredAt: '2026-10-15T00:00:00.000Z', data: {name: 'Тестовый лид', funnelLeadId: 'fl_test', email: 'test@example.invalid'}, ...overrides});

test('source isolation rejects order events from Funnel', () => {
  assert.throws(() => validateEvent({...lead(), entity: 'order'}, 'funnel'), /source_not_allowed/);
  assert.throws(() => validateEvent(lead(), 'lms'), /source_not_allowed/);
});
test('HMAC binds source secret, timestamp and exact raw bytes', () => {
  const stamp = String(Math.floor(Date.now()/1000)), raw = JSON.stringify(lead());
  const sign = signature(funnel, stamp, raw);
  verifySignature(funnel, stamp, sign, raw);
  assert.throws(() => verifySignature(lms, stamp, sign, raw), /unauthorized/);
  assert.throws(() => verifySignature(funnel, stamp, sign, raw+' '), /unauthorized/);
  assert.throws(() => verifySignature(funnel, stamp, sign, raw, Date.now()+301_000), /unauthorized/);
  assert.throws(() => verifySignature(funnel, stamp, 'bad', raw), /unauthorized/);
});
test('snapshots exclude undeclared fields and require stable identities', () => {
  assert.throws(() => validateEvent(lead({data: {name:'Test', funnelLeadId:'wrong'}}), 'funnel'), /lead_id_mismatch/);
  assert.throws(() => validateEvent(lead({data: {...lead().data, price: 1}}), 'funnel'), /unknown_field/);
  assert.throws(() => validateEvent(lead({revision: 0}), 'funnel'), /invalid_revision/);
  assert.throws(() => validateEvent(lead({revision: 1.5}), 'funnel'), /invalid_revision/);
});
test('committed events and duplicate protection survive restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'crm-test-')), 'queue.sqlite');
  let store = new Store(path);
  const event = validateEvent(lead(), 'funnel');
  assert.equal(store.enqueue(event), true); store.close();
  store = new Store(path);
  assert.equal(store.enqueue(event), false);
  assert.throws(() => store.enqueue({...event, data:{...event.data, name:'Changed'}}), /event_conflict/);
  assert.throws(() => store.enqueue({...event, eventId:'other'}), /revision_conflict/);
  assert.equal(store.next().revision, 1); store.close();
});
test('full snapshots prevent stale event rollback after out-of-order delivery', async () => {
  const store = new Store(':memory:'), applied = [];
  store.enqueue(validateEvent(lead({revision:2, eventId:'v2'}), 'funnel'));
  store.enqueue(validateEvent(lead(), 'funnel'));
  const twenty = {apply:async e => applied.push(e.revision)};
  assert.equal(await processNext(store, twenty), 'applied');
  assert.equal(await processNext(store, twenty), 'stale');
  assert.deepEqual(applied, [2]); store.close();
});
test('API failure keeps event pending and schedules retry', async () => {
  const store = new Store(':memory:'); store.enqueue(validateEvent(lead(), 'funnel'));
  assert.equal(await processNext(store, {apply:async()=>{throw new Error('offline')}}), 'retry');
  assert.equal(store.next(), undefined);
  const row = store.next(Date.now()+5000);
  assert.equal(row.attempts, 1);
  assert.equal(row.state, 'pending'); store.close();
});
test('deterministic CRM IDs distinguish entity kinds', () => {
  assert.equal(recordUuid('lead', '1'), recordUuid('lead', '1'));
  assert.notEqual(recordUuid('lead', '1'), recordUuid('student', '1'));
});
test('retry after a committed create updates same CRM record without touching sales fields', async () => {
  const calls = [];
  const twenty = new Twenty('http://localhost:3033', 'test', async (url, options) => {
    calls.push({url, ...options});
    if (calls.length===1) return new Response('{}', {status:404});
    if (calls.length===2) return new Response('{}', {status:409});
    return new Response('{}', {status:200});
  });
  await twenty.apply(validateEvent(lead(), 'funnel'));
  assert.deepEqual(calls.map(c=>c.method), ['GET','POST','GET','PATCH']);
  const posted=JSON.parse(calls[1].body), patched=JSON.parse(calls[3].body);
  assert.equal(posted.id, recordUuid('lead','fl_test'));
  assert.equal(patched.externalId, 'fl_test');
  assert.equal('stage' in patched, false);
  assert.equal('notes' in patched, false);
});
test('publisher and real HTTP receiver persist once and reject tampering', async () => {
  const store = new Store(':memory:');
  const server=createReceiver(store,{funnel,lms}); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    await publishSnapshot({url,source:'funnel',secret:funnel,event:lead()});
    await publishSnapshot({url,source:'funnel',secret:funnel,event:lead()});
    assert.deepEqual(store.counts().map(r=>({...r})),[{state:'pending',count:1}]);
    await assert.rejects(publishSnapshot({url,source:'funnel',secret:lms,event:lead()}), /401/);
    await assert.rejects(publishSnapshot({url,source:'lms',secret:lms,event:lead()}), /403/);
    await assert.rejects(publishSnapshot({url,source:'funnel',secret:funnel,event:lead({data:{...lead().data,name:'conflict'}})}), /409/);
    const wrong=await fetch(`${url}/events/funnel`,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'});
    assert.equal(wrong.status,415);
    const stamp=String(Math.floor(Date.now()/1000));
    const malformed=await fetch(`${url}/events/funnel`,{method:'POST',headers:{'content-type':'application/json','x-crm-timestamp':stamp,'x-crm-signature':signature(funnel,stamp,'{')},body:'{'});
    assert.equal(malformed.status,400);
  } finally {await new Promise(resolve=>server.close(resolve)); store.close();}
});
