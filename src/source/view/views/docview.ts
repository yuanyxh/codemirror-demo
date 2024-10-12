import { ChangeSet, RangeSet, findClusterBreak, SelectionRange } from "@/state/index";
import { ContentView, ChildCursor, ViewFlag, DOMPos, replaceRange } from "./contentview";
import { BlockView, LineView, BlockWidgetView, BlockGapWidget } from "./blockview";
import { TextView, MarkView } from "../inlineview";
import { ContentBuilder } from "./buildview";
import browser from "../utils/browser";
import { Decoration, DecorationSet, addRange, MarkDecoration } from "../decorations/decoration";
import { getAttrs } from "../utils/attributes";
import {
  clientRectsFor,
  isEquivalentPosition,
  Rect,
  scrollRectIntoView,
  getSelection,
  hasSelection,
  textRange,
  DOMSelectionState,
  textNodeBefore,
  textNodeAfter,
} from "../utils/dom";
import {
  ViewUpdate,
  decorations as decorationsFacet,
  outerDecorations,
  ChangedRange,
  ScrollTarget,
  scrollHandler,
  getScrollMargins,
  logException,
  setEditContextFormatting,
} from "../extension";
import { EditorView } from "../editorview";
import { Direction } from "../utils/bidi";

/** 文档的视图 */

type Composition = {
  range: ChangedRange;
  text: Text;
  marks: { node: HTMLElement; deco: MarkDecoration }[];
  line: HTMLElement;
};

export class DocView extends ContentView {
  children!: BlockView[];

  decorations: readonly DecorationSet[] = [];
  dynamicDecorationMap: boolean[] = [false];
  domChanged: { newSel: SelectionRange | null } | null = null;
  hasComposition: { from: number; to: number } | null = null;
  markedForComposition: Set<ContentView> = new Set();
  editContextFormatting = Decoration.none;
  lastCompositionAfterCursor = false;

  // Track a minimum width for the editor. When measuring sizes in
  // measureVisibleLineHeights, this is updated to point at the width
  // of a given element and its extent in the document. When a change
  // happens in that range, these are reset. That way, once we've seen
  // a line/element of a given length, we keep the editor wide enough
  // to fit at least that element, until it is changed, at which point
  // we forget it again.
  minWidth = 0;
  minWidthFrom = 0;
  minWidthTo = 0;

  // Track whether the DOM selection was set in a lossy way, so that
  // we don't mess it up when reading it back it
  impreciseAnchor: DOMPos | null = null;
  impreciseHead: DOMPos | null = null;
  forceSelection = false;

  declare dom: HTMLElement;

  // Used by the resize observer to ignore resizes that we caused
  // ourselves
  lastUpdate = Date.now();

  get length() {
    return this.view.state.doc.length;
  }

  constructor(readonly view: EditorView) {
    super();

    this.setDOM(view.contentDOM);

    this.children = [new LineView()];
    this.children[0].setParent(this);

    this.updateDeco();

    this.updateInner([new ChangedRange(0, 0, 0, view.state.doc.length)], 0, null);
  }

