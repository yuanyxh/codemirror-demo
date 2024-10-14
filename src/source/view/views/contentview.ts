import { Text } from "@/state/index";
import { Rect, maxOffset, domIndex } from "../utils/dom";
import { EditorView } from "../editorview";

/** 基础视图 view */

/** 跟踪视图节点 DOM 的突变/过时状态 */
export const enum ViewFlag {
  /** 至少有一个子视图被修改/状态不同步 */
  ChildDirty = 1,
  /** 节点本身与其子列表不同步 */
  NodeDirty = 2,
  /** 节点的 DOM 属性可能已更改 */
  AttrsDirty = 4,
  /** 所有 Dirty 标志的掩码 */
  Dirty = 7,
  /** 在文档视图更新期间在合成周围的节点上临时设置 */
  Composition = 8,
}

/** 记录 dom 位置 */
export class DOMPos {
  constructor(readonly node: Node, readonly offset: number, readonly precise = true) {}

  /** 获取指定 dom 前面的 DOMPos */
  static before(dom: Node, precise?: boolean) {
    return new DOMPos(dom.parentNode!, domIndex(dom), precise);
  }

  /** 获取指定 dom 后面的 DOMPos */
  static after(dom: Node, precise?: boolean) {
    return new DOMPos(dom.parentNode!, domIndex(dom) + 1, precise);
  }
}

export const noChildren: ContentView[] = [];

export abstract class ContentView {
  parent: ContentView | null = null;
  dom: Node | null = null;
  flags: number = ViewFlag.NodeDirty;
  abstract length: number;
  abstract children: ContentView[];
  breakAfter!: number;

  get overrideDOMText(): Text | null {
    return null;
  }

  get posAtStart(): number {
    return this.parent ? this.parent.posBefore(this) : 0;
  }

  get posAtEnd(): number {
    return this.posAtStart + this.length;
  }

  posBefore(view: ContentView): number {
    let pos = this.posAtStart;

    for (const child of this.children) {
      if (child == view) {
        return pos;
      }

      pos += child.length + child.breakAfter;
    }

    throw new RangeError("Invalid child in posBefore");
  }

  posAfter(view: ContentView): number {
    return this.posBefore(view) + view.length;
  }

  /**
   * 将直接在给定位置之前（当 side < 0 时）、之后（side > 0）或直接在给定位置上（当浏览器支持时）返回一个矩形
   */
  abstract coordsAt(_pos: number, _side: number): Rect | null;

  sync(view: EditorView, track?: { node: Node; written: boolean }) {
    if (this.flags & ViewFlag.NodeDirty) {
      const parent = this.dom as HTMLElement;
      let prev: Node | null = null;
      let next: Node | null;

      for (const child of this.children) {
        if (child.flags & ViewFlag.Dirty) {
          if (!child.dom && (next = prev ? prev.nextSibling : parent.firstChild)) {
            const contentView = ContentView.get(next);

            if (!contentView || (!contentView.parent && contentView.canReuseDOM(child))) {
              child.reuseDOM(next);
            }
          }

          child.sync(view, track);

          child.flags &= ~ViewFlag.Dirty;
        }

        next = prev ? prev.nextSibling : parent.firstChild;

        if (track && !track.written && track.node == parent && next != child.dom) {
          track.written = true;
        }

        if (child.dom!.parentNode == parent) {
          while (next && next != child.dom) {
            next = rm(next);
          }
        } else {
          parent.insertBefore(child.dom!, next);
        }

        prev = child.dom!;
      }
      next = prev ? prev.nextSibling : parent.firstChild;

      if (next && track && track.node == parent) {
        track.written = true;
      }

      while (next) {
        next = rm(next);
      }
    } else if (this.flags & ViewFlag.ChildDirty) {
      for (const child of this.children) {
        if (child.flags & ViewFlag.Dirty) {
          child.sync(view, track);
          child.flags &= ~ViewFlag.Dirty;
        }
      }
    }
  }

  reuseDOM(_dom: Node) {}

  abstract domAtPos(pos: number): DOMPos;

  localPosFromDOM(node: Node, offset: number): number {
    let after: Node | null;

    if (node == this.dom) {
      after = this.dom.childNodes[offset];
    } else {
      let bias = maxOffset(node) == 0 ? 0 : offset == 0 ? -1 : 1;

      for (;;) {
        const parent = node.parentNode!;
        if (parent == this.dom) {
          break;
        }

        if (bias == 0 && parent.firstChild != parent.lastChild) {
          if (node == parent.firstChild) {
            bias = -1;
          } else {
            bias = 1;
          }
        }

        node = parent;
      }

      if (bias < 0) {
        after = node;
      } else {
        after = node.nextSibling;
      }
    }

    if (after == this.dom!.firstChild) {
      return 0;
    }

    while (after && !ContentView.get(after)) {
      after = after.nextSibling;
    }

    if (!after) return this.length;

    for (let i = 0, pos = 0; ; i++) {
      const child = this.children[i];

      if (child.dom == after) {
        return pos;
      }

      pos += child.length + child.breakAfter;
    }
  }

