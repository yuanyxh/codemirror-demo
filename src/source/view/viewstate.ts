import { Text, EditorState, ChangeSet, ChangeDesc, RangeSet, EditorSelection } from "@/state/index";
import { Rect, isScrolledToBottom, getScale } from "./utils/dom";
import {
  HeightMap,
  HeightOracle,
  BlockInfo,
  MeasuredHeights,
  QueryType,
  heightRelevantDecoChanges,
  clearHeightChangeFlag,
  heightChangeFlag,
} from "./utils/heightmap";
import {
  decorations,
  ViewUpdate,
  UpdateFlag,
  ChangedRange,
  ScrollTarget,
  nativeSelectionHidden,
  contentAttributes,
} from "./extensions/extension";
import { WidgetType, Decoration, DecorationSet, BlockType } from "./decorations/decoration";
import { EditorView } from "./editorview";
import { Direction } from "./utils/bidi";

function visiblePixelRange(dom: HTMLElement, paddingTop: number): Rect {
  const rect = dom.getBoundingClientRect();

  const doc = dom.ownerDocument;
  const win = doc.defaultView || window;

  let left = Math.max(0, rect.left);
  let right = Math.min(win.innerWidth, rect.right);
  let top = Math.max(0, rect.top);
  let bottom = Math.min(win.innerHeight, rect.bottom);

  for (let parent = dom.parentNode as Node | null; parent && parent != doc.body; ) {
    if (parent.nodeType == 1) {
      const elt = parent as HTMLElement;
      const style = window.getComputedStyle(elt);

      if (
        (elt.scrollHeight > elt.clientHeight || elt.scrollWidth > elt.clientWidth) &&
        style.overflow != "visible"
      ) {
        const parentRect = elt.getBoundingClientRect();
        left = Math.max(left, parentRect.left);
        right = Math.min(right, parentRect.right);
        top = Math.max(top, parentRect.top);
        bottom = Math.min(parent == dom.parentNode ? win.innerHeight : bottom, parentRect.bottom);
      }

      parent =
        style.position == "absolute" || style.position == "fixed"
          ? elt.offsetParent
          : elt.parentNode;
    } else if (parent.nodeType == 11) {
      // Shadow root
      parent = (parent as ShadowRoot).host;
    } else {
      break;
    }
  }

  return {
    left: left - rect.left,
    right: Math.max(left, right) - rect.left,
    top: top - (rect.top + paddingTop),
    bottom: Math.max(top, bottom) - (rect.top + paddingTop),
  };
}

function fullPixelRange(dom: HTMLElement, paddingTop: number): Rect {
  const rect = dom.getBoundingClientRect();

  return {
    left: 0,
    right: rect.right - rect.left,
    top: paddingTop,
    bottom: rect.bottom - (rect.top + paddingTop),
  };
}

const enum VP {
  // FIXME look into appropriate value of this through benchmarking etc
  Margin = 1000,
  // coveredBy requires at least this many extra pixels to be covered
  MinCoverMargin = 10,
  MaxCoverMargin = VP.Margin / 4,
  // Beyond this size, DOM layout starts to break down in browsers
  // because they use fixed-precision numbers to store dimensions.
  MaxDOMHeight = 7e6,
  MaxHorizGap = 2e6,
}

// Line gaps are placeholder widgets used to hide pieces of overlong
// lines within the viewport, as a kludge to keep the editor
// responsive when a ridiculously long line is loaded into it.
export class LineGap {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly size: number,
    readonly displaySize: number
  ) {}

  static same(a: readonly LineGap[], b: readonly LineGap[]) {
    if (a.length != b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      const gA = a[i];
      const gB = b[i];

      if (gA.from != gB.from || gA.to != gB.to || gA.size != gB.size) {
        return false;
      }
    }

    return true;
  }

  draw(viewState: ViewState, wrapping: boolean) {
    return Decoration.replace({
      widget: new LineGapWidget(
        this.displaySize * (wrapping ? viewState.scaleY : viewState.scaleX),
        wrapping
      ),
    }).range(this.from, this.to);
  }
}

class LineGapWidget extends WidgetType {
  constructor(readonly size: number, readonly vertical: boolean) {
    super();
  }

  eq(other: LineGapWidget) {
    return other.size == this.size && other.vertical == this.vertical;
  }

  toDOM() {
    const elt = document.createElement("div");
    if (this.vertical) {
      elt.style.height = this.size + "px";
    } else {
      elt.style.width = this.size + "px";
      elt.style.height = "2px";
      elt.style.display = "inline-block";
    }
    return elt;
  }

