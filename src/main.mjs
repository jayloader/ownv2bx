import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import packageInfo from '../package.json' with { type: 'json' };
import { readSettings } from './config.mjs';
import { PanelClient } from './panel.mjs';
import { NodeService } from './service.mjs';
import { createStatusSampler } from './status.mjs';
import { TrafficLedger } from './traffic.mjs';
import { XrayProcess } from './xray.mjs';

async function run(settings) {
  await mkdir(settings.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(settings.lockDir, { recursive: true, mode: 0o700 });
  const lockPath = join(settings.lockDir, 'node.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('节点锁已被占用，请检查是否有节点进程正在运行');
    throw error;
  });
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let service;
  try {
    await lock.writeFile(`${process.pid}\n`);
    const panel = new PanelClient(settings.panel);
    const core = new XrayProcess({
      binary: settings.xray.binary,
      apiPort: settings.xray.apiPort,
      stateDir: settings.stateDir,
      logger: console,
    });
    const ledger = new TrafficLedger({
      file: join(settings.stateDir, 'traffic.json'),
      scope: JSON.stringify([settings.panel.url.href, settings.panel.nodeId, 'vless']),
    });
    await ledger.load();
    service = new NodeService({
      settings, panel, core, ledger, sampleStatus: createStatusSampler(settings.stateDir),
    });

    let pullAt = 0;
    let pushAt = 0;
    while (!shutdown.signal.aborted) {
      await service.enforceFreshness();
      if (performance.now() >= pullAt) {
        await service.pull().catch((error) => console.warn(error.message));
        pullAt = performance.now() + service.pullInterval * 1000;
      }
      if (shutdown.signal.aborted) break;
      await service.enforceFreshness();
      if (performance.now() >= pushAt) {
        await Promise.allSettled([service.report(), service.reportStatus()]).then((results) => {
          for (const result of results) {
            if (result.status === 'rejected') console.warn(result.reason.message);
          }
        });
        pushAt = performance.now() + service.pushInterval * 1000;
      }
      const next = Math.min(pullAt, pushAt, service.staleDeadline);
      await delay(Math.max(1, next - performance.now()), undefined, { signal: shutdown.signal })
        .catch((error) => { if (error.name !== 'AbortError') throw error; });
    }
  } finally {
    try {
      if (service) await service.stopCore();
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await lock.close();
      await unlink(lockPath);
    }
  }
}

async function main(args) {
  if (args.length === 0) return run(readSettings());
  if (args.length === 1 && args[0] === '--version') {
    console.log(`ownv2bx ${packageInfo.version}`);
    return;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('用法：ownv2bx [--version | --check-config FILE]');
    return;
  }
  if (args.length === 2 && args[0] === '--check-config') {
    const contents = await readFile(args[1], 'utf8').catch(() => {
      throw new Error('无法读取配置文件');
    });
    readSettings(parseEnv(contents));
    console.log('配置格式有效');
    return;
  }
  throw new Error('参数无效，请使用 --help 查看用法');
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