  /** 将文档视图更新为给定状态 */
  update(update: ViewUpdate) {
    let changedRanges = update.changedRanges;

    if (this.minWidth > 0 && changedRanges.length) {
      if (
        !changedRanges.every(({ fromA, toA }) => toA < this.minWidthFrom || fromA > this.minWidthTo)
      ) {
        this.minWidth = this.minWidthFrom = this.minWidthTo = 0;
      } else {
        this.minWidthFrom = update.changes.mapPos(this.minWidthFrom, 1);
        this.minWidthTo = update.changes.mapPos(this.minWidthTo, 1);
      }
    }

    this.updateEditContextFormatting(update);

    let readCompositionAt = -1;
    if (this.view.inputState.composing >= 0 && !this.view.observer.editContext) {
      if (this.domChanged?.newSel) {
        readCompositionAt = this.domChanged.newSel.head;
      } else if (!touchesComposition(update.changes, this.hasComposition) && !update.selectionSet) {
        readCompositionAt = update.state.selection.main.head;
      }
    }

    const composition =
      readCompositionAt > -1
        ? findCompositionRange(this.view, update.changes, readCompositionAt)
        : null;

    this.domChanged = null;

    if (this.hasComposition) {
      this.markedForComposition.clear();

      const { from, to } = this.hasComposition;

      changedRanges = new ChangedRange(
        from,
        to,
        update.changes.mapPos(from, -1),
        update.changes.mapPos(to, 1)
      ).addToSet(changedRanges.slice());
    }

    this.hasComposition = composition
      ? { from: composition.range.fromB, to: composition.range.toB }
      : null;

    /**
     * 当选择周围的 DOM 节点移动到另一个父节点时，Chrome 有时会通过 getSelection 报告与实际向用户显示的选择不同的选择
     * 这会在连接线条时强制更新选择以解决此问题。问题#54
     */
    if (
      (browser.ie || browser.chrome) &&
      !composition &&
      update &&
      update.state.doc.lines != update.startState.doc.lines
    ) {
      this.forceSelection = true;
    }

    const prevDeco = this.decorations;
    const deco = this.updateDeco();
    const decoDiff = findChangedDeco(prevDeco, deco, update.changes);

    changedRanges = ChangedRange.extendWithRanges(changedRanges, decoDiff);

    if (!(this.flags & ViewFlag.Dirty) && changedRanges.length == 0) {
      return false;
    } else {
      this.updateInner(changedRanges, update.startState.doc.length, composition);

      if (update.transactions.length) {
        this.lastUpdate = Date.now();
      }

      return true;
    }
  }

  /** 由 update 和构造函数使用执行实际的 DOM 更新 */
  private updateInner(
    changes: readonly ChangedRange[],
    oldLength: number,
    composition: Composition | null
  ) {
    this.view.viewState.mustMeasureContent = true;

    this.updateChildren(changes, oldLength, composition);

    const { observer } = this.view;

    observer.ignore(() => {
      // Lock the height during redrawing, since Chrome sometimes
      // messes with the scroll position during DOM mutation (though
      // no relayout is triggered and I cannot imagine how it can
      // recompute the scroll position without a layout)
      this.dom.style.height = this.view.viewState.contentHeight / this.view.scaleY + "px";
      this.dom.style.flexBasis = this.minWidth ? this.minWidth + "px" : "";

      // Chrome will sometimes, when DOM mutations occur directly
      // around the selection, get confused and report a different
      // selection from the one it displays (issue #218). This tries
      // to detect that situation.
      const track =
        browser.chrome || browser.ios
          ? { node: observer.selectionRange.focusNode!, written: false }
          : undefined;

      this.sync(this.view, track);
      this.flags &= ~ViewFlag.Dirty;

      if (track && (track.written || observer.selectionRange.focusNode != track.node)) {
        this.forceSelection = true;
      }

      this.dom.style.height = "";
    });

    this.markedForComposition.forEach((cView) => (cView.flags &= ~ViewFlag.Composition));

    const gaps = [];

    if (this.view.viewport.from || this.view.viewport.to < this.view.state.doc.length) {
      for (const child of this.children) {
        if (child instanceof BlockWidgetView && child.widget instanceof BlockGapWidget) {
          gaps.push(child.dom!);
        }
      }
    }

    observer.updateGaps(gaps);
  }

