import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const dnsName = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const allowedChildEnvironment = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|XRAY_LOCATION_ASSET|XRAY\.LOCATION\.ASSET)$/i;

export class XrayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XrayConfigError';
  }
}

function portNumber(value) {
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new XrayConfigError('Xray ports must be single integers from 1 to 65535');
  }
  return port;
}

function hasSettings(value) {
  if (value == null) return false;
  return typeof value === 'object' ? Object.keys(value).length !== 0 : true;
}

function validateTransport(node) {
  if (node.protocol !== 'vless' || ![null, undefined, '', 'tcp', 'raw'].includes(node.network)) {
    throw new XrayConfigError('This backend requires a VLESS node with the TCP transport');
  }
  for (const networkSettings of [node.networkSettings, node.network_settings]) {
    if (!hasSettings(networkSettings)) continue;
    const { header, acceptProxyProtocol, ...other } = networkSettings;
    if (hasSettings(other) || (acceptProxyProtocol != null && acceptProxyProtocol !== false)
      || (header != null && (header.type !== 'none' || Object.keys(header).length !== 1))) {
      throw new XrayConfigError('This backend requires TCP without transport headers or PROXY protocol');
    }
  }
  if ((node.decryption != null && node.decryption !== '' && node.decryption !== 'none')
    || node.encryption?.enabled || node.multiplex?.enabled || node.tls_settings?.ech?.enabled
    || ['routes', 'custom_routes', 'custom_outbounds', 'cert_config'].some((key) => hasSettings(node[key]))) {
    throw new XrayConfigError('Disable Xboard custom routing, panel certificate delivery, ECH, VLESS Encryption, and multiplexing for this backend');
  }
}

function streamSettings(node, options) {
  switch (node.tls ?? 0) {
    case 0:
    case '0':
      if (options.allowPlaintext !== true || !['127.0.0.1', '::1'].includes(options.listen)) {
        throw new XrayConfigError('Plaintext VLESS requires explicit permission and a loopback listen address');
      }
      return { network: 'raw', security: 'none' };
    case 1:
    case '1':
      if (typeof options.certFile !== 'string' || !isAbsolute(options.certFile)
        || typeof options.keyFile !== 'string' || !isAbsolute(options.keyFile)) {
        throw new XrayConfigError('TLS requires absolute paths to the node certificate and private key');
      }
      return {
        network: 'raw',
        security: 'tls',
        tlsSettings: {
          minVersion: '1.2',
          certificates: [{ certificateFile: options.certFile, keyFile: options.keyFile }],
        },
      };
    case 2:
    case '2': {
      const { server_name: serverName, server_port: serverPort, private_key: privateKey, short_id: shortId }
        = node.tls_settings ?? {};
      if (typeof serverName !== 'string' || !dnsName.test(serverName) || isIP(serverName)
        || typeof privateKey !== 'string' || !/^[\w-]{43}$/.test(privateKey)
        || Buffer.from(privateKey, 'base64url').toString('base64url') !== privateKey
        || typeof shortId !== 'string' || !/^(?:[\da-f]{2}){1,8}$/i.test(shortId)) {
        throw new XrayConfigError('REALITY requires a target DNS name, a valid X25519 private key, and a nonempty even-length hex short ID');
      }
      const targetPort = portNumber(serverPort == null || serverPort === '' ? 443 : serverPort);
      return {
        network: 'raw',
        security: 'reality',
        realitySettings: {
          show: false,
          target: `${serverName}:${targetPort}`,
          serverNames: [serverName],
          privateKey,
          shortIds: [shortId.toLowerCase()],
        },
      };
    }
    default:
      throw new XrayConfigError('This backend supports Xboard TLS and REALITY security modes');
  }
}

export function buildXrayConfig(node, users, options) {
  validateTransport(node);
  const listen = options.listen ?? '0.0.0.0';
  const port = portNumber(node.server_port);
  const apiPort = portNumber(options.apiPort);
  if (!isIP(listen) || port === apiPort) {
    throw new XrayConfigError('Set an IP address for Xray and distinct inbound and statistics ports');
  }
  const stream = streamSettings(node, { ...options, listen });
  const flow = node.flow ?? '';
  if (!['', 'xtls-rprx-vision'].includes(flow) || (flow && stream.security === 'none')) {
    throw new XrayConfigError('Use the default VLESS flow or XTLS Vision with TLS or REALITY');
  }

  const ids = new Set();
  const credentials = new Set();
  const clients = users.map(({ id, uuid, speed_limit, device_limit }) => {
    if (!Number.isSafeInteger(id) || id < 1 || typeof uuid !== 'string' || !uuidPattern.test(uuid)) {
      throw new XrayConfigError('The panel returned an invalid Xray user ID or UUID');
    }
    if ((speed_limit ?? 0) !== 0 || (device_limit ?? 0) !== 0) {
      throw new XrayConfigError('Xray users must have unrestricted panel speed and device limits');
    }
    const credential = uuid.toLowerCase();
    if (ids.has(id) || credentials.has(credential)) {
      throw new XrayConfigError('The panel returned duplicate Xray user IDs or UUIDs');
    }
    ids.add(id);
    credentials.add(credential);
    return { id: credential, email: `xboard-${id}`, level: 0, flow };
  });

  return {
    log: { loglevel: 'warning', access: 'none' },
    api: { tag: 'xboard-stats', listen: `127.0.0.1:${apiPort}`, services: ['StatsService'] },
    stats: {},
    policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds: [{
      tag: 'xboard-vless', listen, port, protocol: 'vless',
      settings: { decryption: 'none', users: clients }, streamSettings: stream,
    }],
    // Xray v26.11.9's Freedom outbound blocks private and reserved addresses for VLESS.
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  };
}

