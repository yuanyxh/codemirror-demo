import { Text, ChangeSet, RangeSet, SpanIterator } from "@/state/index";
import {
  DecorationSet,
  PointDecoration,
  Decoration,
  BlockType,
  addRange,
  WidgetType,
} from "../decorations/decoration";
import { ChangedRange } from "../extensions/extension";

/** 文档、行、块高度的记录与测量工具 */

const wrappingWhiteSpace = ["pre-wrap", "normal", "pre-line", "break-spaces"];

// Used to track, during updateHeight, if any actual heights changed
export let heightChangeFlag = false;

export function clearHeightChangeFlag() {
  heightChangeFlag = false;
}

export class HeightOracle {
  doc: Text = Text.empty;
  heightSamples: { [key: number]: boolean } = {};
  /** 整行高度 */
  lineHeight: number = 14;
  /** 单字符宽 */
  charWidth: number = 7;
  /** 实际字体的高度（font-size） */
  textHeight: number = 14;
  /** 一行可以装载多少个文本 */
  lineLength: number = 30;

  constructor(public lineWrapping: boolean) {}

  /** 获取 from 到 to 的行高度 */
  heightForGap(from: number, to: number): number {
    let lines = this.doc.lineAt(to).number - this.doc.lineAt(from).number + 1;

    if (this.lineWrapping) {
      lines += Math.max(
        0,
        Math.ceil((to - from - lines * this.lineLength * 0.5) / this.lineLength)
      );
    }

    return this.lineHeight * lines;
  }

  /** 获取行的高度? */
  heightForLine(length: number): number {
    if (!this.lineWrapping) {
      return this.lineHeight;
    }

    const lines = 1 + Math.max(0, Math.ceil((length - this.lineLength) / (this.lineLength - 5)));

    return lines * this.lineHeight;
  }

  setDoc(doc: Text): this {
    this.doc = doc;
    return this;
  }

  mustRefreshForWrapping(whiteSpace: string): boolean {
    return wrappingWhiteSpace.indexOf(whiteSpace) > -1 != this.lineWrapping;
  }

  mustRefreshForHeights(lineHeights: number[]): boolean {
    let newHeight = false;
    for (let i = 0; i < lineHeights.length; i++) {
      const h = lineHeights[i];

      if (h < 0) {
        i++;
      } else if (!this.heightSamples[Math.floor(h * 10)]) {
        // Round to .1 pixels
        newHeight = true;
        this.heightSamples[Math.floor(h * 10)] = true;
      }
    }

    return newHeight;
  }

  refresh(
    /** 空白符 */
    whiteSpace: string,
    /** 行高 */
    lineHeight: number,
    /** 字符宽 */
    charWidth: number,
    /** 文本高 */
    textHeight: number,
    /** 一行可以装载多少个文本 */
    lineLength: number,
    knownHeights: number[]
  ): boolean {
    const lineWrapping = wrappingWhiteSpace.indexOf(whiteSpace) > -1;
    const changed =
      Math.round(lineHeight) != Math.round(this.lineHeight) || this.lineWrapping != lineWrapping;

    this.lineWrapping = lineWrapping;
    this.lineHeight = lineHeight;
    this.charWidth = charWidth;
    this.textHeight = textHeight;
    this.lineLength = lineLength;

    if (changed) {
      this.heightSamples = {};

      for (let i = 0; i < knownHeights.length; i++) {
        const h = knownHeights[i];

        if (h < 0) {
          i++;
        } else {
          this.heightSamples[Math.floor(h * 10)] = true;
        }
      }
    }
    return changed;
  }
}

// This object is used by `updateHeight` to make DOM measurements
// arrive at the right nides. The `heights` array is a sequence of
// block heights, starting from position `from`.
export class MeasuredHeights {
  public index = 0;
  constructor(readonly from: number, readonly heights: number[]) {}
  get more() {
    return this.index < this.heights.length;
  }
}