  domBoundsAround(
    from: number,
    to: number,
    offset = 0
  ): {
    startDOM: Node | null;
    endDOM: Node | null;
    from: number;
    to: number;
  } | null {
    let fromI = -1;
    let fromStart = -1;
    let toI = -1;
    let toEnd = -1;
    for (let i = 0, pos = offset, prevEnd = offset; i < this.children.length; i++) {
      const child = this.children[i];
      const end = pos + child.length;

      if (pos < from && end > to) {
        return child.domBoundsAround(from, to, pos);
      }

      if (end >= from && fromI == -1) {
        fromI = i;
        fromStart = pos;
      }

      if (pos > to && child.dom!.parentNode == this.dom) {
        toI = i;
        toEnd = prevEnd;
        break;
      }

      prevEnd = end;
      pos = end + child.breakAfter;
    }

    return {
      from: fromStart,
      to: toEnd < 0 ? offset + this.length : toEnd,
      startDOM: (fromI ? this.children[fromI - 1].dom!.nextSibling : null) || this.dom!.firstChild,
      endDOM: toI < this.children.length && toI >= 0 ? this.children[toI].dom : null,
    };
  }

  markDirty(andParent: boolean = false) {
    this.flags |= ViewFlag.NodeDirty;
    this.markParentsDirty(andParent);
  }

  markParentsDirty(childList: boolean) {
    for (let parent = this.parent; parent; parent = parent.parent) {
      if (childList) {
        parent.flags |= ViewFlag.NodeDirty;
      }

      if (parent.flags & ViewFlag.ChildDirty) {
        return;
      }

      parent.flags |= ViewFlag.ChildDirty;
      childList = false;
    }
  }

  setParent(parent: ContentView) {
    if (this.parent != parent) {
      this.parent = parent;

      if (this.flags & ViewFlag.Dirty) {
        this.markParentsDirty(true);
      }
    }
  }

  setDOM(dom: Node) {
    if (this.dom == dom) {
      return;
    }

    if (this.dom) {
      (this.dom as any).cmView = null;
    }

    this.dom = dom;
    (dom as any).cmView = this;
  }

  get rootView(): ContentView {
    for (let v: ContentView = this; ; ) {
      const parent = v.parent;

      if (!parent) {
        return v;
      }

      v = parent;
    }
  }

  replaceChildren(from: number, to: number, children: ContentView[] = noChildren) {
    this.markDirty();

    for (let i = from; i < to; i++) {
      const child = this.children[i];
      if (child.parent == this && children.indexOf(child) < 0) {
        child.destroy();
      }
    }

    if (children.length < 250) {
      this.children.splice(from, to - from, ...children);
    } else {
      this.children = ([] as ContentView[]).concat(
        this.children.slice(0, from),
        children,
        this.children.slice(to)
      );
    }

    for (let i = 0; i < children.length; i++) {
      children[i].setParent(this);
    }
  }

  ignoreMutation(_rec: MutationRecord): boolean {
    return false;
  }

  ignoreEvent(_event: Event): boolean {
    return false;
  }

  childCursor(pos: number = this.length) {
    return new ChildCursor(this.children, pos, this.children.length);
  }

  childPos(pos: number, bias: number = 1): { i: number; off: number } {
    return this.childCursor().findPos(pos, bias);
  }

  toString() {
    const name = this.constructor.name.replace("View", "");

    return (
      name +
      (this.children.length
        ? "(" + this.children.join() + ")"
        : this.length
        ? "[" + (name == "Text" ? (this as any).text : this.length) + "]"
        : "") +
      (this.breakAfter ? "#" : "")
    );
  }

  static get(node: Node): ContentView | null {
    return (node as any).cmView;
  }

  get isEditable() {
    return true;
  }

  get isWidget() {
    return false;
  }

  get isHidden() {
    return false;
  }

  merge(
    _from: number,
    _to: number,
    _source: ContentView | null,
    _hasStart: boolean,
    _openStart: number,
    _openEnd: number
  ): boolean {
    return false;
  }

  become(_other: ContentView): boolean {
    return false;
  }

  canReuseDOM(other: ContentView) {
    return (
      other.constructor == this.constructor && !((this.flags | other.flags) & ViewFlag.Composition)
    );
  }

  abstract split(at: number): ContentView;

  // When this is a zero-length view with a side, this should return a
  // number <= 0 to indicate it is before its position, or a
  // number > 0 when after its position.
  getSide() {
    return 0;
  }

