import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connect as connectTls } from 'node:tls';
import { promisify } from 'node:util';
import { buildXrayConfig, parseTrafficSnapshot, XrayConfigError, XrayProcess } from '../src/xray.mjs';

const uuid = 'dbc56fdf-145a-4356-aa7f-798eae71a118';
const users = [{ id: 31, uuid, speed_limit: 0, device_limit: 0 }];
const node = { protocol: 'vless', network: 'tcp', server_port: 443, tls: 1 };
const options = {
  listen: '127.0.0.1',
  apiPort: 10085,
  certFile: join(tmpdir(), 'test.crt'),
  keyFile: join(tmpdir(), 'test.key'),
};

test('builds a TLS listener with isolated read-only statistics and tracks IDs separately from UUIDs', () => {
  const config = buildXrayConfig({ ...node, flow: 'xtls-rprx-vision' }, users, options);
  assert.deepEqual(config.api, { tag: 'xboard-stats', listen: '127.0.0.1:10085', services: ['StatsService'] });
  assert.deepEqual(config.policy.levels[0], { statsUserUplink: true, statsUserDownlink: true });
  const [inbound] = config.inbounds;
  assert.deepEqual(inbound.settings.users, [{ id: uuid, email: 'xboard-31', level: 0, flow: 'xtls-rprx-vision' }]);
  assert.deepEqual(inbound.streamSettings.tlsSettings.certificates, [{ certificateFile: options.certFile, keyFile: options.keyFile }]);
  assert.equal(inbound.streamSettings.security, 'tls');
});

test('reads Xboard REALITY settings for a raw transport and defaults the fallback port to 443', () => {
  const privateKey = Buffer.alloc(32, 42).toString('base64url');
  const config = buildXrayConfig({
    ...node,
    tls: 2,
    networkSettings: { header: { type: 'none' } },
    tls_settings: { server_name: 'example.com', private_key: privateKey, short_id: '12AB' },
  }, users, options);
  assert.deepEqual(config.inbounds[0].streamSettings, {
    network: 'raw', security: 'reality',
    realitySettings: {
      show: false, target: 'example.com:443', serverNames: ['example.com'], privateKey, shortIds: ['12ab'],
    },
  });
});

test('rejects unsupported or ambiguous panel configurations before touching Xray', () => {
  const rejected = [
    [{ ...node, protocol: 'trojan' }, users, options],
    [{ ...node, network: 'ws' }, users, options],
    [{ ...node, networkSettings: { acceptProxyProtocol: true } }, users, options],
    [{ ...node, routes: [{ action: 'block' }] }, users, options],
    [{ ...node, decryption: 'PANEL-SECRET' }, users, options],
    [{ ...node, tls: 0 }, users, options],
    [{ ...node, tls: 0 }, users, { ...options, listen: '0.0.0.0', allowPlaintext: true }],
    [node, users, { ...options, apiPort: node.server_port }],
    [node, [...users, { ...users[0], id: 32 }], options],
    [node, [{ ...users[0], device_limit: 1 }], options],
  ];
  for (const args of rejected) {
    assert.throws(() => buildXrayConfig(...args), (error) => {
      assert.ok(error instanceof XrayConfigError);
      assert.doesNotMatch(error.message, /PANEL-SECRET/);
      return true;
    });
  }
  const local = buildXrayConfig({ ...node, tls: 0 }, [], { ...options, allowPlaintext: true });
  assert.equal(local.inbounds[0].streamSettings.security, 'none');
  assert.deepEqual(local.inbounds[0].settings.users, []);
});