  get estimatedHeight() {
    return this.vertical ? this.size : -1;
  }
}

const enum LG {
  Margin = 2000,
  MarginWrap = 10000,
  SelectionMargin = 10,
}

/** view 与 state 的桥接层 */
export class ViewState {
  /** 可编辑 dom 的 rect */
  pixelViewport: Rect = { left: 0, right: window.innerWidth, top: 0, bottom: 0 };

  /** 编辑器是否可见 */
  inView = true;

  /** 距离文档上方 */
  paddingTop = 0;

  /** 距离文档下方 */
  paddingBottom = 0;

  /** 可编辑 dom 宽 */
  contentDOMWidth = 0;

  /** 可编辑 dom 高 */
  contentDOMHeight = 0; // contentDOM.getBoundingClientRect().height

  /** 滚动容器高度 */
  editorHeight = 0;

  /** 滚动容器宽度 */
  editorWidth = 0;

  /** 滚动容器已滚动距离 */
  scrollTop = 0;

  /** 是否已滚动到底部 */
  scrolledToBottom = false;

  /** 编辑器缩放大小 */
  scaleX = 1;
  scaleY = 1;

  /** 锚定滚动位置的垂直位置（相对于文档）。 -1 表示锚定到文档末尾。 */
  scrollAnchorPos = 0;

  /** 锚点位置的高度。由 DOM 更新阶段设置。 -1 表示没有可用高度。 */
  scrollAnchorHeight = -1;

  heightOracle: HeightOracle;

  heightMap: HeightMap;

  // See VP.MaxDOMHeight
  scaler = IdScaler;

  /** 滚动目标 */
  scrollTarget: ScrollTarget | null = null;

  // 是否打印中，打印时短暂设置为 true，以禁用视口限制
  printing = false;

  /** 重绘内容时设置为 true，为 true 时测量阶段知道需要重新读取 dom 布局 */
  mustMeasureContent = true;

  stateDeco: readonly DecorationSet[];

  viewportLines!: BlockInfo[];

  defaultTextDirection: Direction = Direction.LTR;

  /** 可见文档部分的 viewport */
  viewport!: Viewport;

  /**
   * 如果主选择在主视口之外开始或结束，则会为这些点创建额外的单线视口，以便 DOM 选择不会落在间隙中
   */
  viewports!: readonly Viewport[];

  /** 可视范围 */
  visibleRanges: readonly { from: number; to: number }[] = [];

  /** 隐藏的行 */
  lineGaps: readonly LineGap[];

  /** 隐藏的行装饰器 */
  lineGapDeco: DecorationSet;

  // Cursor 'assoc' is only significant when the cursor is on a line
  // wrap point, where it must stick to the character that it is
  // associated with. Since browsers don't provide a reasonable
  // interface to set or query this, when a selection is set that
  // might cause this to be significant, this flag is set. The next
  // measure phase will check whether the cursor is on a line-wrapping
  // boundary and, if so, reset it to make sure it is positioned in
  // the right place.
  mustEnforceCursorAssoc = false;

  constructor(public state: EditorState) {
    // 可编辑 dom 是否启用了 lineWrapping 扩展
    const guessWrapping = state
      .facet(contentAttributes)
      .some((v) => typeof v != "function" && v.class == "cm-lineWrapping");

    // 创建高度测量工具
    this.heightOracle = new HeightOracle(guessWrapping);

    // 获取所有非函数的装饰器集
    this.stateDeco = state
      .facet(decorations)
      .filter((d) => typeof d != "function") as readonly DecorationSet[];

    // 应用更改到 HeightMap
    // 初始化, 应用整个文档
    this.heightMap = HeightMap.empty().applyChanges(
      this.stateDeco,
      Text.empty,
      this.heightOracle.setDoc(state.doc),
      [new ChangedRange(0, 0, 0, state.doc.length)]
    );

    for (let i = 0; i < 2; i++) {
      // 获取可视视口区间
      this.viewport = this.getViewport(0, null);

      if (!this.updateForViewport()) {
        break;
      }
    }

    // 更新可视区内的行
    this.updateViewportLines();

    /** 计算并获取应该隐藏的行 */
    this.lineGaps = this.ensureLineGaps([]);

    // 获取隐藏的行装饰器
    this.lineGapDeco = Decoration.set(this.lineGaps.map((gap) => gap.draw(this, false)));

    this.computeVisibleRanges();
  }