  destroy() {
    for (const child of this.children) if (child.parent == this) child.destroy();
    this.parent = null;
  }
}

ContentView.prototype.breakAfter = 0;

/** 删除 DOM 节点并返回其下一个兄弟节点 */
function rm(dom: Node): Node | null {
  const next = dom.nextSibling;
  dom.parentNode!.removeChild(dom);
  return next;
}

export class ChildCursor {
  off: number = 0;

  constructor(public children: readonly ContentView[], public pos: number, public i: number) {}

  findPos(pos: number, bias: number = 1): this {
    for (;;) {
      if (
        pos > this.pos ||
        (pos == this.pos && (bias > 0 || this.i == 0 || this.children[this.i - 1].breakAfter))
      ) {
        this.off = pos - this.pos;
        return this;
      }
      const next = this.children[--this.i];
      this.pos -= next.length + next.breakAfter;
    }
  }
}

export function replaceRange(
  parent: ContentView,
  fromI: number,
  fromOff: number,
  toI: number,
  toOff: number,
  insert: ContentView[],
  breakAtStart: number,
  openStart: number,
  openEnd: number
) {
  const { children } = parent;
  const before = children.length ? children[fromI] : null;
  const last = insert.length ? insert[insert.length - 1] : null;
  const breakAtEnd = last ? last.breakAfter : breakAtStart;

  // Change within a single child
  if (
    fromI == toI &&
    before &&
    !breakAtStart &&
    !breakAtEnd &&
    insert.length < 2 &&
    before.merge(fromOff, toOff, insert.length ? last : null, fromOff == 0, openStart, openEnd)
  )
    return;

  if (toI < children.length) {
    let after = children[toI];

    // Make sure the end of the child after the update is preserved in `after`
    if (after && (toOff < after.length || (after.breakAfter && last?.breakAfter))) {
      // If we're splitting a child, separate part of it to avoid that
      // being mangled when updating the child before the update.
      if (fromI == toI) {
        after = after.split(toOff);
        toOff = 0;
      }

      // If the element after the replacement should be merged with
      // the last replacing element, update `content`
      if (!breakAtEnd && last && after.merge(0, toOff, last, true, 0, openEnd)) {
        insert[insert.length - 1] = after;
      } else {
        // Remove the start of the after element, if necessary, and
        // add it to `content`.
        if (toOff || (after.children.length && !after.children[0].length)) {
          after.merge(0, toOff, null, false, 0, openEnd);
        }

        insert.push(after);
      }
    } else if (after?.breakAfter) {
      // The element at `toI` is entirely covered by this range.
      // Preserve its line break, if any.
      if (last) {
        last.breakAfter = 1;
      } else {
        breakAtStart = 1;
      }
    }

    // Since we've handled the next element from the current elements
    // now, make sure `toI` points after that.
    toI++;
  }

  if (before) {
    before.breakAfter = breakAtStart;

    if (fromOff > 0) {
      if (
        !breakAtStart &&
        insert.length &&
        before.merge(fromOff, before.length, insert[0], false, openStart, 0)
      ) {
        before.breakAfter = insert.shift()!.breakAfter;
      } else if (
        fromOff < before.length ||
        (before.children.length && before.children[before.children.length - 1].length == 0)
      ) {
        before.merge(fromOff, before.length, null, false, openStart, 0);
      }

      fromI++;
    }
  }

  // Try to merge widgets on the boundaries of the replacement
  while (fromI < toI && insert.length) {
    if (children[toI - 1].become(insert[insert.length - 1])) {
      toI--;
      insert.pop();
      openEnd = insert.length ? 0 : openStart;
    } else if (children[fromI].become(insert[0])) {
      fromI++;
      insert.shift();
      openStart = insert.length ? 0 : openEnd;
    } else {
      break;
    }
  }
  if (
    !insert.length &&
    fromI &&
    toI < children.length &&
    !children[fromI - 1].breakAfter &&
    children[toI].merge(0, 0, children[fromI - 1], false, openStart, openEnd)
  )
    fromI--;

  if (fromI < toI || insert.length) {
    parent.replaceChildren(fromI, toI, insert);
  }
}

export function mergeChildrenInto(
  parent: ContentView,
  from: number,
  to: number,
  insert: ContentView[],
  openStart: number,
  openEnd: number
) {
  const cur = parent.childCursor();
  const { i: toI, off: toOff } = cur.findPos(to, 1);
  const { i: fromI, off: fromOff } = cur.findPos(from, -1);
  let dLen = from - to;
  for (const view of insert) {
    dLen += view.length;
  }
  parent.length += dLen;

  replaceRange(parent, fromI, fromOff, toI, toOff, insert, 0, openStart, openEnd);
}