  private updateChildren(
    changes: readonly ChangedRange[],
    oldLength: number,
    composition: Composition | null
  ) {
    const ranges = composition ? composition.range.addToSet(changes.slice()) : changes;
    const cursor = this.childCursor(oldLength);

    for (let i = ranges.length - 1; ; i--) {
      const next = i >= 0 ? ranges[i] : null;

      if (!next) {
        break;
      }

      const { fromA, toA, fromB, toB } = next;

      let content: BlockView[];
      let breakAtStart: number;
      let openStart: number;
      let openEnd: number;

      if (composition && composition.range.fromB < toB && composition.range.toB > fromB) {
        const before = ContentBuilder.build(
          this.view.state.doc,
          fromB,
          composition.range.fromB,
          this.decorations,
          this.dynamicDecorationMap
        );

        const after = ContentBuilder.build(
          this.view.state.doc,
          composition.range.toB,
          toB,
          this.decorations,
          this.dynamicDecorationMap
        );

        breakAtStart = before.breakAtStart;
        openStart = before.openStart;
        openEnd = after.openEnd;

        const compLine = this.compositionView(composition);

        if (after.breakAtStart) {
          compLine.breakAfter = 1;
        } else if (
          after.content.length &&
          compLine.merge(
            compLine.length,
            compLine.length,
            after.content[0],
            false,
            after.openStart,
            0
          )
        ) {
          compLine.breakAfter = after.content[0].breakAfter;
          after.content.shift();
        }

        if (
          before.content.length &&
          compLine.merge(0, 0, before.content[before.content.length - 1], true, 0, before.openEnd)
        ) {
          before.content.pop();
        }

        content = before.content.concat(compLine).concat(after.content);
      } else {
        ({ content, breakAtStart, openStart, openEnd } = ContentBuilder.build(
          this.view.state.doc,
          fromB,
          toB,
          this.decorations,
          this.dynamicDecorationMap
        ));
      }

      const { i: toI, off: toOff } = cursor.findPos(toA, 1);
      const { i: fromI, off: fromOff } = cursor.findPos(fromA, -1);

      replaceRange(this, fromI, fromOff, toI, toOff, content, breakAtStart, openStart, openEnd);
    }

    if (composition) {
      this.fixCompositionDOM(composition);
    }
  }

