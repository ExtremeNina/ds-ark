/**
 * 编队页的理智读数。
 *
 * 只解析、不推断：读不到就是 `null`，绝不用 0 顶替；够不够打由调用方拿着两个数字判断。
 */
import type { OcrLine } from '../mfw/ocr.ts';

export interface SanityReading {
  /** 本次进入要消耗的理智（「理智 -6」里的 6）。 */
  readonly required: number | null;
  /** 当前理智（「118/135」里的 118）。 */
  readonly current: number | null;
  /** 理智上限（「118/135」里的 135）。 */
  readonly max: number | null;
}

const SANITY_LABEL = /理智|SANITY/i;

export function parseSanity(lines: readonly OcrLine[]): SanityReading {
  let required: number | null = null;
  let current: number | null = null;
  let max: number | null = null;

  for (const line of lines) {
    const text = line.text.replace(/\s+/g, '');
    if (required === null && SANITY_LABEL.test(text)) {
      const matched = /理智[^\d]{0,6}(\d+)/.exec(text) ?? /SANITY[^\d]{0,6}(\d+)/i.exec(text);
      if (matched) required = Number(matched[1]);
    }
    if (current === null) {
      const ratio = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(text);
      if (ratio) {
        current = Number(ratio[1]);
        max = Number(ratio[2]);
      }
    }
  }

  return { required, current, max };
}

/** 给人/模型看的短句；读不到的项如实列出。 */
export function describeSanity(reading: SanityReading): string {
  const { required, current, max } = reading;
  if (required !== null && current !== null) {
    const times = required > 0 ? Math.floor(current / required) : null;
    return `理智 -${required}，当前 ${current}${max !== null ? `/${max}` : ''}`
      + (times !== null ? `（够打 ${times} 次）` : '');
  }
  if (required !== null) return `理智 -${required}，当前理智没读到`;
  if (current !== null) return `当前理智 ${current}${max !== null ? `/${max}` : ''}，这次消耗没读到`;
  return '理智没读到';
}

/** `true` 表示明确不够；`null` 表示读不全，不能据此放行。 */
export function sanityEnough(reading: SanityReading): boolean | null {
  if (reading.required === null || reading.current === null) return null;
  return reading.current >= reading.required;
}
