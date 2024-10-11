import { EditorSelection, SelectionRange, Line, findClusterBreak } from "@/state/index";

/** 处理文本方向的工具 */

/** 文本方向的枚举 */
export enum Direction {
  LTR = 0,

  RTL = 1,
}

const LTR = Direction.LTR;
const RTL = Direction.RTL;

/** 用于字符类型的代码 */
const enum T {
  /** 左到右 */
  L = 1,
  /** 右到左 */
  R = 2,
  /** 阿拉伯语的右到左 */
  AL = 4,
  /** 欧洲数字 */
  EN = 8,
  /** 阿拉伯数字 */
  AN = 16,
  /** 欧洲数字的终结符号 */
  ET = 64,
  /** 常用数字的分割符号 */
  CS = 128,
  /** Neutral or Isolate (BN, N, WS), */
  NI = 256,
  /** 无间距标记 */
  NSM = 512,
  Strong = T.L | T.R | T.AL,
  Num = T.EN | T.AN,
}

/**
 * 解码每个类型编码为 log2(type) 的字符串
 * @param str
 * @returns
 */
function dec(str: string): readonly T[] {
  const result = [];
  for (let i = 0; i < str.length; i++) {
    result.push(1 << +str[i]);
  }

  return result;
}

/** 代码点 0 到 0xf8 的字符类型 */
const LowTypes = dec(
  "88888888888888888888888888888888888666888888787833333333337888888000000000000000000000000008888880000000000000000000000000088888888888888888888888888888888888887866668888088888663380888308888800000000000000000000000800000000000000000000000000000008"
);

/** 代码点 0x600 到 0x6f9 的字符类型 */
const ArabicTypes = dec(
  "4444448826627288999999999992222222222222222222222222222222222222222222222229999999999999999999994444444444644222822222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222999999949999999229989999223333333333"
);

const Brackets = Object.create(null);
const BracketStack: number[] = [];

/**
 * https://www.unicode.org/Public/UCD/latest/ucd/BidiBrackets.txt 中还有更多内容，为了减少代码大小而省略了这些内容
 */
for (const p of ["()", "[]", "{}"]) {
  const l = p.charCodeAt(0);
  const r = p.charCodeAt(1);

  Brackets[l] = r;
  Brackets[r] = -l;
}

// Tracks direction in and before bracketed ranges.
const enum Bracketed {
  OppositeBefore = 1,
  EmbedInside = 2,
  OppositeInside = 4,
  MaxDepth = 3 * 63,
}

/**
 *
 * 检查字符类型，并返回语种方向和 ?
 * @param ch
 * @returns
 */
function charType(ch: number) {
  return ch <= 0xf7
    ? LowTypes[ch]
    : 0x590 <= ch && ch <= 0x5f4
    ? T.R
    : 0x600 <= ch && ch <= 0x6f9
    ? ArabicTypes[ch - 0x600]
    : 0x6ee <= ch && ch <= 0x8ac
    ? T.AL
    : 0x2000 <= ch && ch <= 0x200c
    ? T.NI
    : 0xfb50 <= ch && ch <= 0xfdff
    ? T.AL
    : T.L;
}

const BidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac\ufb50-\ufdff]/;

/** 表示具有单一方向（如从左到右或从右到左）的连续文本范围 */
export class BidiSpan {
  /** 文本方向，左到右或右到左 */
  get dir(): Direction {
    return this.level % 2 ? RTL : LTR;
  }

  constructor(
    /** 起点，相对于当前行的起点 */
    readonly from: number,
    /** 重点 */
    readonly to: number,
    /**
     * The ["bidi level"](https://unicode.org/reports/tr9/#Basic_Display_Algorithm) of the span (in this context, 0 means left-to-right,
     * 1 means right-to-left, 2 means left-to-right number inside right-to-left text).
     * */
    readonly level: number
  ) {}

  side(end: boolean, dir: Direction) {
    return (this.dir == dir) == end ? this.to : this.from;
  }

  forward(forward: boolean, dir: Direction) {
    return forward == (this.dir == dir);
  }