/** 用于表示编辑器视图中块级元素的信息的记录 */
export class BlockInfo {
  constructor(
    /** 文档中元素的开始位置 */
    readonly from: number,
    /** 元素的长度 */
    readonly length: number,
    /** 元素的顶部位置（相对于文档的顶部） */
    readonly top: number,
    /** 它的高度 */
    readonly height: number,
    /**
     * 奇怪的打包字段，包含复合块的子级数组、块小部件的装饰以及指示文本块的小部件创建换行符数量的数字
     */
    readonly _content: readonly BlockInfo[] | PointDecoration | number
  ) {}

  /// The type of element this is. When querying lines, this may be
  /// an array of all the blocks that make up the line.
  get type(): BlockType | readonly BlockInfo[] {
    return typeof this._content == "number"
      ? BlockType.Text
      : Array.isArray(this._content)
      ? this._content
      : (this._content as PointDecoration).type;
  }

  /** 文档中元素的结束位置 */
  get to() {
    return this.from + this.length;
  }
  /// The bottom position of the element.
  get bottom() {
    return this.top + this.height;
  }

  /// If this is a widget block, this will return the widget
  /// associated with it.
  get widget(): WidgetType | null {
    return this._content instanceof PointDecoration ? this._content.widget : null;
  }

  /// If this is a textblock, this holds the number of line breaks
  /// that appear in widgets inside the block.
  get widgetLineBreaks(): number {
    return typeof this._content == "number" ? this._content : 0;
  }

  /// @internal
  join(other: BlockInfo) {
    const content = (Array.isArray(this._content) ? this._content : [this]).concat(
      Array.isArray(other._content) ? other._content : [other]
    );
    return new BlockInfo(
      this.from,
      this.length + other.length,
      this.top,
      this.height + other.height,
      content
    );
  }
}

export enum QueryType {
  ByPos,
  ByHeight,
  ByPosNoHeight,
}

const enum Flag {
  Break = 1,
  Outdated = 2,
  SingleLine = 4,
}

const Epsilon = 1e-3;

export abstract class HeightMap {
  constructor(
    public length: number, // The number of characters covered
    public height: number, // Height of this part of the document
    public flags: number = Flag.Outdated
  ) {}

  size!: number;

  get outdated() {
    return (this.flags & Flag.Outdated) > 0;
  }
  set outdated(value) {
    this.flags = (value ? Flag.Outdated : 0) | (this.flags & ~Flag.Outdated);
  }

  abstract blockAt(height: number, oracle: HeightOracle, top: number, offset: number): BlockInfo;

  abstract lineAt(
    value: number,
    type: QueryType,
    oracle: HeightOracle,
    top: number,
    offset: number
  ): BlockInfo;

  abstract forEachLine(
    from: number,
    to: number,
    oracle: HeightOracle,
    top: number,
    offset: number,
    f: (line: BlockInfo) => void
  ): void;

  abstract updateHeight(
    oracle: HeightOracle,
    offset?: number,
    force?: boolean,
    measured?: MeasuredHeights
  ): HeightMap;

  abstract toString(): void;

  setHeight(height: number) {
    if (this.height != height) {
      if (Math.abs(this.height - height) > Epsilon) {
        heightChangeFlag = true;
      }

      this.height = height;
    }
  }

  // Base case is to replace a leaf node, which simply builds a tree
  // from the new nodes and returns that (HeightMapBranch and
  // HeightMapGap override this to actually use from/to)
  replace(_from: number, _to: number, nodes: (HeightMap | null)[]): HeightMap {
    return HeightMap.of(nodes);
  }

  // Again, these are base cases, and are overridden for branch and gap nodes.
  decomposeLeft(_to: number, result: (HeightMap | null)[]) {
    result.push(this);
  }

  decomposeRight(_from: number, result: (HeightMap | null)[]) {
    result.push(this);
  }

