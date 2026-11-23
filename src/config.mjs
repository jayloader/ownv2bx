import { isIP } from 'node:net';
import { resolve } from 'node:path';

function flag(env, name) {
  const value = env[name] || '0';
  if (value !== '0' && value !== '1') throw new Error(`${name} 必须是 0 或 1`);
  return value === '1';
}

function integer(env, name, fallback, min, max) {
  const value = env[name] || `${fallback}`;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
  }
  return number;
}

function panelUrl(raw, allowHttp) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('XBOARD_URL 必须是完整的面板地址');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('XBOARD_URL 必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('XBOARD_URL 不能包含凭证、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}

export function readSettings(env = process.env) {
  const url = panelUrl(env.XBOARD_URL, flag(env, 'ALLOW_HTTP_PANEL'));
  const token = env.XBOARD_TOKEN?.trim();
  const nodeId = env.XBOARD_NODE_ID?.trim();
  if (!token) throw new Error('缺少 XBOARD_TOKEN');
  if (!nodeId) throw new Error('缺少 XBOARD_NODE_ID');

  const listen = env.XRAY_LISTEN || '0.0.0.0';
  if (!isIP(listen)) throw new Error('XRAY_LISTEN 必须是 IP 地址');
  const certFile = env.XRAY_CERT_FILE && resolve(env.XRAY_CERT_FILE);
  const keyFile = env.XRAY_KEY_FILE && resolve(env.XRAY_KEY_FILE);
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('XRAY_CERT_FILE 和 XRAY_KEY_FILE 必须同时填写');
  }
  const stateDir = resolve(env.STATE_DIR || './state');

  return {
    panel: { url, token, nodeId },
    xray: {
      binary: env.XRAY_BIN || 'xray',
      listen,
      apiPort: integer(env, 'XRAY_API_PORT', 10085, 1, 65535),
      allowPlaintext: flag(env, 'ALLOW_PLAINTEXT_NODE'),
      certFile,
      keyFile,
    },
    stateDir,
    lockDir: env.NODE_LOCK_DIR ? resolve(env.NODE_LOCK_DIR) : stateDir,
    pullInterval: integer(env, 'PULL_INTERVAL', 60, 5, 3600),
    pushInterval: integer(env, 'PUSH_INTERVAL', 60, 5, 3600),
    staleAfter: integer(env, 'STALE_AFTER', 900, 30, 86400),
  };
}
