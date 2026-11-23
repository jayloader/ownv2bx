import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeService } from '../src/service.mjs';

const user = { id: 1, uuid: '5eb0fa2f-4de8-4946-9de8-fcae222325af' };

function fixture() {
  const events = [];
  const state = {
    now: 0, running: false, unavailable: false, users: [user],
    node: { protocol: 'vless', server_port: 23456, network: 'tcp', tls: 0 },
  };
  const service = new NodeService({
    settings: {
      pullInterval: 10, pushInterval: 10, staleAfter: 30,
      xray: { listen: '127.0.0.1', apiPort: 10085, allowPlaintext: true },
    },
    panel: {
      getConfig: async () => {
        if (state.unavailable) throw new Error('panel offline');
        return state.node;
      },
      getUsers: async () => state.users,
    },
    core: {
      isRunning: () => state.running,
      snapshotTraffic: async () => ({ 1: [1, 2] }),
      replace: async (config, { beforeStop }) => {
        if (state.running) await beforeStop();
        events.push(['replace', config.inbounds[0].settings.users.map((item) => item.id)]);
        state.running = true;
      },
      stop: async () => { events.push(['stop']); state.running = false; },
    },
    ledger: {
      collect: async (traffic) => events.push(['collect', traffic]),
      resetCounters: () => events.push(['reset']),
    },
    logger: { info() {}, warn() {} },
    now: () => state.now,
  });
  return { service, state, events };
}

test('unchanged state leaves Xray running and new restrictions revoke existing access', async () => {
  const { service, state, events } = fixture();
  await service.pull();
  await service.pull();
  state.users = [{ ...user, device_limit: 1 }];
  await service.pull();
  assert.deepEqual(events, [
    ['replace', [user.uuid]], ['reset'], ['collect', { 1: [1, 2] }], ['replace', []], ['reset'],
  ]);
});

test('stops stale authorization on a panel outage and starts again on recovery', async () => {
  const { service, state, events } = fixture();
  await service.pull();
  state.unavailable = true;
  await assert.rejects(service.pull(), /panel offline/);
  state.now = 29_999;
  await service.enforceFreshness();
  assert.equal(state.running, true);
  state.now += 1;
  await service.enforceFreshness();
  assert.equal(state.running, false);
  assert.deepEqual(events.slice(-3), [['collect', { 1: [1, 2] }], ['stop'], ['reset']]);
  state.unavailable = false;
  await service.pull();
  assert.equal(state.running, true);
});

test('stops an active node when the panel enables unsupported transport', async () => {
  const { service, state } = fixture();
  await service.pull();
  state.node.network = 'ws';
  await assert.rejects(service.pull(), /TCP/);
  assert.equal(state.running, false);
});
