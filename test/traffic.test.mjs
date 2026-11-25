import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { TrafficLedger } from '../src/traffic.mjs';

const scope = 'https://example.test/|5';

async function useLedger(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xbray-traffic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state', 'traffic.json');
  const ledger = new TrafficLedger({ file, scope });
  await ledger.load();
  return { file, ledger };
}

test('queues per-user byte deltas across snapshots and an Xray restart', async (t) => {
  const { file, ledger } = await useLedger(t);
  await ledger.collect({ 5: [0, 0] });
  await ledger.flush(() => assert.fail('zero traffic must not be reported'));
  await assert.rejects(stat(file), { code: 'ENOENT' });

  await ledger.collect({ 5: [10, 20], 42: [2, 0] });
  await ledger.collect({ 5: [10, 20] });
  await ledger.collect({ 5: [13, 24], 42: [4, 1] });
  ledger.resetCounters();
  await ledger.collect({ 5: [2, 3] });
  await ledger.flush(async (report) => assert.deepEqual(report, { 5: [15, 27], 42: [4, 1] }));

  await ledger.collect({ 5: [1, 5] });
  await ledger.flush(async (report) => assert.deepEqual(report, { 5: [1, 2] }));
  await ledger.flush(() => assert.fail('acknowledged traffic must not be reported again'));

  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('persists rejected reports for a restart and clears only after acknowledgment', async (t) => {
  const { file, ledger } = await useLedger(t);
  await ledger.collect({ 5: [10, 20] });
  await assert.rejects(ledger.flush(async () => { throw new Error('network down'); }), /network down/);

  const restarted = new TrafficLedger({ file, scope });
  await restarted.load();
  await restarted.collect({ 5: [7, 1], 42: [0, 5] });
  await restarted.flush(async (report) => assert.deepEqual(report, { 5: [17, 21], 42: [0, 5] }));

  const reloaded = new TrafficLedger({ file, scope });
  await reloaded.load();
  await reloaded.flush(() => assert.fail('empty queue must survive a restart'));
});

test('keeps the cumulative baseline when a queue write fails', async (t) => {
  const { file, ledger } = await useLedger(t);
  await ledger.collect({ 5: [4, 6] });
  const directory = dirname(file);
  const moved = `${directory}-moved`;

  await rename(directory, moved);
  try {
    await assert.rejects(ledger.collect({ 5: [8, 12] }), { code: 'ENOENT' });
  } finally {
    await rename(moved, directory);
  }

  await ledger.collect({ 5: [10, 15] });
  await ledger.flush(async (report) => assert.deepEqual(report, { 5: [10, 15] }));
});

test('rejects malformed or mismatched saved queues without overwriting them', async (t) => {
  const { file, ledger } = await useLedger(t);
  await assert.rejects(ledger.collect({ 5: [1, -1] }), /字节数/);
  await ledger.collect({ 5: [10, 20] });
  const original = await readFile(file, 'utf8');

  const other = new TrafficLedger({ file, scope: 'https://example.test/|6' });
  await assert.rejects(other.load(), /另一个面板或节点/);
  assert.equal(await readFile(file, 'utf8'), original);

  const invalid = JSON.stringify({ version: 1, scope, pending: { 5: [1, '2'] } });
  await writeFile(file, invalid);
  const corrupt = new TrafficLedger({ file, scope });
  await assert.rejects(corrupt.load(), /字节数/);
  assert.equal(await readFile(file, 'utf8'), invalid);
});