  private updateEditContextFormatting(update: ViewUpdate) {
    this.editContextFormatting = this.editContextFormatting.map(update.changes);

    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setEditContextFormatting)) {
          this.editContextFormatting = effect.value;
        }
      }
    }
  }

  private compositionView(composition: Composition) {
    let cur: ContentView = new TextView(composition.text.nodeValue!);

    cur.flags |= ViewFlag.Composition;

    for (const { deco } of composition.marks) {
      cur = new MarkView(deco, [cur], cur.length);
    }

    const line = new LineView();
    line.append(cur, 0);

    return line;
  }

  private fixCompositionDOM(composition: Composition) {
    const fix = (dom: Node, cView: ContentView) => {
      cView.flags |=
        ViewFlag.Composition |
        (cView.children.some((c) => c.flags & ViewFlag.Dirty) ? ViewFlag.ChildDirty : 0);

      this.markedForComposition.add(cView);

      const prev = ContentView.get(dom);

      if (prev && prev != cView) {
        prev.dom = null;
      }

      cView.setDOM(dom);
    };

    let pos = this.childPos(composition.range.fromB, 1);
    let cView: ContentView = this.children[pos.i];

    fix(composition.line, cView);

    for (let i = composition.marks.length - 1; i >= -1; i--) {
      pos = cView.childPos(pos.off, 1);
      cView = cView.children[pos.i];

      fix(i >= 0 ? composition.marks[i].node : composition.text, cView);
    }
  }

  // Sync the DOM selection to this.state.selection
  updateSelection(mustRead = false, fromPointer = false) {
    if (mustRead || !this.view.observer.selectionRange.focusNode) {
      this.view.observer.readSelectionRange();
    }

    const activeElt = this.view.root.activeElement;
    const focused = activeElt == this.dom;
    const selectionNotFocus =
      !focused &&
      hasSelection(this.dom, this.view.observer.selectionRange) &&
      !(activeElt && this.dom.contains(activeElt));

    if (!(focused || fromPointer || selectionNotFocus)) {
      return;
    }

    let force = this.forceSelection;
    this.forceSelection = false;

    const main = this.view.state.selection.main;
    let anchor = this.moveToLine(this.domAtPos(main.anchor));
    let head = main.empty ? anchor : this.moveToLine(this.domAtPos(main.head));

    // Always reset on Firefox when next to an uneditable node to
    // avoid invisible cursor bugs (#111)
    if (browser.gecko && main.empty && !this.hasComposition && betweenUneditable(anchor)) {
      const dummy = document.createTextNode("");

      this.view.observer.ignore(() =>
        anchor.node.insertBefore(dummy, anchor.node.childNodes[anchor.offset] || null)
      );

      anchor = head = new DOMPos(dummy, 0);
      force = true;
    }

    const domSel = this.view.observer.selectionRange;
    // If the selection is already here, or in an equivalent position, don't touch it
    if (
      force ||
      !domSel.focusNode ||
      ((!isEquivalentPosition(anchor.node, anchor.offset, domSel.anchorNode, domSel.anchorOffset) ||
        !isEquivalentPosition(head.node, head.offset, domSel.focusNode, domSel.focusOffset)) &&
        !this.suppressWidgetCursorChange(domSel, main))
    ) {
      this.view.observer.ignore(() => {
        // Chrome Android will hide the virtual keyboard when tapping
        // inside an uneditable node, and not bring it back when we
        // move the cursor to its proper position. This tries to
        // restore the keyboard by cycling focus.
        if (
          browser.android &&
          browser.chrome &&
          this.dom.contains(domSel.focusNode) &&
          inUneditable(domSel.focusNode, this.dom)
        ) {
          this.dom.blur();
          this.dom.focus({ preventScroll: true });
        }

        const rawSel = getSelection(this.view.root);

        if (!rawSel) {
          // No DOM selection for some reason—do nothing
        } else if (main.empty) {
          // Work around https://bugzilla.mozilla.org/show_bug.cgi?id=1612076
          if (browser.gecko) {
            const nextTo = nextToUneditable(anchor.node, anchor.offset);

            if (nextTo && nextTo != (NextTo.Before | NextTo.After)) {
              const text = (nextTo == NextTo.Before ? textNodeBefore : textNodeAfter)(
                anchor.node,
                anchor.offset
              );

              if (text) {
                anchor = new DOMPos(text.node, text.offset);
              }
            }
          }

          rawSel.collapse(anchor.node, anchor.offset);
          if (main.bidiLevel != null && (rawSel as any).caretBidiLevel !== undefined) {
            (rawSel as any).caretBidiLevel = main.bidiLevel;
          }
        } else if (rawSel.extend) {
          // Selection.extend can be used to create an 'inverted' selection
          // (one where the focus is before the anchor), but not all
          // browsers support it yet.
          rawSel.collapse(anchor.node, anchor.offset);

          // Safari will ignore the call above when the editor is
          // hidden, and then raise an error on the call to extend
          // (#940).
          try {
            rawSel.extend(head.node, head.offset);
          } catch (_) {
            /** empty */
          }
        } else {
          // Primitive (IE) way
          const range = document.createRange();

          if (main.anchor > main.head) {
            [anchor, head] = [head, anchor];
          }

          range.setEnd(head.node, head.offset);
          range.setStart(anchor.node, anchor.offset);
          rawSel.removeAllRanges();
          rawSel.addRange(range);
        }
        if (selectionNotFocus && this.view.root.activeElement == this.dom) {
          this.dom.blur();

          if (activeElt) {
            (activeElt as HTMLElement).focus();
          }
        }
      });

      this.view.observer.setSelectionRange(anchor, head);
    }

    this.impreciseAnchor = anchor.precise
      ? null
      : new DOMPos(domSel.anchorNode!, domSel.anchorOffset);
    this.impreciseHead = head.precise ? null : new DOMPos(domSel.focusNode!, domSel.focusOffset);
  }

  // If a zero-length widget is inserted next to the cursor during
  // composition, avoid moving it across it and disrupting the
  // composition.
  suppressWidgetCursorChange(sel: DOMSelectionState, cursor: SelectionRange) {
    return (
      this.hasComposition &&
      cursor.empty &&
      isEquivalentPosition(sel.focusNode!, sel.focusOffset, sel.anchorNode, sel.anchorOffset) &&
      this.posFromDOM(sel.focusNode!, sel.focusOffset) == cursor.head
    );
  }

  enforceCursorAssoc() {
    if (this.hasComposition) {
      return;
    }

    const { view } = this;
    const cursor = view.state.selection.main;
    const sel = getSelection(view.root);
    const { anchorNode, anchorOffset } = view.observer.selectionRange;

    if (!sel || !cursor.empty || !cursor.assoc || !sel.modify) {
      return;
    }

    const line = LineView.find(this, cursor.head);

    if (!line) {
      return;
    }

    const lineStart = line.posAtStart;
    if (cursor.head == lineStart || cursor.head == lineStart + line.length) {
      return;
    }

    const before = this.coordsAt(cursor.head, -1);
    const after = this.coordsAt(cursor.head, 1);

    if (!before || !after || before.bottom > after.top) {
      return;
    }

    const dom = this.domAtPos(cursor.head + cursor.assoc);

    sel.collapse(dom.node, dom.offset);
    sel.modify("move", cursor.assoc < 0 ? "forward" : "backward", "lineboundary");

    // This can go wrong in corner cases like single-character lines,
    // so check and reset if necessary.
    view.observer.readSelectionRange();

    const newRange = view.observer.selectionRange;

    if (view.docView.posFromDOM(newRange.anchorNode!, newRange.anchorOffset) != cursor.from) {
      sel.collapse(anchorNode, anchorOffset);
    }
  }

  // If a position is in/near a block widget, move it to a nearby text
  // line, since we don't want the cursor inside a block widget.
  moveToLine(pos: DOMPos) {
    // Block widgets will return positions before/after them, which
    // are thus directly in the document DOM element.
    const dom = this.dom!;
    let newPos!: DOMPos;
    if (pos.node != dom) return pos;
    for (let i = pos.offset; !newPos && i < dom.childNodes.length; i++) {
      const view = ContentView.get(dom.childNodes[i]);

      if (view instanceof LineView) {
        newPos = view.domAtPos(0);
      }
    }

    for (let i = pos.offset - 1; !newPos && i >= 0; i--) {
      const view = ContentView.get(dom.childNodes[i]);

      if (view instanceof LineView) {
        newPos = view.domAtPos(view.length);
      }
    }

    return newPos ? new DOMPos(newPos.node, newPos.offset, true) : pos;
  }

  nearest(dom: Node): ContentView | null {
    for (let cur: Node | null = dom; cur; ) {
      const domView = ContentView.get(cur);

      if (domView && domView.rootView == this) {
        return domView;
      }

      cur = cur.parentNode;
    }
    return null;
  }

  posFromDOM(node: Node, offset: number): number {
    const view = this.nearest(node);
    if (!view) {
      throw new RangeError("Trying to find position for a DOM position outside of the document");
    }

    return view.localPosFromDOM(node, offset) + view.posAtStart;
  }

  domAtPos(pos: number): DOMPos {
    let { i, off } = this.childCursor().findPos(pos, -1);

    for (; i < this.children.length - 1; ) {
      const child = this.children[i];

      if (off < child.length || child instanceof LineView) {
        break;
      }

      i++;
      off = 0;
    }

    return this.children[i].domAtPos(off);
  }

  coordsAt(pos: number, side: number): Rect | null {
    let best = null;
    let bestPos = 0;

    for (let off = this.length, i = this.children.length - 1; i >= 0; i--) {
      const child = this.children[i];
      const end = off - child.breakAfter;
      const start = end - child.length;

      if (end < pos) {
        break;
      }

      if (
        start <= pos &&
        (start < pos || child.covers(-1)) &&
        (end > pos || child.covers(1)) &&
        (!best || (child instanceof LineView && !(best instanceof LineView && side >= 0)))
      ) {
        best = child;
        bestPos = start;
      } else if (
        best &&
        start == pos &&
        end == pos &&
        child instanceof BlockWidgetView &&
        Math.abs(side) < 2
      ) {
        if (child.deco.startSide < 0) {
          break;
        } else if (i) {
          best = null;
        }
      }

      off = start;
    }

    return best ? best.coordsAt(pos - bestPos, side) : null;
  }

  coordsForChar(pos: number) {
    const _pos = this.childPos(pos, 1);

    const i = _pos.i;
    let off = _pos.off;
    let child: ContentView = this.children[i];

    if (!(child instanceof LineView)) {
      return null;
    }

    while (child.children.length) {
      const _pos2 = child.childPos(off, 1);
      let { i } = _pos2;
      const childOff = _pos2.off;

      for (; ; i++) {
        if (i == child.children.length) {
          return null;
        }

        if ((child = child.children[i]).length) {
          break;
        }
      }

      off = childOff;
    }
    if (!(child instanceof TextView)) {
      return null;
    }

    const end = findClusterBreak(child.text, off);

    if (end == off) {
      return null;
    }

    const rects = textRange(child.dom as Text, off, end).getClientRects();

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];

      if (i == rects.length - 1 || (rect.top < rect.bottom && rect.left < rect.right)) {
        return rect;
      }
    }

    return null;
  }

  measureVisibleLineHeights(viewport: { from: number; to: number }) {
    const result = [];
    const { from, to } = viewport;
    const contentWidth = this.view.contentDOM.clientWidth;
    const isWider = contentWidth > Math.max(this.view.scrollDOM.clientWidth, this.minWidth) + 1;
    const ltr = this.view.textDirection == Direction.LTR;
    let widest = -1;

    for (let pos = 0, i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      const end = pos + child.length;
      if (end > to) {
        break;
      }

      if (pos >= from) {
        const childRect = child.dom!.getBoundingClientRect();
        result.push(childRect.height);

        if (isWider) {
          const last = child.dom!.lastChild;
          const rects = last ? clientRectsFor(last) : [];

          if (rects.length) {
            const rect = rects[rects.length - 1];
            const width = ltr ? rect.right - childRect.left : childRect.right - rect.left;

            if (width > widest) {
              widest = width;
              this.minWidth = contentWidth;
              this.minWidthFrom = pos;
              this.minWidthTo = end;
            }
          }
        }
      }

      pos = end + child.breakAfter;
    }

    return result;
  }

  textDirectionAt(pos: number) {
    const { i } = this.childPos(pos, 1);

    return getComputedStyle(this.children[i].dom!).direction == "rtl"
      ? Direction.RTL
      : Direction.LTR;
  }

  measureTextSize(): { lineHeight: number; charWidth: number; textHeight: number } {
    for (const child of this.children) {
      if (child instanceof LineView) {
        const measure = child.measureTextSize();
        if (measure) return measure;
      }
    }
    // If no workable line exists, force a layout of a measurable element
    const dummy = document.createElement("div");

    let lineHeight!: number;
    let charWidth!: number;
    let textHeight!: number;

    dummy.className = "cm-line";
    dummy.style.width = "99999px";
    dummy.style.position = "absolute";
    dummy.textContent = "abc def ghi jkl mno pqr stu";

    this.view.observer.ignore(() => {
      this.dom.appendChild(dummy);

      const rect = clientRectsFor(dummy.firstChild!)[0];

      lineHeight = dummy.getBoundingClientRect().height;
      charWidth = rect ? rect.width / 27 : 7;
      textHeight = rect ? rect.height : lineHeight;

      dummy.remove();
    });

    return { lineHeight, charWidth, textHeight };
  }

  childCursor(pos: number = this.length): ChildCursor {
    // Move back to start of last element when possible, so that
    // `ChildCursor.findPos` doesn't have to deal with the edge case
    // of being after the last element.
    let i = this.children.length;

    if (i) {
      pos -= this.children[--i].length;
    }
    return new ChildCursor(this.children, pos, i);
  }

  computeBlockGapDeco(): DecorationSet {
    const deco = [],
      vs = this.view.viewState;
    for (let pos = 0, i = 0; ; i++) {
      const next = i == vs.viewports.length ? null : vs.viewports[i];
      const end = next ? next.from - 1 : this.length;
      if (end > pos) {
        const height = (vs.lineBlockAt(end).bottom - vs.lineBlockAt(pos).top) / this.view.scaleY;
        deco.push(
          Decoration.replace({
            widget: new BlockGapWidget(height),
            block: true,
            inclusive: true,
            isBlockGap: true,
          }).range(pos, end)
        );
      }
      if (!next) break;
      pos = next.to + 1;
    }
    return Decoration.set(deco);
  }

  updateDeco() {
    let i = 1;

    const allDeco = this.view.state.facet(decorationsFacet).map((d) => {
      const dynamic = (this.dynamicDecorationMap[i++] = typeof d == "function");
      return dynamic ? (d as (view: EditorView) => DecorationSet)(this.view) : (d as DecorationSet);
    });

    let dynamicOuter = false;

    const outerDeco = this.view.state.facet(outerDecorations).map((d, _i) => {
      const dynamic = typeof d == "function";

      if (dynamic) {
        dynamicOuter = true;
      }

      return dynamic ? (d as (view: EditorView) => DecorationSet)(this.view) : (d as DecorationSet);
    });

    if (outerDeco.length) {
      this.dynamicDecorationMap[i++] = dynamicOuter;
      allDeco.push(RangeSet.join(outerDeco));
    }

    this.decorations = [
      this.editContextFormatting,
      ...allDeco,
      this.computeBlockGapDeco(),
      this.view.viewState.lineGapDeco,
    ];

    while (i < this.decorations.length) {
      this.dynamicDecorationMap[i++] = false;
    }

    return this.decorations;
  }

  scrollIntoView(target: ScrollTarget) {
    if (target.isSnapshot) {
      const ref = this.view.viewState.lineBlockAt(target.range.head);
      this.view.scrollDOM.scrollTop = ref.top - target.yMargin;
      this.view.scrollDOM.scrollLeft = target.xMargin;
      return;
    }

    for (const handler of this.view.state.facet(scrollHandler)) {
      try {
        if (handler(this.view, target.range, target)) return true;
      } catch (e) {
        logException(this.view.state, e, "scroll handler");
      }
    }

    const { range } = target;
    let rect = this.coordsAt(
        range.head,
        range.empty ? range.assoc : range.head > range.anchor ? -1 : 1
      ),
      other;
    if (!rect) return;
    if (!range.empty && (other = this.coordsAt(range.anchor, range.anchor > range.head ? -1 : 1)))
      rect = {
        left: Math.min(rect.left, other.left),
        top: Math.min(rect.top, other.top),
        right: Math.max(rect.right, other.right),
        bottom: Math.max(rect.bottom, other.bottom),
      };

    const margins = getScrollMargins(this.view);
    const targetRect = {
      left: rect.left - margins.left,
      top: rect.top - margins.top,
      right: rect.right + margins.right,
      bottom: rect.bottom + margins.bottom,
    };
    const { offsetWidth, offsetHeight } = this.view.scrollDOM;
    scrollRectIntoView(
      this.view.scrollDOM,
      targetRect,
      range.head < range.anchor ? -1 : 1,
      target.x,
      target.y,
      Math.max(Math.min(target.xMargin, offsetWidth), -offsetWidth),
      Math.max(Math.min(target.yMargin, offsetHeight), -offsetHeight),
      this.view.textDirection == Direction.LTR
    );
  }

  // Will never be called but needs to be present
  split!: () => ContentView;
}