  applyChanges(
    decorations: readonly DecorationSet[],
    oldDoc: Text,
    oracle: HeightOracle,
    changes: readonly ChangedRange[]
  ): HeightMap {
    let me: HeightMap = this;

    const doc = oracle.doc;

    /** 从后到前遍历已变更的文档范围 ChangedRange */
    for (let i = changes.length - 1; i >= 0; i--) {
      let { fromA, toA, fromB, toB } = changes[i];

      // 获取旧文档中开始行
      let start = me.lineAt(fromA, QueryType.ByPosNoHeight, oracle.setDoc(oldDoc), 0, 0);
      // 获取旧文档中结束行
      const end = start.to >= toA ? start : me.lineAt(toA, QueryType.ByPosNoHeight, oracle, 0, 0);

      toB += end.to - toA;
      toA = end.to;

      // 获取与当前 ChangedRange 相连的变更
      while (i > 0 && start.from <= changes[i - 1].toA) {
        fromA = changes[i - 1].fromA;
        fromB = changes[i - 1].fromB;

        i--;

        if (fromA < start.from) {
          start = me.lineAt(fromA, QueryType.ByPosNoHeight, oracle, 0, 0);
        }
      }

      fromB += start.from - fromA;
      fromA = start.from;

      // 编译新文档，应用装饰器
      const nodes = NodeBuilder.build(oracle.setDoc(doc), decorations, fromB, toB);

      me = replace(me, me.replace(fromA, toA, nodes));
    }

    // 更新高度
    return me.updateHeight(oracle, 0);
  }

  static empty(): HeightMap {
    return new HeightMapText(0, 0);
  }

  // nodes uses null values to indicate the position of line breaks.
  // There are never line breaks at the start or end of the array, or
  // two line breaks next to each other, and the array isn't allowed
  // to be empty (same restrictions as return value from the builder).
  static of(nodes: (HeightMap | null)[]): HeightMap {
    if (nodes.length == 1) {
      return nodes[0] as HeightMap;
    }

    let i = 0;
    let j = nodes.length;
    let before = 0;
    let after = 0;
    for (;;) {
      if (i == j) {
        if (before > after * 2) {
          const split = nodes[i - 1] as HeightMapBranch;

          if (split.break) {
            nodes.splice(--i, 1, split.left, null, split.right);
          } else {
            nodes.splice(--i, 1, split.left, split.right);
          }

          j += 1 + split.break;
          before -= split.size;
        } else if (after > before * 2) {
          const split = nodes[j] as HeightMapBranch;
          if (split.break) {
            nodes.splice(j, 1, split.left, null, split.right);
          } else {
            nodes.splice(j, 1, split.left, split.right);
          }

          j += 2 + split.break;
          after -= split.size;
        } else {
          break;
        }
      } else if (before < after) {
        const next = nodes[i++];

        if (next) {
          before += next.size;
        }
      } else {
        const next = nodes[--j];

        if (next) {
          after += next.size;
        }
      }
    }

    let brk = 0;

    if (nodes[i - 1] == null) {
      brk = 1;
      i--;
    } else if (nodes[i] == null) {
      brk = 1;
      j++;
    }

    return new HeightMapBranch(HeightMap.of(nodes.slice(0, i)), brk, HeightMap.of(nodes.slice(j)));
  }
}

function replace(old: HeightMap, val: HeightMap) {
  if (old == val) {
    return old;
  }

  if (old.constructor != val.constructor) {
    heightChangeFlag = true;
  }

  return val;
}

HeightMap.prototype.size = 1;

class HeightMapBlock extends HeightMap {
  constructor(length: number, height: number, readonly deco: PointDecoration | null) {
    super(length, height);
  }

  blockAt(_height: number, _oracle: HeightOracle, top: number, offset: number) {
    return new BlockInfo(offset, this.length, top, this.height, this.deco || 0);
  }

  lineAt(_value: number, _type: QueryType, oracle: HeightOracle, top: number, offset: number) {
    return this.blockAt(0, oracle, top, offset);
  }

  forEachLine(
    from: number,
    to: number,
    oracle: HeightOracle,
    top: number,
    offset: number,
    f: (line: BlockInfo) => void
  ) {
    if (from <= offset + this.length && to >= offset) f(this.blockAt(0, oracle, top, offset));
  }

