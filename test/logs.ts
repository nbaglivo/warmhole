import type { LogRecord } from '@logtape/logtape'
import { setupLogging } from '../src/logging.ts'

export type CapturedLogs = {
  records: LogRecord[]
  lines(category: string): string[]
}

export async function captureLogs(): Promise<CapturedLogs> {
  const records: LogRecord[] = []
  await setupLogging((record) => records.push(record))
  return {
    records,
    lines: (category) =>
      records.filter((r) => r.category.join('.') === category).map((r) => r.message.map(String).join('')),
  }
}
