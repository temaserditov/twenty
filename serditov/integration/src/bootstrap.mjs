import { Twenty } from './twenty.mjs';
import { definitions } from './contract.mjs';

const labels = {
  externalId: 'ID в платформе', platformRevision: 'Версия данных', lastEventAt: 'Обновлено в платформе',
  leadStatus: 'Статус воронки',
  funnelLeadId: 'ID лида', platformUserId: 'ID ученика', telegramId: 'Telegram ID',
  email: 'Email', phone: 'Телефон', source: 'Источник', offerSlug: 'Предложение',
  paymentStatus: 'Статус оплаты', currencyCode: 'Валюта', amountMinor: 'Сумма в копейках', accessStatus: 'Состояние доступа',
};
function objectFrom(response) { return response.data?.createOneObject ?? response.data?.object ?? response.data ?? response; }

export async function bootstrap(twenty) {
  const existing = [];
  let cursor;
  do {
    const response = await twenty.request(`metadata/objects?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`);
    existing.push(...(Array.isArray(response.data) ? response.data : response.data.objects));
    cursor = response.pageInfo?.hasNextPage ? response.pageInfo.endCursor : undefined;
  } while (cursor);
  for (const def of Object.values(definitions)) {
    let object = existing.find(o => o.nameSingular === def.singular);
    if (!object) object = objectFrom(await twenty.request('metadata/objects', 'POST', {
      nameSingular: def.singular, namePlural: def.plural, labelSingular: def.labelSingular,
      labelPlural: def.labelPlural, icon: 'IconSchool', isLabelSyncedWithName: false,
      description: 'Данные Serditov Platform. Оплаты и доступы изменяются в LMS.',
    }));
    const response = await twenty.request(`metadata/objects/${object.id}`);
    const fields = objectFrom(response).fields;
    const known = new Set((Array.isArray(fields) ? fields : fields?.edges?.map(e => e.node) ?? []).map(f => f.name));
    for (const name of ['externalId', 'platformRevision', 'lastEventAt', ...def.fields]) {
      if (known.has(name)) continue;
      try { await twenty.request('metadata/fields', 'POST', {
        objectMetadataId: object.id, name, label: labels[name],
        type: ['platformRevision', 'amountMinor'].includes(name) ? 'NUMBER' : name === 'lastEventAt' ? 'DATE_TIME' : 'TEXT',
        isNullable: true, ...(name === 'externalId' ? {isUnique: true} : {}),
      }); } catch(error) { throw new Error(`crm_schema_field_failed ${def.singular}.${name}`, {cause: error}); }
    }
    console.log(`crm_schema_ready ${def.singular}`);
  }
}

if (process.argv[1]?.endsWith('/src/bootstrap.mjs')) {
  await bootstrap(new Twenty(process.env.TWENTY_URL, process.env.TWENTY_TOKEN));
}