  updateHeight(
    _oracle: HeightOracle,
    offset: number = 0,
    _force: boolean = false,
    measured?: MeasuredHeights
  ) {
    if (measured && measured.from <= offset && measured.more) {
      this.setHeight(measured.heights[measured.index++]);
    }

    this.outdated = false;

    return this;
  }

  toString() {
    return `block(${this.length})`;
  }
}

class HeightMapText extends HeightMapBlock {
  public collapsed = 0; // Amount of collapsed content in the line
  public widgetHeight = 0; // Maximum inline widget height
  public breaks = 0; // Number of widget-introduced line breaks on the line

  constructor(length: number, height: number) {
    super(length, height, null);
  }

  blockAt(_height: number, _oracle: HeightOracle, top: number, offset: number) {
    return new BlockInfo(offset, this.length, top, this.height, this.breaks);
  }

  replace(_from: number, _to: number, nodes: (HeightMap | null)[]): HeightMap {
    let node = nodes[0];

    if (
      nodes.length == 1 &&
      (node instanceof HeightMapText ||
        (node instanceof HeightMapGap && node.flags & Flag.SingleLine)) &&
      Math.abs(this.length - node.length) < 10
    ) {
      if (node instanceof HeightMapGap) {
        node = new HeightMapText(node.length, this.height);
      } else {
        node.height = this.height;
      }

      if (!this.outdated) {
        node.outdated = false;
      }

      return node;
    } else {
      return HeightMap.of(nodes);
    }
  }

  updateHeight(
    oracle: HeightOracle,
    offset: number = 0,
    force: boolean = false,
    measured?: MeasuredHeights
  ) {
    if (measured && measured.from <= offset && measured.more) {
      this.setHeight(measured.heights[measured.index++]);
    } else if (force || this.outdated) {
      this.setHeight(
        Math.max(this.widgetHeight, oracle.heightForLine(this.length - this.collapsed)) +
          this.breaks * oracle.lineHeight
      );
    }

    this.outdated = false;

    return this;
  }

  toString() {
    return `line(${this.length}${this.collapsed ? -this.collapsed : ""}${
      this.widgetHeight ? ":" + this.widgetHeight : ""
    })`;
  }
}

class HeightMapGap extends HeightMap {
  constructor(length: number) {
    super(length, 0);
  }

  private heightMetrics(
    oracle: HeightOracle,
    offset: number
  ): {
    firstLine: number;
    lastLine: number;
    perLine: number;
    perChar: number;
  } {
    const firstLine = oracle.doc.lineAt(offset).number;
    const lastLine = oracle.doc.lineAt(offset + this.length).number;
    const lines = lastLine - firstLine + 1;

    let perLine: number;
    let perChar = 0;

    if (oracle.lineWrapping) {
      const totalPerLine = Math.min(this.height, oracle.lineHeight * lines);
      perLine = totalPerLine / lines;

      if (this.length > lines + 1) {
        perChar = (this.height - totalPerLine) / (this.length - lines - 1);
      }
    } else {
      perLine = this.height / lines;
    }

    return { firstLine, lastLine, perLine, perChar };
  }

  blockAt(height: number, oracle: HeightOracle, top: number, offset: number) {
    const { firstLine, lastLine, perLine, perChar } = this.heightMetrics(oracle, offset);

    if (oracle.lineWrapping) {
      const guess =
        offset +
        (height < oracle.lineHeight
          ? 0
          : Math.round(Math.max(0, Math.min(1, (height - top) / this.height)) * this.length));

      const line = oracle.doc.lineAt(guess);
      const lineHeight = perLine + line.length * perChar;
      const lineTop = Math.max(top, height - lineHeight / 2);

      return new BlockInfo(line.from, line.length, lineTop, lineHeight, 0);
    } else {
      const line = Math.max(
        0,
        Math.min(lastLine - firstLine, Math.floor((height - top) / perLine))
      );

      const { from, length } = oracle.doc.line(firstLine + line);

      return new BlockInfo(from, length, top + perLine * line, perLine, 0);
    }
  }