  static find(order: readonly BidiSpan[], index: number, level: number, assoc: number) {
    let maybe = -1;

    for (let i = 0; i < order.length; i++) {
      const span = order[i];
      if (span.from <= index && span.to >= index) {
        if (span.level == level) {
          return i;
        }

        /**
         * When multiple spans match, if assoc != 0, take the one that covers that side, otherwise take the one with the minimum level.
         * */
        if (
          maybe < 0 ||
          (assoc != 0
            ? assoc < 0
              ? span.from < index
              : span.to > index
            : order[maybe].level > span.level)
        ) {
          maybe = i;
        }
      }
    }

    if (maybe < 0) {
      throw new RangeError("Index out of range");
    }

    return maybe;
  }
}

/**
 * Arrays of isolates are always sorted by position. Isolates are never empty. Nested isolates don't stick out of their parent.
 * */
export type Isolate = { from: number; to: number; direction: Direction; inner: readonly Isolate[] };

export function isolatesEq(a: readonly Isolate[], b: readonly Isolate[]) {
  if (a.length != b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    const iA = a[i];
    const iB = b[i];

    if (
      iA.from != iB.from ||
      iA.to != iB.to ||
      iA.direction != iB.direction ||
      !isolatesEq(iA.inner, iB.inner)
    ) {
      return false;
    }
  }

  return true;
}

// Reused array of character types
const types: T[] = [];

// Fill in the character types (in `types`) from `from` to `to` and
// apply W normalization rules.
function computeCharTypes(
  line: string,
  rFrom: number,
  rTo: number,
  isolates: readonly Isolate[],
  outerType: T
) {
  for (let iI = 0; iI <= isolates.length; iI++) {
    const from = iI ? isolates[iI - 1].to : rFrom;
    const to = iI < isolates.length ? isolates[iI].from : rTo;
    const prevType = iI ? T.NI : outerType;

    // W1. Examine each non-spacing mark (NSM) in the level run, and
    // change the type of the NSM to the type of the previous
    // character. If the NSM is at the start of the level run, it will
    // get the type of sor.
    // W2. Search backwards from each instance of a European number
    // until the first strong type (R, L, AL, or sor) is found. If an
    // AL is found, change the type of the European number to Arabic
    // number.
    // W3. Change all ALs to R.
    // (Left after this: L, R, EN, AN, ET, CS, NI)
    for (let i = from, prev = prevType, prevStrong = prevType; i < to; i++) {
      let type = charType(line.charCodeAt(i));

      if (type == T.NSM) {
        type = prev;
      } else if (type == T.EN && prevStrong == T.AL) {
        type = T.AN;
      }

      types[i] = type == T.AL ? T.R : type;

      if (type & T.Strong) {
        prevStrong = type;
      }

      prev = type;
    }

    // W5. A sequence of European terminators adjacent to European
    // numbers changes to all European numbers.
    // W6. Otherwise, separators and terminators change to Other
    // Neutral.
    // W7. Search backwards from each instance of a European number
    // until the first strong type (R, L, or sor) is found. If an L is
    // found, then change the type of the European number to L.
    // (Left after this: L, R, EN+AN, NI)
    for (let i = from, prev = prevType, prevStrong = prevType; i < to; i++) {
      let type = types[i];

      if (type == T.CS) {
        if (i < to - 1 && prev == types[i + 1] && prev & T.Num) {
          type = types[i] = prev;
        } else {
          types[i] = T.NI;
        }
      } else if (type == T.ET) {
        let end = i + 1;

        while (end < to && types[end] == T.ET) {
          end++;
        }

        const replace =
          (i && prev == T.EN) || (end < rTo && types[end] == T.EN)
            ? prevStrong == T.L
              ? T.L
              : T.EN
            : T.NI;

        for (let j = i; j < end; j++) {
          types[j] = replace;
        }

        i = end - 1;
      } else if (type == T.EN && prevStrong == T.L) {
        types[i] = T.L;
      }

      prev = type;

      if (type & T.Strong) {
        prevStrong = type;
      }
    }
  }
}