  updateForViewport() {
    const viewports = [this.viewport];

    const { main } = this.state.selection;

    for (let i = 0; i <= 1; i++) {
      const pos = i ? main.head : main.anchor;

      if (!viewports.some(({ from, to }) => pos >= from && pos <= to)) {
        const { from, to } = this.lineBlockAt(pos);

        viewports.push(new Viewport(from, to));
      }
    }

    this.viewports = viewports.sort((a, b) => a.from - b.from);

    return this.updateScaler();
  }

  /** 更新缩放系数 */
  updateScaler() {
    const scaler = this.scaler;
    this.scaler =
      this.heightMap.height <= VP.MaxDOMHeight
        ? IdScaler
        : new BigScaler(this.heightOracle, this.heightMap, this.viewports);

    return scaler.eq(this.scaler) ? 0 : UpdateFlag.Height;
  }

  /** 更新可视视口中的行  */
  updateViewportLines() {
    this.viewportLines = [];

    this.heightMap.forEachLine(
      this.viewport.from,
      this.viewport.to,
      this.heightOracle.setDoc(this.state.doc),
      0,
      0,
      (block) => {
        this.viewportLines.push(scaleBlock(block, this.scaler));
      }
    );
  }

  update(update: ViewUpdate, scrollTarget: ScrollTarget | null = null) {
    this.state = update.state;
    const prevDeco = this.stateDeco;
    this.stateDeco = this.state
      .facet(decorations)
      .filter((d) => typeof d != "function") as readonly DecorationSet[];
    const contentChanges = update.changedRanges;

    const heightChanges = ChangedRange.extendWithRanges(
      contentChanges,
      heightRelevantDecoChanges(
        prevDeco,
        this.stateDeco,
        update ? update.changes : ChangeSet.empty(this.state.doc.length)
      )
    );
    const prevHeight = this.heightMap.height;
    const scrollAnchor = this.scrolledToBottom ? null : this.scrollAnchorAt(this.scrollTop);
    clearHeightChangeFlag();
    this.heightMap = this.heightMap.applyChanges(
      this.stateDeco,
      update.startState.doc,
      this.heightOracle.setDoc(this.state.doc),
      heightChanges
    );
    if (this.heightMap.height != prevHeight || heightChangeFlag) update.flags |= UpdateFlag.Height;
    if (scrollAnchor) {
      this.scrollAnchorPos = update.changes.mapPos(scrollAnchor.from, -1);
      this.scrollAnchorHeight = scrollAnchor.top;
    } else {
      this.scrollAnchorPos = -1;
      this.scrollAnchorHeight = this.heightMap.height;
    }

    let viewport = heightChanges.length
      ? this.mapViewport(this.viewport, update.changes)
      : this.viewport;
    if (
      (scrollTarget &&
        (scrollTarget.range.head < viewport.from || scrollTarget.range.head > viewport.to)) ||
      !this.viewportIsAppropriate(viewport)
    )
      viewport = this.getViewport(0, scrollTarget);
    const viewportChange = viewport.from != this.viewport.from || viewport.to != this.viewport.to;
    this.viewport = viewport;
    update.flags |= this.updateForViewport();
    if (viewportChange || !update.changes.empty || update.flags & UpdateFlag.Height)
      this.updateViewportLines();

    if (this.lineGaps.length || this.viewport.to - this.viewport.from > LG.Margin << 1)
      this.updateLineGaps(this.ensureLineGaps(this.mapLineGaps(this.lineGaps, update.changes)));
    update.flags |= this.computeVisibleRanges();

    if (scrollTarget) this.scrollTarget = scrollTarget;

    if (
      !this.mustEnforceCursorAssoc &&
      update.selectionSet &&
      update.view.lineWrapping &&
      update.state.selection.main.empty &&
      update.state.selection.main.assoc &&
      !update.state.facet(nativeSelectionHidden)
    )
      this.mustEnforceCursorAssoc = true;
  }