function betweenUneditable(pos: DOMPos) {
  return (
    pos.node.nodeType == 1 &&
    pos.node.firstChild &&
    (pos.offset == 0 ||
      (pos.node.childNodes[pos.offset - 1] as HTMLElement).contentEditable == "false") &&
    (pos.offset == pos.node.childNodes.length ||
      (pos.node.childNodes[pos.offset] as HTMLElement).contentEditable == "false")
  );
}

export function findCompositionNode(
  view: EditorView,
  headPos: number
): { from: number; to: number; node: Text } | null {
  const sel = view.observer.selectionRange;
  if (!sel.focusNode) return null;
  const textBefore = textNodeBefore(sel.focusNode, sel.focusOffset);
  const textAfter = textNodeAfter(sel.focusNode, sel.focusOffset);
  let textNode = textBefore || textAfter;
  if (textAfter && textBefore && textAfter.node != textBefore.node) {
    const descAfter = ContentView.get(textAfter.node);
    if (
      !descAfter ||
      (descAfter instanceof TextView && descAfter.text != textAfter.node.nodeValue)
    ) {
      textNode = textAfter;
    } else if (view.docView.lastCompositionAfterCursor) {
      const descBefore = ContentView.get(textBefore.node);
      if (
        !(
          !descBefore ||
          (descBefore instanceof TextView && descBefore.text != textBefore.node.nodeValue)
        )
      )
        textNode = textAfter;
    }
  }
  view.docView.lastCompositionAfterCursor = textNode != textBefore;

  if (!textNode) return null;
  const from = headPos - textNode.offset;
  return { from, to: from + textNode.node.nodeValue!.length, node: textNode.node };
}

