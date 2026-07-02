import { EventEmitter } from 'node:events';
import type { PlatformEvents, EventHandler } from './types.ts';

/** Thin EventEmitter wrapper. setMaxListeners(0) prevents Node's "leak warning"
 *  during dev (we'll have many subscribers — agent loop + WS clients + TUI). */
export function createNodeEvents(): PlatformEvents {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  return {
    emit<T>(channel: string, payload: T) {
      ee.emit(channel, payload);
    },
    on<T>(channel: string, handler: EventHandler<T>) {
      ee.on(channel, handler as (p: T) => void);
      return () => ee.off(channel, handler as (p: T) => void);
    },
    once<T>(channel: string, handler: EventHandler<T>) {
      ee.once(channel, handler as (p: T) => void);
      return () => ee.off(channel, handler as (p: T) => void);
    },
  };
}
