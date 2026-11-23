import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readSettings } from './config.mjs';
import { PanelClient } from './panel.mjs';
import { NodeService } from './service.mjs';
import { createStatusSampler } from './status.mjs';
import { TrafficLedger } from './traffic.mjs';
import { XrayProcess } from './xray.mjs';

async function run() {
  const settings = readSettings();
  await mkdir(settings.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(settings.stateDir, 'node.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('STATE_DIR 已被使用，请检查是否有节点进程正在运行');
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

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