  measure(view: EditorView) {
    const dom = view.contentDOM;
    const style = window.getComputedStyle(dom);

    const oracle = this.heightOracle;
    const whiteSpace = style.whiteSpace;

    this.defaultTextDirection = style.direction == "rtl" ? Direction.RTL : Direction.LTR;

    let refresh = this.heightOracle.mustRefreshForWrapping(whiteSpace);

    const domRect = dom.getBoundingClientRect();

    let measureContent =
      refresh || this.mustMeasureContent || this.contentDOMHeight != domRect.height;

    this.contentDOMHeight = domRect.height;
    this.mustMeasureContent = false;
    let result = 0,
      bias = 0;

    if (domRect.width && domRect.height) {
      const { scaleX, scaleY } = getScale(dom, domRect);

      if (
        (scaleX > 0.005 && Math.abs(this.scaleX - scaleX) > 0.005) ||
        (scaleY > 0.005 && Math.abs(this.scaleY - scaleY) > 0.005)
      ) {
        this.scaleX = scaleX;
        this.scaleY = scaleY;
        result |= UpdateFlag.Geometry;
        refresh = measureContent = true;
      }
    }

    // Vertical padding
    const paddingTop = (parseInt(style.paddingTop!) || 0) * this.scaleY;
    const paddingBottom = (parseInt(style.paddingBottom!) || 0) * this.scaleY;

    if (this.paddingTop != paddingTop || this.paddingBottom != paddingBottom) {
      this.paddingTop = paddingTop;
      this.paddingBottom = paddingBottom;

      result |= UpdateFlag.Geometry | UpdateFlag.Height;
    }

    if (this.editorWidth != view.scrollDOM.clientWidth) {
      if (oracle.lineWrapping) measureContent = true;
      this.editorWidth = view.scrollDOM.clientWidth;
      result |= UpdateFlag.Geometry;
    }

    const scrollTop = view.scrollDOM.scrollTop * this.scaleY;

    if (this.scrollTop != scrollTop) {
      this.scrollAnchorHeight = -1;
      this.scrollTop = scrollTop;
    }

    this.scrolledToBottom = isScrolledToBottom(view.scrollDOM);

    // Pixel viewport
    const pixelViewport = (this.printing ? fullPixelRange : visiblePixelRange)(
      dom,
      this.paddingTop
    );

    const dTop = pixelViewport.top - this.pixelViewport.top;
    const dBottom = pixelViewport.bottom - this.pixelViewport.bottom;

    this.pixelViewport = pixelViewport;

    const inView =
      this.pixelViewport.bottom > this.pixelViewport.top &&
      this.pixelViewport.right > this.pixelViewport.left;

    if (inView != this.inView) {
      this.inView = inView;

      if (inView) {
        measureContent = true;
      }
    }

    if (!this.inView && !this.scrollTarget) {
      return 0;
    }

    const contentWidth = domRect.width;

    if (this.contentDOMWidth != contentWidth || this.editorHeight != view.scrollDOM.clientHeight) {
      this.contentDOMWidth = domRect.width;
      this.editorHeight = view.scrollDOM.clientHeight;

      result |= UpdateFlag.Geometry;
    }

    if (measureContent) {
      const lineHeights = view.docView.measureVisibleLineHeights(this.viewport);

      if (oracle.mustRefreshForHeights(lineHeights)) {
        refresh = true;
      }

      if (
        refresh ||
        (oracle.lineWrapping && Math.abs(contentWidth - this.contentDOMWidth) > oracle.charWidth)
      ) {
        const { lineHeight, charWidth, textHeight } = view.docView.measureTextSize();

        refresh =
          lineHeight > 0 &&
          oracle.refresh(
            whiteSpace,
            lineHeight,
            charWidth,
            textHeight,
            contentWidth / charWidth,
            lineHeights
          );

        if (refresh) {
          view.docView.minWidth = 0;
          result |= UpdateFlag.Geometry;
        }
      }

      if (dTop > 0 && dBottom > 0) {
        bias = Math.max(dTop, dBottom);
      } else if (dTop < 0 && dBottom < 0) {
        bias = Math.min(dTop, dBottom);
      }

      clearHeightChangeFlag();

      for (const vp of this.viewports) {
        const heights =
          vp.from == this.viewport.from ? lineHeights : view.docView.measureVisibleLineHeights(vp);

        this.heightMap = (
          refresh
            ? HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle, [
                new ChangedRange(0, 0, 0, view.state.doc.length),
              ])
            : this.heightMap
        ).updateHeight(oracle, 0, refresh, new MeasuredHeights(vp.from, heights));
      }

      if (heightChangeFlag) {
        result |= UpdateFlag.Height;
      }
    }

    const viewportChange =
      !this.viewportIsAppropriate(this.viewport, bias) ||
      (this.scrollTarget &&
        (this.scrollTarget.range.head < this.viewport.from ||
          this.scrollTarget.range.head > this.viewport.to));

    if (viewportChange) {
      if (result & UpdateFlag.Height) {
        result |= this.updateScaler();
      }

      this.viewport = this.getViewport(bias, this.scrollTarget);
      result |= this.updateForViewport();
    }