  lineAt(value: number, type: QueryType, oracle: HeightOracle, top: number, offset: number) {
    if (type == QueryType.ByHeight) {
      return this.blockAt(value, oracle, top, offset);
    }

    if (type == QueryType.ByPosNoHeight) {
      const { from, to } = oracle.doc.lineAt(value);

      return new BlockInfo(from, to - from, 0, 0, 0);
    }

    const { firstLine, perLine, perChar } = this.heightMetrics(oracle, offset);

    const line = oracle.doc.lineAt(value);
    const lineHeight = perLine + line.length * perChar;
    const linesAbove = line.number - firstLine;
    const lineTop = top + perLine * linesAbove + perChar * (line.from - offset - linesAbove);

    return new BlockInfo(
      line.from,
      line.length,
      Math.max(top, Math.min(lineTop, top + this.height - lineHeight)),
      lineHeight,
      0
    );
  }

  forEachLine(
    from: number,
    to: number,
    oracle: HeightOracle,
    top: number,
    offset: number,
    f: (line: BlockInfo) => void
  ) {
    from = Math.max(from, offset);
    to = Math.min(to, offset + this.length);

    const { firstLine, perLine, perChar } = this.heightMetrics(oracle, offset);

    for (let pos = from, lineTop = top; pos <= to; ) {
      const line = oracle.doc.lineAt(pos);

      if (pos == from) {
        const linesAbove = line.number - firstLine;
        lineTop += perLine * linesAbove + perChar * (from - offset - linesAbove);
      }

      const lineHeight = perLine + perChar * line.length;

      f(new BlockInfo(line.from, line.length, lineTop, lineHeight, 0));

      lineTop += lineHeight;
      pos = line.to + 1;
    }
  }

  replace(from: number, to: number, nodes: (HeightMap | null)[]): HeightMap {
    const after = this.length - to;

    if (after > 0) {
      const last = nodes[nodes.length - 1];
      if (last instanceof HeightMapGap) {
        nodes[nodes.length - 1] = new HeightMapGap(last.length + after);
      } else {
        nodes.push(null, new HeightMapGap(after - 1));
      }
    }

    if (from > 0) {
      const first = nodes[0];

      if (first instanceof HeightMapGap) {
        nodes[0] = new HeightMapGap(from + first.length);
      } else {
        nodes.unshift(new HeightMapGap(from - 1), null);
      }
    }

    return HeightMap.of(nodes);
  }

  decomposeLeft(to: number, result: (HeightMap | null)[]) {
    result.push(new HeightMapGap(to - 1), null);
  }

  decomposeRight(from: number, result: (HeightMap | null)[]) {
    result.push(null, new HeightMapGap(this.length - from - 1));
  }

  updateHeight(
    oracle: HeightOracle,
    offset: number = 0,
    force: boolean = false,
    measured?: MeasuredHeights
  ): HeightMap {
    const end = offset + this.length;

    if (measured && measured.from <= offset + this.length && measured.more) {
      // Fill in part of this gap with measured lines. We know there
      // can't be widgets or collapsed ranges in those lines, because
      // they would already have been added to the heightmap (gaps
      // only contain plain text).
      const nodes = [];
      let pos = Math.max(offset, measured.from);
      let singleHeight = -1;

      if (measured.from > offset) {
        nodes.push(new HeightMapGap(measured.from - offset - 1).updateHeight(oracle, offset));
      }

      while (pos <= end && measured.more) {
        const len = oracle.doc.lineAt(pos).length;

        if (nodes.length) {
          nodes.push(null);
        }

        const height = measured.heights[measured.index++];

        if (singleHeight == -1) {
          singleHeight = height;
        } else if (Math.abs(height - singleHeight) >= Epsilon) {
          singleHeight = -2;
        }

        const line = new HeightMapText(len, height);
        line.outdated = false;
        nodes.push(line);
        pos += len + 1;
      }

      if (pos <= end) {
        nodes.push(null, new HeightMapGap(end - pos).updateHeight(oracle, pos));
      }

      const result = HeightMap.of(nodes);

      if (
        singleHeight < 0 ||
        Math.abs(result.height - this.height) >= Epsilon ||
        Math.abs(singleHeight - this.heightMetrics(oracle, offset).perLine) >= Epsilon
      ) {
        heightChangeFlag = true;
      }

      return replace(this, result);
    } else if (force || this.outdated) {
      this.setHeight(oracle.heightForGap(offset, offset + this.length));
      this.outdated = false;
    }

    return this;
  }

