const apiPath = 'api/v1/server/UniProxy/';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const userLimitKeys = ['speed_limit', 'device_limit'];

function parseInteger(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseUsers(payload) {
  if (!Array.isArray(payload?.users)) throw new Error('Xboard 用户列表格式无效');
  const ids = new Set();
  const credentials = new Set();
  const users = [];

  for (const row of payload.users) {
    if (!isRecord(row)) throw new Error('Xboard 用户记录格式无效');
    const id = parseInteger(row.id);
    const uuid = row.uuid;
    if (!Number.isSafeInteger(id) || id < 1 || typeof uuid !== 'string' || !uuidPattern.test(uuid)) {
      throw new Error('Xboard 用户记录缺少有效 ID 或 UUID');
    }
    const normalizedUuid = uuid.toLowerCase();
    if (ids.has(id) || credentials.has(normalizedUuid)) throw new Error('Xboard 用户 ID 或 UUID 重复');
    ids.add(id);
    credentials.add(normalizedUuid);

    const user = { id, uuid: normalizedUuid };
    for (const key of userLimitKeys) {
      const value = parseInteger(row[key] ?? 0);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Xboard 用户的 ${key} 无效`);
      user[key] = value;
    }
    users.push(user);
  }
  return users.sort((a, b) => a.id - b.id);
}

async function readJson(response, endpoint) {
  try {
    return await response.json();
  } catch {
    throw new Error(`Xboard ${endpoint} 返回了无效 JSON`);
  }
}

export class PanelClient {
  #cache = new Map();

  constructor({ url, token, nodeId, timeoutMs = 10_000, fetchImpl = fetch }) {
    this.url = url;
    this.token = token;
    this.nodeId = nodeId;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #request(endpoint, { etag, data } = {}) {
    const url = new URL(apiPath + endpoint, this.url);
    url.searchParams.set('node_id', this.nodeId);
    url.searchParams.set('node_type', 'vless');
    // Older UniProxy middleware reads the token from request input.
    url.searchParams.set('token', this.token);

    const headers = new Headers({ Accept: 'application/json' });
    if (etag) headers.set('If-None-Match', etag);
    if (data !== undefined) headers.set('Content-Type', 'application/json');

    let response;
    try {
      response = await this.fetch(url, {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
        cache: 'no-store',
      });
    } catch {
      throw new Error(`Xboard ${endpoint} 请求失败或超时`);
    }
    if (response.status === 304 && etag) return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Xboard ${endpoint} 返回 HTTP ${response.status}`);
    }
    return response;
  }

  async #get(endpoint, validate) {
    const cached = this.#cache.get(endpoint);
    const response = await this.#request(endpoint, { etag: cached?.etag });
    if (response.status === 304) return cached.data;
    const data = validate(await readJson(response, endpoint));
    this.#cache.set(endpoint, { data, etag: response.headers.get('etag') });
    return data;
  }

  getConfig() {
    return this.#get('config', (data) => {
      if (!isRecord(data)) throw new Error('Xboard 节点配置格式无效');
      return data;
    });
  }

  getUsers() {
    return this.#get('user', parseUsers);
  }

  async #post(endpoint, data) {
    const response = await this.#request(endpoint, { data });
    const payload = await readJson(response, endpoint);
    if (payload?.data !== true) throw new Error(`Xboard 没有确认 ${endpoint} 上报`);
  }

  pushTraffic(data) {
    return this.#post('push', data);
  }

  pushStatus(data) {
    return this.#post('status', data);
  }
}