    if (result & UpdateFlag.Height || viewportChange) {
      this.updateViewportLines();
    }

    if (this.lineGaps.length || this.viewport.to - this.viewport.from > LG.Margin << 1) {
      this.updateLineGaps(this.ensureLineGaps(refresh ? [] : this.lineGaps, view));
    }

    result |= this.computeVisibleRanges();

    if (this.mustEnforceCursorAssoc) {
      this.mustEnforceCursorAssoc = false;

      /**
       * 这是在读取阶段完成的，因为将选择移动到行尾无论如何都会触发布局，所以它不能是纯写入
       * 它应该很少有任何写作
       * */
      view.docView.enforceCursorAssoc();
    }

    return result;
  }

  get visibleTop() {
    return this.scaler.fromDOM(this.pixelViewport.top);
  }
  get visibleBottom() {
    return this.scaler.fromDOM(this.pixelViewport.bottom);
  }

  /** 获取可视视口区间 */
  getViewport(bias: number, scrollTarget: ScrollTarget | null): Viewport {
    // 根据偏差（自上次更新以来视口位置的变化）将 VP.Margin 划分为顶部和底部。它将保存 0 到 1 之间的数字
    const marginTop = 0.5 - Math.max(-0.5, Math.min(0.5, bias / VP.Margin / 2));

    const map = this.heightMap;
    const oracle = this.heightOracle;

    const { visibleTop, visibleBottom } = this;

    let viewport = new Viewport(
      map.lineAt(visibleTop - marginTop * VP.Margin, QueryType.ByHeight, oracle, 0, 0).from,
      map.lineAt(visibleBottom + (1 - marginTop) * VP.Margin, QueryType.ByHeight, oracle, 0, 0).to
    );

    // 如果给定了 scrollTarget，确保视口包含该位置
    if (scrollTarget) {
      const { head } = scrollTarget.range;

      if (head < viewport.from || head > viewport.to) {
        const viewHeight = Math.min(
          this.editorHeight,
          this.pixelViewport.bottom - this.pixelViewport.top
        );

        const block = map.lineAt(head, QueryType.ByPos, oracle, 0, 0);
        let topPos: number;

        if (scrollTarget.y == "center") {
          topPos = (block.top + block.bottom) / 2 - viewHeight / 2;
        } else if (
          scrollTarget.y == "start" ||
          (scrollTarget.y == "nearest" && head < viewport.from)
        ) {
          topPos = block.top;
        } else {
          topPos = block.bottom - viewHeight;
        }

        viewport = new Viewport(
          map.lineAt(topPos - VP.Margin / 2, QueryType.ByHeight, oracle, 0, 0).from,
          map.lineAt(topPos + viewHeight + VP.Margin / 2, QueryType.ByHeight, oracle, 0, 0).to
        );
      }
    }

    return viewport;
  }

  mapViewport(viewport: Viewport, changes: ChangeDesc) {
    const from = changes.mapPos(viewport.from, -1),
      to = changes.mapPos(viewport.to, 1);
    return new Viewport(
      this.heightMap.lineAt(from, QueryType.ByPos, this.heightOracle, 0, 0).from,
      this.heightMap.lineAt(to, QueryType.ByPos, this.heightOracle, 0, 0).to
    );
  }

  // Checks if a given viewport covers the visible part of the
  // document and not too much beyond that.
  viewportIsAppropriate({ from, to }: Viewport, bias = 0) {
    if (!this.inView) return true;
    const { top } = this.heightMap.lineAt(from, QueryType.ByPos, this.heightOracle, 0, 0);
    const { bottom } = this.heightMap.lineAt(to, QueryType.ByPos, this.heightOracle, 0, 0);
    const { visibleTop, visibleBottom } = this;
    return (
      (from == 0 ||
        top <= visibleTop - Math.max(VP.MinCoverMargin, Math.min(-bias, VP.MaxCoverMargin))) &&
      (to == this.state.doc.length ||
        bottom >= visibleBottom + Math.max(VP.MinCoverMargin, Math.min(bias, VP.MaxCoverMargin))) &&
      top > visibleTop - 2 * VP.Margin &&
      bottom < visibleBottom + 2 * VP.Margin
    );
  }

  mapLineGaps(gaps: readonly LineGap[], changes: ChangeSet) {
    if (!gaps.length || changes.empty) return gaps;
    const mapped = [];
    for (const gap of gaps)
      if (!changes.touchesRange(gap.from, gap.to))
        mapped.push(
          new LineGap(changes.mapPos(gap.from), changes.mapPos(gap.to), gap.size, gap.displaySize)
        );
    return mapped;
  }

  /**
   * 计算视口中的开始或结束位置线应该隐藏, 尝试重用现有的线间隙适当地避免不必要的重画, 使用粗略的字符计数来定位和调整大小，
   * 因为实际的 DOM 坐标并不总是可用并且可预测的
   * 依靠慷慨的边距（参见 LG.Margin）来隐藏用户可能产生的工件
   */
  ensureLineGaps(current: readonly LineGap[], mayMeasure?: EditorView) {
    const wrapping = this.heightOracle.lineWrapping;

    const margin = wrapping ? LG.MarginWrap : LG.Margin;
    const halfMargin = margin >> 1;
    const doubleMargin = margin << 1;

    // The non-wrapping logic won't work at all in predominantly right-to-left text.
    if (this.defaultTextDirection != Direction.LTR && !wrapping) {
      return [];
    }

    const gaps: LineGap[] = [];
    const addGap = (from: number, to: number, line: BlockInfo, structure: LineStructure) => {
      if (to - from < halfMargin) {
        return;
      }

      const sel = this.state.selection.main;
      const avoid = [sel.from];

      if (!sel.empty) {
        avoid.push(sel.to);
      }

      for (const pos of avoid) {
        if (pos > from && pos < to) {
          addGap(from, pos - LG.SelectionMargin, line, structure);
          addGap(pos + LG.SelectionMargin, to, line, structure);

          return;
        }
      }

      let gap = find(
        current,
        (gap) =>
          gap.from >= line.from &&
          gap.to <= line.to &&
          Math.abs(gap.from - from) < halfMargin &&
          Math.abs(gap.to - to) < halfMargin &&
          !avoid.some((pos) => gap.from < pos && gap.to > pos)
      );

      if (!gap) {
        // When scrolling down, snap gap ends to line starts to avoid shifts in wrapping
        if (
          to < line.to &&
          mayMeasure &&
          wrapping &&
          mayMeasure.visibleRanges.some((r) => r.from <= to && r.to >= to)
        ) {
          const lineStart = mayMeasure.moveToLineBoundary(
            EditorSelection.cursor(to),
            false,
            true
          ).head;

          if (lineStart > from) {
            to = lineStart;
          }
        }

        const size = this.gapSize(line, from, to, structure);
        const displaySize = wrapping || size < VP.MaxHorizGap ? size : VP.MaxHorizGap;

        gap = new LineGap(from, to, size, displaySize);
      }

      gaps.push(gap);
    };

    const checkLine = (line: BlockInfo) => {
      if (line.length < doubleMargin || line.type != BlockType.Text) {
        return;
      }

      const structure = lineStructure(line.from, line.to, this.stateDeco);
      if (structure.total < doubleMargin) {
        return;
      }

      const target = this.scrollTarget ? this.scrollTarget.range.head : null;
      let viewFrom: number;
      let viewTo: number;

      if (wrapping) {
        const marginHeight = (margin / this.heightOracle.lineLength) * this.heightOracle.lineHeight;

        let top: number, bot: number;

        if (target != null) {
          const targetFrac = findFraction(structure, target);
          const spaceFrac =
            ((this.visibleBottom - this.visibleTop) / 2 + marginHeight) / line.height;

          top = targetFrac - spaceFrac;
          bot = targetFrac + spaceFrac;
        } else {
          top = (this.visibleTop - line.top - marginHeight) / line.height;
          bot = (this.visibleBottom - line.top + marginHeight) / line.height;
        }

        viewFrom = findPosition(structure, top);
        viewTo = findPosition(structure, bot);
      } else {
        const totalWidth = structure.total * this.heightOracle.charWidth;
        const marginWidth = margin * this.heightOracle.charWidth;
        let horizOffset = 0;

        if (totalWidth > VP.MaxHorizGap) {
          for (const old of current) {
            if (
              old.from >= line.from &&
              old.from < line.to &&
              old.size != old.displaySize &&
              old.from * this.heightOracle.charWidth + horizOffset < this.pixelViewport.left
            ) {
              horizOffset = old.size - old.displaySize;
            }
          }
        }

        const pxLeft = this.pixelViewport.left + horizOffset;
        const pxRight = this.pixelViewport.right + horizOffset;
        let left: number, right: number;

        if (target != null) {
          const targetFrac = findFraction(structure, target);
          const spaceFrac = ((pxRight - pxLeft) / 2 + marginWidth) / totalWidth;

          left = targetFrac - spaceFrac;
          right = targetFrac + spaceFrac;
        } else {
          left = (pxLeft - marginWidth) / totalWidth;
          right = (pxRight + marginWidth) / totalWidth;
        }

        viewFrom = findPosition(structure, left);
        viewTo = findPosition(structure, right);
      }

      if (viewFrom > line.from) {
        addGap(line.from, viewFrom, line, structure);
      }
      if (viewTo < line.to) {
        addGap(viewTo, line.to, line, structure);
      }
    };

    for (const line of this.viewportLines) {
      if (Array.isArray(line.type)) {
        line.type.forEach(checkLine);
      } else {
        checkLine(line);
      }
    }

    return gaps;
  }

  gapSize(line: BlockInfo, from: number, to: number, structure: LineStructure) {
    const fraction = findFraction(structure, to) - findFraction(structure, from);
    if (this.heightOracle.lineWrapping) {
      return line.height * fraction;
    } else {
      return structure.total * this.heightOracle.charWidth * fraction;
    }
  }

  updateLineGaps(gaps: readonly LineGap[]) {
    if (!LineGap.same(gaps, this.lineGaps)) {
      this.lineGaps = gaps;
      this.lineGapDeco = Decoration.set(
        gaps.map((gap) => gap.draw(this, this.heightOracle.lineWrapping))
      );
    }
  }

  /** 计算可视范围 */
  computeVisibleRanges() {
    let deco = this.stateDeco;

    if (this.lineGaps.length) {
      deco = deco.concat(this.lineGapDeco);
    }

    const ranges: { from: number; to: number }[] = [];
    RangeSet.spans(
      deco,
      this.viewport.from,
      this.viewport.to,
      {
        span(from, to) {
          ranges.push({ from, to });
        },
        point() {},
      },
      20
    );

    const changed =
      ranges.length != this.visibleRanges.length ||
      this.visibleRanges.some((r, i) => r.from != ranges[i].from || r.to != ranges[i].to);

    this.visibleRanges = ranges;

    return changed ? UpdateFlag.Viewport : 0;
  }

  lineBlockAt(pos: number): BlockInfo {
    return (
      (pos >= this.viewport.from &&
        pos <= this.viewport.to &&
        this.viewportLines.find((b) => b.from <= pos && b.to >= pos)) ||
      scaleBlock(this.heightMap.lineAt(pos, QueryType.ByPos, this.heightOracle, 0, 0), this.scaler)
    );
  }

  lineBlockAtHeight(height: number): BlockInfo {
    return (
      (height >= this.viewportLines[0].top &&
        height <= this.viewportLines[this.viewportLines.length - 1].bottom &&
        this.viewportLines.find((l) => l.top <= height && l.bottom >= height)) ||
      scaleBlock(
        this.heightMap.lineAt(
          this.scaler.fromDOM(height),
          QueryType.ByHeight,
          this.heightOracle,
          0,
          0
        ),
        this.scaler
      )
    );
  }

  scrollAnchorAt(scrollTop: number) {
    const block = this.lineBlockAtHeight(scrollTop + 8);
    return block.from >= this.viewport.from || this.viewportLines[0].top - scrollTop > 200
      ? block
      : this.viewportLines[0];
  }

  elementAtHeight(height: number): BlockInfo {
    return scaleBlock(
      this.heightMap.blockAt(this.scaler.fromDOM(height), this.heightOracle, 0, 0),
      this.scaler
    );
  }

  get docHeight() {
    return this.scaler.toDOM(this.heightMap.height);
  }

  get contentHeight() {
    return this.docHeight + this.paddingTop + this.paddingBottom;
  }
}