  toString() {
    return `gap(${this.length})`;
  }
}

class HeightMapBranch extends HeightMap {
  size: number;

  constructor(public left: HeightMap, brk: number, public right: HeightMap) {
    super(
      left.length + brk + right.length,
      left.height + right.height,
      brk | (left.outdated || right.outdated ? Flag.Outdated : 0)
    );

    this.size = left.size + right.size;
  }

  get break() {
    return this.flags & Flag.Break;
  }

  blockAt(height: number, oracle: HeightOracle, top: number, offset: number) {
    const mid = top + this.left.height;

    return height < mid
      ? this.left.blockAt(height, oracle, top, offset)
      : this.right.blockAt(height, oracle, mid, offset + this.left.length + this.break);
  }

  lineAt(value: number, type: QueryType, oracle: HeightOracle, top: number, offset: number) {
    const rightTop = top + this.left.height;
    const rightOffset = offset + this.left.length + this.break;
    const left = type == QueryType.ByHeight ? value < rightTop : value < rightOffset;

    const base = left
      ? this.left.lineAt(value, type, oracle, top, offset)
      : this.right.lineAt(value, type, oracle, rightTop, rightOffset);

    if (this.break || (left ? base.to < rightOffset : base.from > rightOffset)) {
      return base;
    }

    const subQuery = type == QueryType.ByPosNoHeight ? QueryType.ByPosNoHeight : QueryType.ByPos;

    if (left) {
      return base.join(this.right.lineAt(rightOffset, subQuery, oracle, rightTop, rightOffset));
    } else {
      return this.left.lineAt(rightOffset, subQuery, oracle, top, offset).join(base);
    }
  }

  forEachLine(
    from: number,
    to: number,
    oracle: HeightOracle,
    top: number,
    offset: number,
    f: (line: BlockInfo) => void
  ) {
    const rightTop = top + this.left.height;
    const rightOffset = offset + this.left.length + this.break;

    if (this.break) {
      if (from < rightOffset) {
        this.left.forEachLine(from, to, oracle, top, offset, f);
      }
      if (to >= rightOffset) {
        this.right.forEachLine(from, to, oracle, rightTop, rightOffset, f);
      }
    } else {
      const mid = this.lineAt(rightOffset, QueryType.ByPos, oracle, top, offset);

      if (from < mid.from) {
        this.left.forEachLine(from, mid.from - 1, oracle, top, offset, f);
      }

      if (mid.to >= from && mid.from <= to) {
        f(mid);
      }

      if (to > mid.to) {
        this.right.forEachLine(mid.to + 1, to, oracle, rightTop, rightOffset, f);
      }
    }
  }

  replace(from: number, to: number, nodes: (HeightMap | null)[]): HeightMap {
    const rightStart = this.left.length + this.break;

    if (to < rightStart) {
      return this.balanced(this.left.replace(from, to, nodes), this.right);
    }

    if (from > this.left.length) {
      return this.balanced(
        this.left,
        this.right.replace(from - rightStart, to - rightStart, nodes)
      );
    }

    const result: (HeightMap | null)[] = [];

    if (from > 0) {
      this.decomposeLeft(from, result);
    }

    const left = result.length;

    for (const node of nodes) {
      result.push(node);
    }

    if (from > 0) {
      mergeGaps(result, left - 1);
    }

    if (to < this.length) {
      const right = result.length;
      this.decomposeRight(to, result);
      mergeGaps(result, right);
    }

    return HeightMap.of(result);
  }