test('reads Xray cumulative byte counters from numbers and int64 strings', () => {
  assert.deepEqual(parseTrafficSnapshot('{}'), {});
  assert.deepEqual(parseTrafficSnapshot(JSON.stringify({ stat: [
    { name: 'user>>>xboard-31>>>traffic>>>uplink', value: '1234' },
    { name: 'user>>>xboard-31>>>traffic>>>downlink', value: 1421 },
    { name: 'user>>>xboard-32>>>traffic>>>downlink' },
    { name: 'outbound>>>direct>>>traffic>>>downlink', value: 101 },
  ] })), { 31: [1234, 1421], 32: [0, 0] });
  assert.throws(() => parseTrafficSnapshot('{bad-json'));
  assert.throws(() => parseTrafficSnapshot('{"stat":[{"name":"user>>>xboard-31>>>traffic>>>uplink","value":"9007199254740992"}]}'));
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

const testBinary = process.env.XRAY_TEST_BIN;
test('real Xray serves TLS and REALITY, enforces outbound rules, and captures traffic across core replacement', {
  skip: !testBinary && 'Set XRAY_TEST_BIN to an official Xray executable',
  timeout: 35000,
}, async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ownv2bx-test-'));
  const cert = join(stateDir, 'cert');
  const runFile = promisify(execFile);
  await runFile(testBinary, ['tls', 'cert', '-file', cert, '-name', 'localhost', '-domain', 'localhost']);
  const listeners = [createServer(), createServer()];
  const [port, apiPort] = await Promise.all(listeners.map(listen));
  await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));

  const core = new XrayProcess({ binary: testBinary, stateDir, apiPort });
  const blocked = createServer((socket) => {
    reachedPrivateDestination = true;
    socket.destroy();
  });
  let reachedPrivateDestination = false;
  const blockedPort = await listen(blocked);
  context.after(async () => {
    await core.stop();
    await new Promise((resolve) => blocked.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });

  const config = buildXrayConfig({ ...node, server_port: port }, users, {
    ...options, apiPort, certFile: `${cert}.crt`, keyFile: `${cert}.key`,
  });
  await core.replace(config);
  assert.equal(core.isRunning(), true);
  assert.deepEqual(await core.snapshotTraffic(), {});

  const socket = connectTls({ host: '127.0.0.1', port, servername: 'localhost', ca: await readFile(`${cert}.crt`) });
  socket.on('error', () => {});
  try {
    await once(socket, 'secureConnect');
    const packet = Buffer.alloc(26);
    Buffer.from(uuid.replaceAll('-', ''), 'hex').copy(packet, 1);
    packet[18] = 1;
    packet.writeUInt16BE(blockedPort, 19);
    packet.set([1, 127, 0, 0, 1], 21);
    socket.write(Buffer.concat([packet, Buffer.alloc(2048, 97)]));
    let captured;
    for (let attempt = 0; attempt < 12 && !captured?.[31]?.[0]; attempt += 1) {
      await delay(100);
      captured = await core.snapshotTraffic();
    }
    assert.deepEqual(captured, { 31: [2048, 0] });
    assert.equal(reachedPrivateDestination, false);
    await assert.rejects(core.replace({ ...config, outbounds: [{ protocol: 'unsupported' }] }), /rejected/);
    assert.deepEqual(await core.snapshotTraffic(), captured);
    let checkpoint;
    await core.replace(config, { beforeStop: async () => { checkpoint = await core.snapshotTraffic(); } });
    assert.deepEqual(checkpoint, captured);
    assert.deepEqual(await core.snapshotTraffic(), {});
    assert.equal((await readdir(stateDir)).some((name) => name.startsWith('xray-')), false);
  } finally {
    socket.destroy();
  }
  const reality = buildXrayConfig({
    ...node,
    server_port: port,
    tls: 2,
    flow: 'xtls-rprx-vision',
    tls_settings: {
      server_name: 'example.com',
      private_key: Buffer.alloc(32, 42).toString('base64url'),
      short_id: '12ab',
    },
  }, users, { ...options, apiPort });
  await core.replace(reality);
  assert.equal(core.isRunning(), true);
  await core.stop();
  assert.equal(core.isRunning(), false);
});
