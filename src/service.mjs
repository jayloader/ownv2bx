import { performance } from 'node:perf_hooks';
import { buildXrayConfig } from './xray.mjs';

function interval(value, fallback) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600 ? seconds : fallback;
}

export class NodeService {
  #configSignature;
  #lastPull = -Infinity;
  #limitedUsers = 0;

  constructor({ settings, panel, core, ledger, sampleStatus, logger = console, now = () => performance.now() }) {
    this.settings = settings;
    this.panel = panel;
    this.core = core;
    this.ledger = ledger;
    this.sampleStatus = sampleStatus;
    this.logger = logger;
    this.now = now;
    this.pullInterval = settings.pullInterval;
    this.pushInterval = settings.pushInterval;
  }

  get staleDeadline() {
    if (!this.core.isRunning()) return Infinity;
    return this.#lastPull + Math.max(this.settings.staleAfter, this.pullInterval * 3) * 1000;
  }

  async pull() {
    // Wait for both requests to finish so a timeout does not overlap with the next pull.
    const results = await Promise.allSettled([this.panel.getConfig(), this.panel.getUsers()]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    const [node, users] = results.map((result) => result.value);
    this.pullInterval = interval(node.base_config?.pull_interval, this.settings.pullInterval);
    this.pushInterval = interval(node.base_config?.push_interval, this.settings.pushInterval);

    const activeUsers = users.filter((user) => !user.speed_limit && !user.device_limit);
    const limitedUsers = users.length - activeUsers.length;
    if (limitedUsers !== this.#limitedUsers) {
      this.logger.warn(`因启用限速或设备数限制而暂停授权的用户数为 ${limitedUsers}`);
      this.#limitedUsers = limitedUsers;
    }

    try {
      const config = buildXrayConfig(node, activeUsers, this.settings.xray);
      const signature = JSON.stringify(config);
      if (signature !== this.#configSignature || !this.core.isRunning()) {
        await this.core.replace(config, { beforeStop: () => this.#captureTraffic() });
        this.ledger.resetCounters();
        this.#configSignature = signature;
        this.logger.info(`Xray 已载入节点配置，授权用户 ${activeUsers.length} 人`);
      }
      this.#lastPull = this.now();
    } catch (error) {
      await this.stopCore();
      throw error;
    }
  }

  async #captureTraffic() {
    if (this.core.isRunning()) await this.ledger.collect(await this.core.snapshotTraffic());
  }

  async report() {
    try {
      await this.#captureTraffic();
    } catch (error) {
      this.logger.warn(error.message);
    }
    await this.ledger.flush((data) => this.panel.pushTraffic(data));
  }

  async reportStatus() {
    if (this.core.isRunning() && this.sampleStatus) {
      await this.panel.pushStatus(await this.sampleStatus());
    }
  }

  async enforceFreshness() {
    if (this.now() >= this.staleDeadline) {
      this.logger.warn('Xboard 授权信息已过期，正在停止 Xray');
      await this.stopCore();
    }
  }

  async stopCore() {
    try {
      await this.#captureTraffic();
    } catch (error) {
      this.logger.warn(error.message);
    }
    await this.core.stop();
    this.ledger.resetCounters();
    this.#configSignature = undefined;
  }
}
