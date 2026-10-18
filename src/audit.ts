// 审计日志:每次运行一个 JSONL 文件,每轮决策(模型说了什么、调了什么工具、
// 返回了什么)追加一行——面试可展示「决策可回放」。
//
// JSONL 而非单 JSON:append-only,写崩也不损已有行;逐行可 grep。
// key 安全:审计只记模型消息与工具结果,GLM_API_KEY 只存在于 fetch 头里,
// 永远进不了日志。

import { appendFileSync, mkdirSync } from 'node:fs';
import * as nodePath from 'node:path';

export class AuditLog {
  readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  static start(auditDir: string, meta: Record<string, unknown>): AuditLog {
    mkdirSync(auditDir, { recursive: true });
    // 毫秒 + 随机后缀:同一秒内连跑多次也绝不共享一个文件(E2E 一次跑 5 个 run,秒级时间戳必撞)
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 6);
    const log = new AuditLog(nodePath.join(auditDir, `run-${ts}-${rand}.jsonl`));
    log.write({ type: 'run_start', time: new Date().toISOString(), ...meta });
    return log;
  }

  write(entry: Record<string, unknown>): void {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