function findCompositionRange(
  view: EditorView,
  changes: ChangeSet,
  headPos: number
): Composition | null {
  const found = findCompositionNode(view, headPos);

  if (!found) {
    return null;
  }

  const { node: textNode, from, to } = found;
  const text = textNode.nodeValue!;
  // Don't try to preserve multi-line compositions
  if (/[\n\r]/.test(text)) return null;
  if (view.state.doc.sliceString(found.from, found.to) != text) return null;

  const inv = changes.invertedDesc;
  const range = new ChangedRange(inv.mapPos(from), inv.mapPos(to), from, to);
  const marks: { node: HTMLElement; deco: MarkDecoration }[] = [];
  for (
    let parent = textNode.parentNode as HTMLElement;
    ;
    parent = parent.parentNode as HTMLElement
  ) {
    const parentView = ContentView.get(parent);
    if (parentView instanceof MarkView) marks.push({ node: parent, deco: parentView.mark });
    else if (
      parentView instanceof LineView ||
      (parent.nodeName == "DIV" && parent.parentNode == view.contentDOM)
    )
      return { range, text: textNode, marks, line: parent as HTMLElement };
    else if (parent != view.contentDOM)
      marks.push({
        node: parent,
        deco: new MarkDecoration({
          inclusive: true,
          attributes: getAttrs(parent),
          tagName: parent.tagName.toLowerCase(),
        }),
      });
    else return null;
  }
}