  decomposeLeft(to: number, result: (HeightMap | null)[]) {
    let left = this.left.length;

    if (to <= left) {
      return this.left.decomposeLeft(to, result);
    }

    result.push(this.left);

    if (this.break) {
      left++;

      if (to >= left) {
        result.push(null);
      }
    }

    if (to > left) {
      this.right.decomposeLeft(to - left, result);
    }
  }

  decomposeRight(from: number, result: (HeightMap | null)[]) {
    const left = this.left.length;
    const right = left + this.break;

    if (from >= right) {
      return this.right.decomposeRight(from - right, result);
    }

    if (from < left) {
      this.left.decomposeRight(from, result);
    }

    if (this.break && from < right) {
      result.push(null);
    }

    result.push(this.right);
  }

  balanced(left: HeightMap, right: HeightMap): HeightMap {
    if (left.size > 2 * right.size || right.size > 2 * left.size) {
      return HeightMap.of(this.break ? [left, null, right] : [left, right]);
    }

    this.left = replace(this.left, left);
    this.right = replace(this.right, right);
    this.setHeight(left.height + right.height);

    this.outdated = left.outdated || right.outdated;
    this.size = left.size + right.size;
    this.length = left.length + this.break + right.length;

    return this;
  }

  updateHeight(
    oracle: HeightOracle,
    offset: number = 0,
    force: boolean = false,
    measured?: MeasuredHeights
  ): HeightMap {
    let { left, right } = this;
    const rightStart = offset + left.length + this.break;
    let rebalance: any = null;

    if (measured && measured.from <= offset + left.length && measured.more) {
      rebalance = left = left.updateHeight(oracle, offset, force, measured);
    } else {
      left.updateHeight(oracle, offset, force);
    }

    if (measured && measured.from <= rightStart + right.length && measured.more) {
      rebalance = right = right.updateHeight(oracle, rightStart, force, measured);
    } else {
      right.updateHeight(oracle, rightStart, force);
    }

    if (rebalance) {
      return this.balanced(left, right);
    }

    this.height = this.left.height + this.right.height;
    this.outdated = false;

    return this;
  }

  toString() {
    return this.left + (this.break ? " " : "-") + this.right;
  }
}

function mergeGaps(nodes: (HeightMap | null)[], around: number) {
  let before: HeightMap | null;
  let after: HeightMap | null;

  if (
    nodes[around] == null &&
    (before = nodes[around - 1]) instanceof HeightMapGap &&
    (after = nodes[around + 1]) instanceof HeightMapGap
  ) {
    nodes.splice(around - 1, 3, new HeightMapGap(before.length + 1 + after.length));
  }
}

const relevantWidgetHeight = 5;

class NodeBuilder implements SpanIterator<Decoration> {
  nodes: (HeightMap | null)[] = [];
  writtenTo: number;
  lineStart = -1;
  lineEnd = -1;
  covering: HeightMapBlock | null = null;

  constructor(public pos: number, public oracle: HeightOracle) {
    this.writtenTo = pos;
  }

  get isCovered() {
    return this.covering && this.nodes[this.nodes.length - 1] == this.covering;
  }

  span(_from: number, to: number) {
    if (this.lineStart > -1) {
      const end = Math.min(to, this.lineEnd);
      const last = this.nodes[this.nodes.length - 1];

      if (last instanceof HeightMapText) {
        last.length += end - this.pos;
      } else if (end > this.pos || !this.isCovered) {
        this.nodes.push(new HeightMapText(end - this.pos, -1));
      }

      this.writtenTo = end;

      if (to > end) {
        this.nodes.push(null);
        this.writtenTo++;
        this.lineStart = -1;
      }
    }

    this.pos = to;
  }

  point(from: number, to: number, deco: PointDecoration) {
    if (from < to || deco.heightRelevant) {
      let height = deco.widget ? deco.widget.estimatedHeight : 0;
      const breaks = deco.widget ? deco.widget.lineBreaks : 0;

      if (height < 0) {
        height = this.oracle.lineHeight;
      }

      const len = to - from;

      if (deco.block) {
        // 添加块装饰
        this.addBlock(new HeightMapBlock(len, height, deco));
      } else if (len || breaks || height >= relevantWidgetHeight) {
        // 添加行装饰
        this.addLineDeco(height, breaks, len);
      }
    } else if (to > from) {
      this.span(from, to);
    }

    if (this.lineEnd > -1 && this.lineEnd < this.pos) {
      this.lineEnd = this.oracle.doc.lineAt(this.pos).to;
    }
  }