// Process brackets throughout a run sequence.
function processBracketPairs(
  line: string,
  rFrom: number,
  rTo: number,
  isolates: readonly Isolate[],
  outerType: T
) {
  const oppositeType = outerType == T.L ? T.R : T.L;

  for (let iI = 0, sI = 0, context = 0; iI <= isolates.length; iI++) {
    const from = iI ? isolates[iI - 1].to : rFrom;
    const to = iI < isolates.length ? isolates[iI].from : rTo;

    // N0. Process bracket pairs in an isolating run sequence
    // sequentially in the logical order of the text positions of the
    // opening paired brackets using the logic given below. Within this
    // scope, bidirectional types EN and AN are treated as R.
    for (let i = from, ch, br, type; i < to; i++) {
      // Keeps [startIndex, type, strongSeen] triples for each open
      // bracket on BracketStack.
      if ((br = Brackets[(ch = line.charCodeAt(i))])) {
        if (br < 0) {
          // Closing bracket
          for (let sJ = sI - 3; sJ >= 0; sJ -= 3) {
            if (BracketStack[sJ + 1] == -br) {
              const flags = BracketStack[sJ + 2];
              const type =
                flags & Bracketed.EmbedInside
                  ? outerType
                  : !(flags & Bracketed.OppositeInside)
                  ? 0
                  : flags & Bracketed.OppositeBefore
                  ? oppositeType
                  : outerType;

              if (type) {
                types[i] = types[BracketStack[sJ]] = type;
              }

              sI = sJ;
              break;
            }
          }
        } else if (BracketStack.length == Bracketed.MaxDepth) {
          break;
        } else {
          BracketStack[sI++] = i;
          BracketStack[sI++] = ch;
          BracketStack[sI++] = context;
        }
      } else if ((type = types[i]) == T.R || type == T.L) {
        const embed = type == outerType;
        context = embed ? 0 : Bracketed.OppositeBefore;

        for (let sJ = sI - 3; sJ >= 0; sJ -= 3) {
          const cur = BracketStack[sJ + 2];
          if (cur & Bracketed.EmbedInside) {
            break;
          }

          if (embed) {
            BracketStack[sJ + 2] |= Bracketed.EmbedInside;
          } else {
            if (cur & Bracketed.OppositeInside) {
              break;
            }

            BracketStack[sJ + 2] |= Bracketed.OppositeInside;
          }
        }
      }
    }
  }
}

function processNeutrals(rFrom: number, rTo: number, isolates: readonly Isolate[], outerType: T) {
  for (let iI = 0, prev = outerType; iI <= isolates.length; iI++) {
    const from = iI ? isolates[iI - 1].to : rFrom;

    let to = iI < isolates.length ? isolates[iI].from : rTo;

    // N1. A sequence of neutrals takes the direction of the
    // surrounding strong text if the text on both sides has the same
    // direction. European and Arabic numbers act as if they were R in
    // terms of their influence on neutrals. Start-of-level-run (sor)
    // and end-of-level-run (eor) are used at level run boundaries.
    // N2. Any remaining neutrals take the embedding direction.
    // (Left after this: L, R, EN+AN)
    for (let i = from; i < to; ) {
      const type = types[i];

      if (type == T.NI) {
        let end = i + 1;

        for (;;) {
          if (end == to) {
            if (iI == isolates.length) {
              break;
            }

            end = isolates[iI++].to;
            to = iI < isolates.length ? isolates[iI].from : rTo;
          } else if (types[end] == T.NI) {
            end++;
          } else {
            break;
          }
        }

        const beforeL = prev == T.L;
        const afterL = (end < rTo ? types[end] : outerType) == T.L;
        const replace = beforeL == afterL ? (beforeL ? T.L : T.R) : outerType;

        for (let j = end, jI = iI, fromJ = jI ? isolates[jI - 1].to : rFrom; j > i; ) {
          if (j == fromJ) {
            j = isolates[--jI].from;
            fromJ = jI ? isolates[jI - 1].to : rFrom;
          }

          types[--j] = replace;
        }
        i = end;
      } else {
        prev = type;
        i++;
      }
    }
  }
}

