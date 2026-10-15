import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export class ContractError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

export const definitions = {
  lead: {
    source: 'funnel', singular: 'platformLead', plural: 'platformLeads',
    labelSingular: 'Лид платформы', labelPlural: 'Лиды платформы',
    fields: ['funnelLeadId', 'platformUserId', 'telegramId', 'email', 'phone', 'source', 'offerSlug', 'leadStatus'],
  },
  order: {
    source: 'lms', singular: 'platformOrder', plural: 'platformOrders',
    labelSingular: 'Заказ платформы', labelPlural: 'Заказы платформы',
    fields: ['funnelLeadId', 'platformUserId', 'offerSlug', 'paymentStatus', 'currencyCode', 'amountMinor'],
  },
  student: {
    source: 'lms', singular: 'platformStudent', plural: 'platformStudents',
    labelSingular: 'Ученик платформы', labelPlural: 'Ученики платформы',
    fields: ['platformUserId', 'telegramId', 'email', 'phone', 'accessStatus'],
  },
};

function string(value, max = 300, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw new ContractError('invalid_string');
  }
  return value;
}

export function validateEvent(input, source) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContractError('invalid_event');
  const def = definitions[input.entity];
  if (!def || def.source !== source) throw new ContractError('source_not_allowed', 403);
  if (input.schemaVersion !== 1) throw new ContractError('unsupported_schema');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ContractError('invalid_revision');
  if (typeof input.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new ContractError('invalid_timestamp');
  }
  const data = input.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ContractError('invalid_data');
  if (Object.keys(data).some(k => !['name', ...def.fields].includes(k))) throw new ContractError('unknown_field');
  const snapshot = { name: string(data.name) };
  for (const field of def.fields) {
    if (field === 'amountMinor') {
      if (!Number.isSafeInteger(data[field]) || data[field] < 0) throw new ContractError('invalid_amount');
      snapshot[field] = data[field];
    } else snapshot[field] = string(data[field], 500, true);
  }
  if (input.entity === 'lead' && snapshot.funnelLeadId !== input.recordId) throw new ContractError('lead_id_mismatch');
  if (input.entity === 'student' && snapshot.platformUserId !== input.recordId) throw new ContractError('user_id_mismatch');
  if (input.entity === 'order' && (!['paid', 'refunded', 'partially_refunded', 'pending', 'cancelled'].includes(snapshot.paymentStatus) || !/^[A-Z]{3}$/.test(snapshot.currencyCode))) {
    throw new ContractError('invalid_order');
  }
  return {
    schemaVersion: 1, source, eventId: string(input.eventId, 160), entity: input.entity,
    recordId: string(input.recordId, 160), revision: input.revision,
    occurredAt: new Date(input.occurredAt).toISOString(), data: snapshot,
  };
}

export function signature(secret, timestamp, raw) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex')}`;
}

export function verifySignature(secret, timestamp, provided, raw, now = Date.now()) {
  if (!secret || !/^\d{10}$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300) {
    throw new ContractError('unauthorized', 401);
  }
  if (!/^sha256=[a-f0-9]{64}$/.test(provided ?? '')) throw new ContractError('unauthorized', 401);
  if (!timingSafeEqual(Buffer.from(signature(secret, timestamp, raw)), Buffer.from(provided))) {
    throw new ContractError('unauthorized', 401);
  }
}

export function recordUuid(entity, id) {
  const bytes = createHash('sha1').update(`serditov:crm:v1:${entity}:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