export class Viewport {
  constructor(readonly from: number, readonly to: number) {}
}

type LineStructure = { total: number; ranges: { from: number; to: number }[] };

function lineStructure(
  from: number,
  to: number,
  stateDeco: readonly DecorationSet[]
): LineStructure {
  const ranges = [];
  let pos = from;
  let total = 0;

  RangeSet.spans(
    stateDeco,
    from,
    to,
    {
      span() {},
      point(from, to) {
        if (from > pos) {
          ranges.push({ from: pos, to: from });
          total += from - pos;
        }
        pos = to;
      },
    },
    20
  ); // We're only interested in collapsed ranges of a significant size

  if (pos < to) {
    ranges.push({ from: pos, to });
    total += to - pos;
  }

  return { total, ranges };
}

function findPosition({ total, ranges }: LineStructure, ratio: number): number {
  if (ratio <= 0) {
    return ranges[0].from;
  }

  if (ratio >= 1) {
    return ranges[ranges.length - 1].to;
  }

  let dist = Math.floor(total * ratio);

  for (let i = 0; ; i++) {
    const { from, to } = ranges[i];
    const size = to - from;

    if (dist <= size) {
      return from + dist;
    }

    dist -= size;
  }
}

function findFraction(structure: LineStructure, pos: number) {
  let counted = 0;

  for (const { from, to } of structure.ranges) {
    if (pos <= to) {
      counted += pos - from;

      break;
    }

    counted += to - from;
  }

  return counted / structure.total;
}