// Find the contiguous ranges of character types in a given range, and
// emit spans for them. Flip the order of the spans as appropriate
// based on the level, and call through to compute the spans for
// isolates at the proper point.
function emitSpans(
  line: string,
  from: number,
  to: number,
  level: number,
  baseLevel: number,
  isolates: readonly Isolate[],
  order: BidiSpan[]
) {
  const ourType = level % 2 ? T.R : T.L;

  if (level % 2 == baseLevel % 2) {
    // Same dir as base direction, don't flip
    for (let iCh = from, iI = 0; iCh < to; ) {
      // Scan a section of characters in direction ourType, unless
      // there's another type of char right after iCh, in which case
      // we scan a section of other characters (which, if ourType ==
      // T.L, may contain both T.R and T.AN chars).
      let sameDir = true,
        isNum = false;
      if (iI == isolates.length || iCh < isolates[iI].from) {
        const next = types[iCh];
        if (next != ourType) {
          sameDir = false;
          isNum = next == T.AN;
        }
      }
      // Holds an array of isolates to pass to a recursive call if we
      // must recurse (to distinguish T.AN inside an RTL section in
      // LTR text), null if we can emit directly
      const recurse: Isolate[] | null = !sameDir && ourType == T.L ? [] : null;
      const localLevel = sameDir ? level : level + 1;
      let iScan = iCh;
      run: for (;;) {
        if (iI < isolates.length && iScan == isolates[iI].from) {
          if (isNum) break run;
          const iso = isolates[iI];
          // Scan ahead to verify that there is another char in this dir after the isolate(s)
          if (!sameDir)
            for (let upto = iso.to, jI = iI + 1; ; ) {
              if (upto == to) break run;
              if (jI < isolates.length && isolates[jI].from == upto) upto = isolates[jI++].to;
              else if (types[upto] == ourType) break run;
              else break;
            }
          iI++;
          if (recurse) {
            recurse.push(iso);
          } else {
            if (iso.from > iCh) order.push(new BidiSpan(iCh, iso.from, localLevel));
            const dirSwap = (iso.direction == LTR) != !(localLevel % 2);
            computeSectionOrder(
              line,
              dirSwap ? level + 1 : level,
              baseLevel,
              iso.inner,
              iso.from,
              iso.to,
              order
            );
            iCh = iso.to;
          }
          iScan = iso.to;
        } else if (iScan == to || (sameDir ? types[iScan] != ourType : types[iScan] == ourType)) {
          break;
        } else {
          iScan++;
        }
      }
      if (recurse) emitSpans(line, iCh, iScan, level + 1, baseLevel, recurse, order);
      else if (iCh < iScan) order.push(new BidiSpan(iCh, iScan, localLevel));
      iCh = iScan;
    }
  } else {
    // Iterate in reverse to flip the span order. Same code again, but
    // going from the back of the section to the front
    for (let iCh = to, iI = isolates.length; iCh > from; ) {
      let sameDir = true,
        isNum = false;
      if (!iI || iCh > isolates[iI - 1].to) {
        const next = types[iCh - 1];
        if (next != ourType) {
          sameDir = false;
          isNum = next == T.AN;
        }
      }
      const recurse: Isolate[] | null = !sameDir && ourType == T.L ? [] : null;
      const localLevel = sameDir ? level : level + 1;
      let iScan = iCh;
      run: for (;;) {
        if (iI && iScan == isolates[iI - 1].to) {
          if (isNum) break run;
          const iso = isolates[--iI];
          // Scan ahead to verify that there is another char in this dir after the isolate(s)
          if (!sameDir)
            for (let upto = iso.from, jI = iI; ; ) {
              if (upto == from) break run;
              if (jI && isolates[jI - 1].to == upto) upto = isolates[--jI].from;
              else if (types[upto - 1] == ourType) break run;
              else break;
            }
          if (recurse) {
            recurse.push(iso);
          } else {
            if (iso.to < iCh) order.push(new BidiSpan(iso.to, iCh, localLevel));
            const dirSwap = (iso.direction == LTR) != !(localLevel % 2);
            computeSectionOrder(
              line,
              dirSwap ? level + 1 : level,
              baseLevel,
              iso.inner,
              iso.from,
              iso.to,
              order
            );
            iCh = iso.from;
          }
          iScan = iso.from;
        } else if (
          iScan == from ||
          (sameDir ? types[iScan - 1] != ourType : types[iScan - 1] == ourType)
        ) {
          break;
        } else {
          iScan--;
        }
      }
      if (recurse) emitSpans(line, iScan, iCh, level + 1, baseLevel, recurse, order);
      else if (iScan < iCh) order.push(new BidiSpan(iScan, iCh, localLevel));
      iCh = iScan;
    }
  }
}

