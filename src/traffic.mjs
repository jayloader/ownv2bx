import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

function isByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseCounters(counters) {
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
    throw new Error('流量计数格式无效');
  }

  const result = new Map();
  for (const [id, counts] of Object.entries(counters)) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) ||
        !Array.isArray(counts) || counts.length !== 2 ||
        !isByteCount(counts[0]) || !isByteCount(counts[1])) {
      throw new Error('流量记录缺少有效的用户 ID 或字节数');
    }
    result.set(id, [...counts]);
  }
  return result;
}

function delta(current, previous) {
  return current >= previous ? current - previous : current;
}

export class TrafficLedger {
  #file;
  #scope;
  #pending = new Map();
  #counters = new Map();

  constructor({ file, scope }) {
    if (typeof scope !== 'string' || !scope) throw new Error('缺少流量队列所属节点');
    this.#file = file;
    this.#scope = scope;
  }

  async load() {
    await mkdir(dirname(this.#file), { mode: 0o700, recursive: true });
    let contents;
    try {
      contents = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    let state;
    try {
      state = JSON.parse(contents);
    } catch {
      throw new Error('本地流量队列包含无效 JSON');
    }
    if (state?.version !== 1) throw new Error('本地流量队列版本无效');
    if (state.scope !== this.#scope) throw new Error('本地流量队列属于另一个面板或节点');
    this.#pending = parseCounters(state.pending);
  }

  async #persist(pending) {
    const directory = dirname(this.#file);
    const temp = `${this.#file}.next-${randomUUID()}`;
    const contents = JSON.stringify({ version: 1, scope: this.#scope, pending: Object.fromEntries(pending) });
    const handle = await open(temp, 'wx', 0o600);
    let replaced = false;

    try {
      try {
        await handle.writeFile(`${contents}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#file);
      replaced = true;

      if (process.platform !== 'win32') {
        const parent = await open(directory, 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } finally {
      if (!replaced) await unlink(temp).catch(() => {});
    }
  }

  async collect(counters) {
    const current = parseCounters(counters);
    let pending;

    for (const [id, [up, down]] of current) {
      const [oldUp, oldDown] = this.#counters.get(id) ?? [0, 0];
      const upDelta = delta(up, oldUp);
      const downDelta = delta(down, oldDown);
      if (upDelta === 0 && downDelta === 0) continue;

      pending ??= new Map(this.#pending);
      const [queuedUp, queuedDown] = pending.get(id) ?? [0, 0];
      const newUp = queuedUp + upDelta;
      const newDown = queuedDown + downDelta;
      if (!Number.isSafeInteger(newUp) || !Number.isSafeInteger(newDown)) {
        throw new Error('待上报流量超过可精确保存的范围');
      }
      pending.set(id, [newUp, newDown]);
    }

    if (pending) {
      await this.#persist(pending);
      this.#pending = pending;
    }
    for (const [id, counts] of current) this.#counters.set(id, counts);
  }

  resetCounters() {
    this.#counters.clear();
  }

  async flush(send) {
    if (this.#pending.size === 0) return;
    const report = Object.fromEntries([...this.#pending].map(([id, counts]) => [id, [...counts]]));

    // UniProxy adds each report to usage and has no idempotency key. A lost acknowledgment can duplicate a retry.
    await send(report);
    const empty = new Map();
    await this.#persist(empty);
    this.#pending = empty;
  }
}