function find<T>(array: readonly T[], f: (value: T) => boolean): T | undefined {
  for (const val of array) {
    if (f(val)) {
      return val;
    }
  }

  return undefined;
}

// Convert between heightmap heights and DOM heights (see
// VP.MaxDOMHeight)
type YScaler = {
  toDOM(n: number): number;
  fromDOM(n: number): number;
  scale: number;
  eq(other: YScaler): boolean;
};

// Don't scale when the document height is within the range of what
// the DOM can handle.
const IdScaler: YScaler = {
  toDOM(n: number) {
    return n;
  },
  fromDOM(n: number) {
    return n;
  },
  scale: 1,
  eq(other: YScaler) {
    return other == this;
  },
};

// When the height is too big (> VP.MaxDOMHeight), scale down the
// regions outside the viewports so that the total height is
// VP.MaxDOMHeight.
class BigScaler implements YScaler {
  scale: number;
  viewports: {
    from: number;
    to: number;
    top: number;
    bottom: number;
    domTop: number;
    domBottom: number;
  }[];

  constructor(oracle: HeightOracle, heightMap: HeightMap, viewports: readonly Viewport[]) {
    let vpHeight = 0;
    let base = 0;
    let domBase = 0;

    this.viewports = viewports.map(({ from, to }) => {
      const top = heightMap.lineAt(from, QueryType.ByPos, oracle, 0, 0).top;
      const bottom = heightMap.lineAt(to, QueryType.ByPos, oracle, 0, 0).bottom;

      vpHeight += bottom - top;

      return { from, to, top, bottom, domTop: 0, domBottom: 0 };
    });

    this.scale = (VP.MaxDOMHeight - vpHeight) / (heightMap.height - vpHeight);

    for (const obj of this.viewports) {
      obj.domTop = domBase + (obj.top - base) * this.scale;
      domBase = obj.domBottom = obj.domTop + (obj.bottom - obj.top);
      base = obj.bottom;
    }
  }

