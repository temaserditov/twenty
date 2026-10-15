import { definitions, recordUuid } from './contract.mjs';

export class ApiError extends Error {
  constructor(status) { super(`twenty_http_${status}`); this.status = status; }
}

export class Twenty {
  constructor(baseUrl, token, fetcher = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', 'server'].includes(url.hostname)) {
      throw new Error('twenty_requires_https');
    }
    if (!token) throw new Error('twenty_token_required');
    this.baseUrl = url.origin;
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(path, method = 'GET', body) {
    const response = await this.fetcher(`${this.baseUrl}/rest/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${typeof this.token === 'function' ? await this.token() : this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ApiError(response.status);
    return response.status === 204 ? null : response.json();
  }
  async apply(event) {
    const { plural } = definitions[event.entity];
    const id = recordUuid(event.entity, event.recordId);
    const body = { ...event.data, externalId: event.recordId, platformRevision: event.revision, lastEventAt: event.occurredAt };
    // Only integration-owned fields are patched. Sales notes and stages stay in CRM.
    try {
      await this.request(`${plural}/${id}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await this.request(plural, 'POST', { id, ...body });
        return;
      } catch (createError) {
        // A timed-out create may already have committed. Read before retrying.
        if (![400, 409].includes(createError.status)) throw createError;
        await this.request(`${plural}/${id}`);
      }
    }
    await this.request(`${plural}/${id}`, 'PATCH', body);
  }
}