export function parseTrafficSnapshot(output) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('Xray returned an invalid statistics response');
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)
    || (result.stat !== undefined && !Array.isArray(result.stat))) {
    throw new Error('Xray returned an invalid statistics response');
  }
  const traffic = {};
  for (const counter of result.stat ?? []) {
    const match = /^user>>>xboard-([1-9]\d*)>>>traffic>>>(uplink|downlink)$/.exec(counter?.name);
    if (!match) continue;
    const [, id, direction] = match;
    const raw = counter.value ?? 0;
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Xray returned an invalid user traffic counter');
    }
    traffic[id] ??= [0, 0];
    traffic[id][direction === 'uplink' ? 0 : 1] = value;
  }
  return traffic;
}

function ensurePortIsFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('The local Xray statistics port is already in use or unavailable')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}

function waitForInbound(inbound) {
  const host = { '0.0.0.0': '127.0.0.1', '::': '::1' }[inbound.listen] ?? inbound.listen;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: inbound.port, timeout: 1000 });
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('Xray inbound connection timed out')));
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
  });
}

export class XrayProcess {
  #env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedChildEnvironment.test(key)));
  #process;
  #transition = Promise.resolve();

  constructor({ binary, stateDir, apiPort, logger = console }) {
    this.binary = binary;
    this.stateDir = stateDir;
    this.apiPort = portNumber(apiPort);
    this.logger = logger;
  }

  isRunning() {
    return Boolean(this.#process?.ready && !this.#process.ended);
  }

  async #query(pattern, seconds) {
    try {
      const { stdout } = await runFile(this.binary, [
        'api', 'statsquery', `-server=127.0.0.1:${this.apiPort}`, `-timeout=${seconds}`, `-pattern=${pattern}`,
      ], { env: this.#env, timeout: (seconds + 1) * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      return parseTrafficSnapshot(stdout);
    } catch {
      throw new Error('Could not read the local Xray statistics API');
    }
  }

  async snapshotTraffic() {
    if (!this.isRunning()) return {};
    const process = this.#process;
    const traffic = await this.#query('user>>>xboard-', 3);
    if (this.#process !== process || process.ended) {
      throw new Error('Xray stopped while its statistics were being read');
    }
    return traffic;
  }

  #serialize(operation) {
    const result = this.#transition.then(operation);
    this.#transition = result.catch(() => {});
    return result;
  }

  replace(config, { beforeStop } = {}) {
    return this.#serialize(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const configPath = join(this.stateDir, `xray-${randomUUID()}.json`);
      try {
        await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
        try {
          await runFile(this.binary, ['run', '-test', '-c', configPath], {
            env: this.#env, timeout: 15000, windowsHide: true,
          });
        } catch (error) {
          if (error.code === 'ENOENT') throw new Error('The Xray executable could not be found');
          throw new Error('Xray rejected the generated config. Check the core version and TLS files if applicable');
        }
        if (this.isRunning()) await beforeStop?.();
        await this.#stop();
        await ensurePortIsFree(this.apiPort);
        await this.#start(configPath, config.inbounds[0]);
      } finally {
        await rm(configPath, { force: true });
      }
    });
  }

  async #start(configPath, inbound) {
    const child = spawn(this.binary, ['run', '-c', configPath], {
      env: this.#env, stdio: 'ignore', windowsHide: true,
    });
    const state = { child, ready: false, stopping: false, ended: false };
    this.#process = state;
    state.closed = new Promise((resolve) => {
      child.on('error', () => {});
      child.once('close', () => {
        state.ended = true;
        if (state.ready && !state.stopping) this.logger.warn?.('Xray exited unexpectedly');
        resolve(true);
      });
    });
    try {
      for (let attempt = 0; attempt < 5 && !state.ended; attempt += 1) {
        try {
          await this.#query('xboard-readiness-probe', 1);
          await waitForInbound(inbound);
        } catch {
          await delay(150);
          continue;
        }
        if (!state.ended) {
          state.ready = true;
          return;
        }
      }
      throw new Error('Xray failed to start its inbound and statistics API. Check the ports and TLS files if applicable');
    } catch (error) {
      await this.#stop();
      throw error;
    }
  }

  stop() {
    return this.#serialize(() => this.#stop());
  }

  async #stop() {
    const state = this.#process;
    if (!state) return;
    if (!state.ended) {
      state.stopping = true;
      state.child.kill('SIGTERM');
      if (!await Promise.race([state.closed, delay(5000, false, { ref: false })])) {
        state.child.kill('SIGKILL');
        if (!await Promise.race([state.closed, delay(2000, false, { ref: false })])) {
          throw new Error('Xray could not be stopped');
        }
      }
    }
    this.#process = undefined;
  }
}
