import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettings } from '../src/config.mjs';
import { PanelClient } from '../src/panel.mjs';

const panel = {
  url: new URL('https://panel.example.com/prefix/'), token: 'test+token&value', nodeId: 'vless-node',
};
const uuid = '5eb0fa2f-4de8-4946-9de8-fcae222325af';

test('requests UniProxy config and users with independent ETags and encoded authentication', async () => {
  const client = new PanelClient({
    ...panel,
    fetchImpl: async (url, init) => {
      const endpoint = url.pathname.split('/').at(-1);
      assert.equal(url.pathname, `/prefix/api/v1/server/UniProxy/${endpoint}`);
      assert.equal(url.searchParams.get('token'), panel.token);
      assert.equal(url.searchParams.get('node_id'), panel.nodeId);
      assert.equal(url.searchParams.get('node_type'), 'vless');
      assert.equal(init.redirect, 'manual');
      const etag = `"${endpoint}-etag"`;
      if (init.headers.has('If-None-Match')) {
        assert.equal(init.headers.get('If-None-Match'), etag);
        return new Response(null, { status: 304 });
      }
      const data = endpoint === 'config' ? { protocol: 'vless' } : { users: [{ id: '7', uuid }] };
      return Response.json(data, { headers: { etag } });
    },
  });
  const config = await client.getConfig();
  const users = await client.getUsers();
  assert.deepEqual(config, { protocol: 'vless' });
  assert.deepEqual(users, [{ id: 7, uuid, speed_limit: 0, device_limit: 0 }]);
  assert.equal(await client.getConfig(), config);
  assert.equal(await client.getUsers(), users);
});

test('keeps traffic queued unless UniProxy acknowledges the exact JSON report', async () => {
  const traffic = { 7: [121, 442] };
  let attempts = 0;
  const client = new PanelClient({
    ...panel,
    fetchImpl: async (url, init) => {
      assert.ok(url.pathname.endsWith('/UniProxy/push'));
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.get('Content-Type'), 'application/json');
      assert.deepEqual(JSON.parse(init.body), traffic);
      return Response.json({ data: ++attempts === 2 });
    },
  });
  await assert.rejects(client.pushTraffic(traffic), /没有确认/);
  await client.pushTraffic(traffic);
});

test('rejects invalid user records and keeps request credentials out of errors', async () => {
  const client = new PanelClient({
    ...panel,
    fetchImpl: async () => Response.json({ users: [{ id: 7, uuid }, { id: 8, uuid }] }),
  });
  await assert.rejects(client.getUsers(), /重复/);
  const unavailable = new PanelClient({ ...panel, fetchImpl: async (url) => { throw new Error(url.href); } });
  await assert.rejects(unavailable.getUsers(), { message: 'Xboard user 请求失败或超时' });
});

test('settings require TLS by default and preserve a panel path prefix', () => {
  const env = { XBOARD_URL: 'https://panel.example.com/prefix///', XBOARD_TOKEN: 'test', XBOARD_NODE_ID: '12' };
  assert.equal(readSettings(env).panel.url.href, 'https://panel.example.com/prefix/');
  assert.throws(() => readSettings({ ...env, XBOARD_URL: 'http://panel.example.com' }), /HTTPS/);
  assert.throws(() => readSettings({ ...env, XRAY_CERT_FILE: './certificate.pem' }), /同时填写/);
});