  enterLine() {
    if (this.lineStart > -1) {
      return;
    }

    const { from, to } = this.oracle.doc.lineAt(this.pos);

    this.lineStart = from;
    this.lineEnd = to;

    if (this.writtenTo < from) {
      if (this.writtenTo < from - 1 || this.nodes[this.nodes.length - 1] == null) {
        this.nodes.push(this.blankContent(this.writtenTo, from - 1));
      }

      this.nodes.push(null);
    }

    if (this.pos > from) {
      this.nodes.push(new HeightMapText(this.pos - from, -1));
    }

    this.writtenTo = this.pos;
  }

  blankContent(from: number, to: number) {
    const gap = new HeightMapGap(to - from);

    if (this.oracle.doc.lineAt(from).to == to) {
      gap.flags |= Flag.SingleLine;
    }

    return gap;
  }

  ensureLine() {
    this.enterLine();

    const last = this.nodes.length ? this.nodes[this.nodes.length - 1] : null;

    if (last instanceof HeightMapText) {
      return last;
    }

    const line = new HeightMapText(0, -1);
    this.nodes.push(line);

    return line;
  }

  addBlock(block: HeightMapBlock) {
    this.enterLine();
    const deco = block.deco;

    if (deco && deco.startSide > 0 && !this.isCovered) {
      this.ensureLine();
    }

    this.nodes.push(block);
    this.writtenTo = this.pos = this.pos + block.length;

    if (deco && deco.endSide > 0) {
      this.covering = block;
    }
  }

  addLineDeco(height: number, breaks: number, length: number) {
    const line = this.ensureLine();

    line.length += length;
    line.collapsed += length;
    line.widgetHeight = Math.max(line.widgetHeight, height);
    line.breaks += breaks;
    this.writtenTo = this.pos = this.pos + length;
  }

  finish(from: number) {
    const last = this.nodes.length == 0 ? null : this.nodes[this.nodes.length - 1];

    if (this.lineStart > -1 && !(last instanceof HeightMapText) && !this.isCovered) {
      this.nodes.push(new HeightMapText(0, -1));
    } else if (this.writtenTo < this.pos || last == null) {
      this.nodes.push(this.blankContent(this.writtenTo, this.pos));
    }

    let pos = from;

    for (const node of this.nodes) {
      if (node instanceof HeightMapText) {
        node.updateHeight(this.oracle, pos);
      }

      pos += node ? node.length : 1;
    }

    return this.nodes;
  }

  /**
   * 始终使用两侧都延伸到换行符或文档末尾的区域进行调用
   * 返回的数组使用 null 来指示换行符，但从不以换行符开始或结束，或者具有多个彼此相邻的换行符
   */
  static build(
    oracle: HeightOracle,
    decorations: readonly DecorationSet[],
    from: number,
    to: number
  ): (HeightMap | null)[] {
    // 构造编译器
    const builder = new NodeBuilder(from, oracle);

    /** 迭代 RangeSet */
    RangeSet.spans(decorations, from, to, builder, 0);

    return builder.finish(from);
  }
}

export function heightRelevantDecoChanges(
  a: readonly DecorationSet[],
  b: readonly DecorationSet[],
  diff: ChangeSet
) {
  const comp = new DecorationComparator();
  RangeSet.compare(a, b, diff, comp, 0);

  return comp.changes;
}

class DecorationComparator {
  changes: number[] = [];

  compareRange() {}

  comparePoint(from: number, to: number, a: Decoration | null, b: Decoration | null) {
    if (from < to || (a && a.heightRelevant) || (b && b.heightRelevant)) {
      addRange(from, to, this.changes, 5);
    }
  }
}