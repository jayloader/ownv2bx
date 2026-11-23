import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += Object.values(times).reduce((sum, time) => sum + time, 0);
  }
  return { idle, total };
}

async function swapUsage() {
  const text = process.platform === 'linux' ? await readFile('/proc/meminfo', 'utf8') : '';
  const total = Number(text.match(/^SwapTotal:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  const free = Number(text.match(/^SwapFree:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  return { total, used: Math.max(0, total - free) };
}

export function createStatusSampler(stateDir) {
  let previous = cpuTimes();
  return async () => {
    const [disk, swap] = await Promise.all([statfs(stateDir), swapUsage()]);
    const current = cpuTimes();
    const totalCpu = current.total - previous.total;
    const idle = current.idle - previous.idle;
    previous = current;
    const totalMemory = totalmem();
    return {
      cpu: totalCpu > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / totalCpu))) : 0,
      mem: { total: totalMemory, used: Math.max(0, totalMemory - freemem()) },
      swap,
      disk: { total: disk.blocks * disk.bsize, used: (disk.blocks - disk.bfree) * disk.bsize },
    };
  };
}
