/// <reference types="node" />
/**
 * Trace ID generation for CLI runs.
 *
 * Same canonical format as the Worker (`tr_<16hex>`) so the same ID can flow
 * through audit_log rows, CI logs, and any future Worker correlation.
 */
import { randomBytes } from 'node:crypto';

export function generateTraceId(): string {
  return `tr_${randomBytes(8).toString('hex')}`;
}