const enum NextTo {
  Before = 1,
  After = 2,
}

function nextToUneditable(node: Node, offset: number) {
  if (node.nodeType != 1) return 0;
  return (
    (offset && (node.childNodes[offset - 1] as any).contentEditable == "false"
      ? NextTo.Before
      : 0) |
    (offset < node.childNodes.length && (node.childNodes[offset] as any).contentEditable == "false"
      ? NextTo.After
      : 0)
  );
}

class DecorationComparator {
  changes: number[] = [];
  compareRange(from: number, to: number) {
    addRange(from, to, this.changes);
  }
  comparePoint(from: number, to: number) {
    addRange(from, to, this.changes);
  }
}

function findChangedDeco(
  a: readonly DecorationSet[],
  b: readonly DecorationSet[],
  diff: ChangeSet
) {
  const comp = new DecorationComparator();
  RangeSet.compare(a, b, diff, comp);
  return comp.changes;
}

function inUneditable(node: Node | null, inside: HTMLElement) {
  for (
    let cur = node;
    cur && cur != inside;
    cur = (cur as HTMLElement).assignedSlot || cur.parentNode
  ) {
    if (cur.nodeType == 1 && (cur as HTMLElement).contentEditable == "false") {
      return true;
    }
  }
  return false;
}

function touchesComposition(changes: ChangeSet, composition: null | { from: number; to: number }) {
  let touched = false;
  if (composition)
    changes.iterChangedRanges((from, to) => {
      if (from < composition!.to && to > composition!.from) touched = true;
    });
  return touched;
}