function computeSectionOrder(
  line: string,
  level: number,
  baseLevel: number,
  isolates: readonly Isolate[],
  from: number,
  to: number,
  order: BidiSpan[]
) {
  const outerType = (level % 2 ? T.R : T.L) as T;
  computeCharTypes(line, from, to, isolates, outerType);
  processBracketPairs(line, from, to, isolates, outerType);
  processNeutrals(from, to, isolates, outerType);

  emitSpans(line, from, to, level, baseLevel, isolates, order);
}

export function computeOrder(line: string, direction: Direction, isolates: readonly Isolate[]) {
  if (!line) return [new BidiSpan(0, 0, direction == RTL ? 1 : 0)];
  if (direction == LTR && !isolates.length && !BidiRE.test(line)) return trivialOrder(line.length);

  if (isolates.length) while (line.length > types.length) types[types.length] = T.NI; // Make sure types array has no gaps
  const order: BidiSpan[] = [],
    level = direction == LTR ? 0 : 1;
  computeSectionOrder(line, level, level, isolates, 0, line.length, order);
  return order;
}

export function trivialOrder(length: number) {
  return [new BidiSpan(0, length, 0)];
}

export let movedOver = "";

// This implementation moves strictly visually, without concern for a
// traversal visiting every logical position in the string. It will
// still do so for simple input, but situations like multiple isolates
// with the same level next to each other, or text going against the
// main dir at the end of the line, will make some positions
// unreachable with this motion. Each visible cursor position will
// correspond to the lower-level bidi span that touches it.
//
// The alternative would be to solve an order globally for a given
// line, making sure that it includes every position, but that would
// require associating non-canonical (higher bidi span level)
// positions with a given visual position, which is likely to confuse
// people. (And would generally be a lot more complicated.)
export function moveVisually(
  line: Line,
  order: readonly BidiSpan[],
  dir: Direction,
  start: SelectionRange,
  forward: boolean
) {
  let startIndex = start.head - line.from;
  let spanI = BidiSpan.find(order, startIndex, start.bidiLevel ?? -1, start.assoc);
  let span = order[spanI],
    spanEnd = span.side(forward, dir);
  // End of span
  if (startIndex == spanEnd) {
    const nextI = (spanI += forward ? 1 : -1);
    if (nextI < 0 || nextI >= order.length) return null;
    span = order[(spanI = nextI)];
    startIndex = span.side(!forward, dir);
    spanEnd = span.side(forward, dir);
  }
  let nextIndex = findClusterBreak(line.text, startIndex, span.forward(forward, dir));
  if (nextIndex < span.from || nextIndex > span.to) nextIndex = spanEnd;
  movedOver = line.text.slice(Math.min(startIndex, nextIndex), Math.max(startIndex, nextIndex));

  const nextSpan =
    spanI == (forward ? order.length - 1 : 0) ? null : order[spanI + (forward ? 1 : -1)];

  if (nextSpan && nextIndex == spanEnd && nextSpan.level + (forward ? 0 : 1) < span.level) {
    return EditorSelection.cursor(
      nextSpan.side(!forward, dir) + line.from,
      nextSpan.forward(forward, dir) ? 1 : -1,
      nextSpan.level
    );
  }

  return EditorSelection.cursor(
    nextIndex + line.from,
    span.forward(forward, dir) ? -1 : 1,
    span.level
  );
}

export function autoDirection(text: string, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const type = charType(text.charCodeAt(i));

    if (type == T.L) {
      return LTR;
    }

    if (type == T.R || type == T.AL) {
      return RTL;
    }
  }
  return LTR;
}
