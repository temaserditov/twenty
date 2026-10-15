import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {createReceiver} from '../src/server.mjs';
import {Twenty} from '../src/twenty.mjs';
import {processNext} from '../src/worker.mjs';
import {publishSnapshot} from '../src/publish.mjs';
import {definitions, recordUuid} from '../src/contract.mjs';

const twenty = new Twenty(process.env.TWENTY_URL, process.env.TWENTY_TOKEN);
if (twenty.baseUrl !== 'http://localhost:3033') throw new Error('smoke_is_local_only');
const secrets = {funnel:process.env.CRM_FUNNEL_HMAC,lms:process.env.CRM_LMS_HMAC};
const store = new Store(':memory:');
const server = createReceiver(store,secrets);
server.listen(0, '127.0.0.1'); await once(server,'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const base = {schemaVersion:1, revision:1, occurredAt:'2026-10-15T00:00:00.000Z'};
const events = [
  {...base,eventId:'demo-lead-v1',entity:'lead',recordId:'fl_crm_demo_01',data:{name:'Тестовый лид · Serditov',funnelLeadId:'fl_crm_demo_01',platformUserId:'usr_crm_demo_01',email:'crm-demo@example.invalid',source:'LOCAL_TEST',offerSlug:'demo-offer'}},
  {...base,eventId:'demo-order-v1',entity:'order',recordId:'order_crm_demo_01',data:{name:'Тестовая покупка · Serditov',funnelLeadId:'fl_crm_demo_01',platformUserId:'usr_crm_demo_01',offerSlug:'demo-offer',paymentStatus:'paid',currencyCode:'RUB',amountMinor:10000}},
  {...base,eventId:'demo-student-v1',entity:'student',recordId:'usr_crm_demo_01',data:{name:'Тестовый ученик · Serditov',platformUserId:'usr_crm_demo_01',email:'crm-demo@example.invalid',accessStatus:'active'}},
];
try {
  for (const event of events) {
    const source=definitions[event.entity].source;
    await publishSnapshot({url,source,secret:secrets[source],event});
    await publishSnapshot({url,source,secret:secrets[source],event});
    assert.equal(await processNext(store,twenty),'applied',`apply ${event.entity}`);
    const response=await twenty.request(`${definitions[event.entity].plural}/${recordUuid(event.entity,event.recordId)}`);
    const record=response.data?.[definitions[event.entity].singular] ?? response.data ?? response;
    assert.equal(record.externalId,event.recordId);
    assert.equal(record.name,event.data.name);
    assert.equal(Number(record.platformRevision),1);
    console.log(`crm_smoke_ok ${event.entity}: signed HTTP → durable receiver → Twenty API → verified record; duplicate rejected`);
  }
  assert.equal(await processNext(store,twenty),'idle');
  assert.equal(store.counts().find(row=>row.state==='done').count,3);
  console.log('crm_smoke_passed 3 records, 6 deliveries, no duplicate queue entries');
} finally {await new Promise(resolve=>server.close(resolve));store.close();}