  toDOM(n: number) {
    for (let i = 0, base = 0, domBase = 0; ; i++) {
      const vp = i < this.viewports.length ? this.viewports[i] : null;

      if (!vp || n < vp.top) {
        return domBase + (n - base) * this.scale;
      }

      if (n <= vp.bottom) {
        return vp.domTop + (n - vp.top);
      }

      base = vp.bottom;
      domBase = vp.domBottom;
    }
  }

  fromDOM(n: number) {
    for (let i = 0, base = 0, domBase = 0; ; i++) {
      const vp = i < this.viewports.length ? this.viewports[i] : null;

      if (!vp || n < vp.domTop) {
        return base + (n - domBase) / this.scale;
      }

      if (n <= vp.domBottom) {
        return vp.top + (n - vp.domTop);
      }

      base = vp.bottom;
      domBase = vp.domBottom;
    }
  }

  eq(other: YScaler) {
    if (!(other instanceof BigScaler)) {
      return false;
    }

    return (
      this.scale == other.scale &&
      this.viewports.length == other.viewports.length &&
      this.viewports.every(
        (vp, i) => vp.from == other.viewports[i].from && vp.to == other.viewports[i].to
      )
    );
  }
}

/** 根据缩放系数更新块信息 */
function scaleBlock(block: BlockInfo, scaler: YScaler): BlockInfo {
  if (scaler.scale == 1) {
    return block;
  }

  const bTop = scaler.toDOM(block.top);
  const bBottom = scaler.toDOM(block.bottom);

  return new BlockInfo(
    block.from,
    block.length,
    bTop,
    bBottom - bTop,
    Array.isArray(block._content)
      ? block._content.map((b) => scaleBlock(b, scaler))
      : block._content
  );
}
