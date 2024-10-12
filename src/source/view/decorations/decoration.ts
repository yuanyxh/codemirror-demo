import { MapMode, RangeValue, Range, RangeSet } from "@/state/index";
import { Direction } from "../utils/bidi";
import { attrsEq, Attrs } from "../utils/attributes";
import { EditorView } from "../editorview";
import { Rect } from "../utils/dom";

/** 标记的装饰器属性 */
interface MarkDecorationSpec {
  /** 标记是否覆盖其开始和结束位置。这会影响在这些位置插入的内容是否成为标记的一部分，默认为 false */
  inclusive?: boolean;
  /** 指定是否应包含标记范围的起始位置，优先级高于 inclusive */
  inclusiveStart?: boolean;
  /** 指定是否应包含标记范围的结束位置，优先级高于 inclusive */
  inclusiveEnd?: boolean;
  /** 将属性添加到将文本保留在标记范围内的 DOM 元素 */
  attributes?: { [key: string]: string };
  /** dom 类 */
  class?: string;
  /**
   * 在标记范围内的文本周围添加环绕元素
   * 请注意，不一定有一个元素覆盖整个范围 - 其他优先级较低的装饰如果部分重叠，则可能会分割该元素，并且换行符总是结束装饰元素
   */
  tagName?: string;
  /**
   * 当在 #view.EditorView^bidiIsolatedRanges 中使用装饰集时
   * 此属性提供隔离的方向。当为 null 或未给出时，表示范围具有 `dir=auto`，并且其方向应从第一个强方向导出
   */
  bidiIsolate?: Direction | null;
  /**
   * 装饰规范允许额外的属性，可以通过装饰的 #view.Decoration.spec 属性检索这些属性
   */
  [other: string]: any;
}

/** 小部件的装饰属性 */
interface WidgetDecorationSpec {
  /** 要在此处绘制的小部件的类型 */
  widget: WidgetType;
  /**
   * 小部件位于给定位置的哪一侧。当该值为正值时，如果光标位于同一位置，则小部件将在光标之后绘制；否则，它将在它之前绘制
   * 当多个小部件位于同一位置时，它们的 “side” 值将决定它们的顺序 - 值较低的部件排在前面
   * 默认为 0。不得大于 10000 或小于 -10000。
   */
  side?: number;
  /**
   * 默认情况下，为了避免块和内联小部件的意外混合，具有正 “边” 的块小部件始终绘制在该位置的所有内联小部件之后，而具有非正边的块小部件始终绘制在内联小部件之前
   * 对于块小部件，将此选项设置为 “true” 将关闭此功能，并导致它在内联小部件之间呈现，按 “side” 排序
   */
  inlineOrder?: boolean;
  /**
   * 确定这是在行之间绘制的块小部件，还是在周围文本之间绘制的内联小部件（默认）
   * 块级装饰不应具有垂直边距，如果动态更改其高度，则应确保调用 #view.EditorView.requestMeasure，以便编辑器可以更新其垂直布局的信息
   */
  block?: boolean;

  [other: string]: any;
}

/** 替换内容的小部件属性 */
interface ReplaceDecorationSpec {
  /** 在替换内容的位置绘制的可选小部件 */
  widget?: WidgetType;
  /** 该范围是否覆盖其两侧的位置，这会影响新内容是否成为范围的一部分以及光标是否可以在其两侧绘制；内联替换默认为 false，块替换默认为 true */
  inclusive?: boolean;
  inclusiveStart?: boolean;
  inclusiveEnd?: boolean;
  /** 这是否是块级装饰。默认为 false */
  block?: boolean;

  [other: string]: any;
}

/** 行的装饰属性 */
interface LineDecorationSpec {
  /** dom 属性 */
  attributes?: { [key: string]: string };
  /** dom class */
  class?: string;
  [other: string]: any;
}

/**
 * 添加到内容中的小部件由此类的子类描述
 * 使用这样的描述对象可以延迟为小部件创建 DOM 结构，直到需要它为止，并且可以避免重绘小部件，即使重新创建定义它们的装饰也是如此
 */
export abstract class WidgetType {
  /** 为此小部件实例构建 DOM 结构 */
  abstract toDOM(view: EditorView): HTMLElement;

  /**
   * 将此实例与相同类型的另一个实例进行比较(只有同一特定类的实例才会传递给此方法)
   * 用于避免在小部件被相同类型的新装饰替换时重新绘制小部件。默认实现仅返回“false”，这将导致始终重绘小部件的新实例
   */
  eq(_widget: WidgetType): boolean {
    return false;
  }

  /**
   * 更新由相同类型（但不同的非 “eq” 内容）小部件创建的 DOM 元素以反映此小部件
   * 可能返回 true 表示它可以更新，返回 false 表示它不能(在这种情况下，小部件将被重新绘制); 默认实现只返回 false。
   */
  updateDOM(_dom: HTMLElement, _view: EditorView): boolean {
    return false;
  }

  compare(other: WidgetType): boolean {
    return this == other || (this.constructor == other.constructor && this.eq(other));
  }

  /**
   * 该小部件将具有的估计高度，在估计尚未绘制的内容的高度时使用
   * 可能会返回 -1 表示不知道; 默认实现返回-1
   */
  get estimatedHeight(): number {
    return -1;
  }

  /**
   * 对于内联显示（与 “inline-block” 相反）并引入换行符（通过 “<br>” 标签或文本换行符）的内联小部件，这必须指示它们引入的换行符数量; 默认为 0。
   */
  get lineBreaks(): number {
    return 0;
  }

  /**
   * 可用于配置编辑器应忽略小部件内的哪些类型的事件; 默认情况下忽略所有事件
   */
  ignoreEvent(_event: Event): boolean {
    return true;
  }

  /**
   * 覆盖在小部件中/位置的屏幕坐标的查找方式, “pos” 将是小部件的偏移量，“side” 将是正在查询的位置的一侧 - 小于零表示之前，大于零表示之后，零表示直接在该位置
   */
  coordsAt(_dom: HTMLElement, _pos: number, _side: number): Rect | null {
    return null;
  }

  get isHidden() {
    return false;
  }

  get editable() {
    return false;
  }

  /**
   * 当小部件的实例从编辑器视图中删除时，将调用此函数
   */
  destroy(_dom: HTMLElement) {}
}

/**
 * 装饰集代表装饰范围的集合，经过组织以实现高效访问和映射
 * 请参阅 (#state.RangeSet) 了解其方法
 */
export type DecorationSet = RangeSet<Decoration>;

const enum Side {
  /** （不包含范围的末尾） */
  NonIncEnd = -6e8,
  GapStart = -5e8,
  /** + 小部件侧面选项（之前阻止小部件） */
  BlockBefore = -4e8,
  BlockIncStart = -3e8, // (start of inclusive block range)
  Line = -2e8, // (line widget)
  InlineBefore = -1e8, // + widget side (inline widget before)
  InlineIncStart = -1, // (start of inclusive inline range)
  InlineIncEnd = 1, // (end of inclusive inline range)
  InlineAfter = 1e8, // + widget side (inline widget after)
  BlockIncEnd = 2e8, // (end of inclusive block range)
  BlockAfter = 3e8, // + widget side (block widget after)
  GapEnd = 4e8,
  NonIncStart = 5e8, // (start of non-inclusive range)
}

/** 编辑器视图中可能出现的不同类型的块 */
export enum BlockType {
  /** 一行文本 */
  Text,
  /** 与其后面的位置关联的块小部件 */
  WidgetBefore,
  /** 与其之前的位置关联的块小部件 */
  WidgetAfter,
  /** 块小部件[替换] (#view.Decoration^replace) 一系列内容 */
  WidgetRange,
}

/**
 * 装饰提供有关如何绘制内容或设置内容样式的信息
 * 通常会使用它包裹在 [`Range`](#state.Range) 中，这会添加开始和结束位置
 * */
export abstract class Decoration extends RangeValue {
  protected constructor(
    readonly startSide: number,

    readonly endSide: number,

    readonly widget: WidgetType | null,

    /**
     * 用于创建此装饰的配置对象
     * 您可以在其中包含其他属性来存储有关您的元数据
     */
    readonly spec: any
  ) {
    super();
  }

  declare point: boolean;

  get heightRelevant() {
    return false;
  }

  abstract eq(other: Decoration): boolean;

  /**
   * 创建标记装饰，这会影响其范围内内容的样式
   * 嵌套标记装饰将导致创建嵌套 DOM 元素，嵌套顺序由 [facet](#view.EditorView^decorations) 的优先级决定，优先级较高的装饰创建内部 DOM 节点
   * 这些元素在行边界和较低优先级装饰的边界上分开
   */
  static mark(spec: MarkDecorationSpec): Decoration {
    return new MarkDecoration(spec);
  }

  /**
   * 创建一个小部件装饰，它在给定位置显示 DOM 元素
   */
  static widget(spec: WidgetDecorationSpec): Decoration {
    let side = Math.max(-10000, Math.min(10000, spec.side || 0));

    const block = !!spec.block;

    side +=
      block && !spec.inlineOrder
        ? side > 0
          ? Side.BlockAfter
          : Side.BlockBefore
        : side > 0
        ? Side.InlineAfter
        : Side.InlineBefore;

    return new PointDecoration(spec, side, side, block, spec.widget || null, false);
  }

  /**
   * 创建一个替换装饰，用小部件替换给定范围，或者只是隐藏它
   */
  static replace(spec: ReplaceDecorationSpec): Decoration {
    const block = !!spec.block;

    let startSide: number;
    let endSide: number;

    if (spec.isBlockGap) {
      startSide = Side.GapStart;
      endSide = Side.GapEnd;
    } else {
      const { start, end } = getInclusive(spec, block);

      startSide =
        (start ? (block ? Side.BlockIncStart : Side.InlineIncStart) : Side.NonIncStart) - 1;
      endSide = (end ? (block ? Side.BlockIncEnd : Side.InlineIncEnd) : Side.NonIncEnd) + 1;
    }

    return new PointDecoration(spec, startSide, endSide, block, spec.widget || null, true);
  }

  /**
   * 创建一个线条装饰，它可以将 DOM 属性添加到从给定位置开始的线条中
   */
  static line(spec: LineDecorationSpec): Decoration {
    return new LineDecoration(spec);
  }

  /**
   * 从给定的装饰范围构建一个 [`DecorationSet`](#view.DecorationSet)
   * 如果范围尚未排序，请为 “sort” 传递“true”，以使库为您对它们进行排序
   */
  static set(of: Range<Decoration> | readonly Range<Decoration>[], sort = false): DecorationSet {
    return RangeSet.of<Decoration>(of, sort);
  }

  /// The empty set of decorations.
  static none = RangeSet.empty as DecorationSet;

  hasHeight() {
    return this.widget ? this.widget.estimatedHeight > -1 : false;
  }
}

/** 标记 装饰 */
export class MarkDecoration extends Decoration {
  tagName: string;
  class: string;
  attrs: Attrs | null;

  constructor(spec: MarkDecorationSpec) {
    const { start, end } = getInclusive(spec);

    super(
      start ? Side.InlineIncStart : Side.NonIncStart,
      end ? Side.InlineIncEnd : Side.NonIncEnd,
      null,
      spec
    );

    this.tagName = spec.tagName || "span";
    this.class = spec.class || "";
    this.attrs = spec.attributes || null;
  }

  eq(other: Decoration): boolean {
    return (
      this == other ||
      (other instanceof MarkDecoration &&
        this.tagName == other.tagName &&
        (this.class || this.attrs?.class) == (other.class || other.attrs?.class) &&
        attrsEq(this.attrs, other.attrs, "class"))
    );
  }

  range(from: number, to = from) {
    if (from >= to) {
      throw new RangeError("Mark decorations may not be empty");
    }

    return super.range(from, to);
  }
}

MarkDecoration.prototype.point = false;

/** 行装饰? */
export class LineDecoration extends Decoration {
  constructor(spec: LineDecorationSpec) {
    super(Side.Line, Side.Line, null, spec);
  }

  eq(other: Decoration): boolean {
    return (
      other instanceof LineDecoration &&
      this.spec.class == other.spec.class &&
      attrsEq(this.spec.attributes, other.spec.attributes)
    );
  }

  range(from: number, to = from) {
    if (to != from) {
      throw new RangeError("Line decoration ranges must be zero-length");
    }

    return super.range(from, to);
  }
}

LineDecoration.prototype.mapMode = MapMode.TrackBefore;
LineDecoration.prototype.point = true;

/** 小部件或替换装饰 */
export class PointDecoration extends Decoration {
  constructor(
    spec: any,
    startSide: number,
    endSide: number,
    public block: boolean,
    widget: WidgetType | null,
    readonly isReplace: boolean
  ) {
    super(startSide, endSide, widget, spec);
    this.mapMode = !block
      ? MapMode.TrackDel
      : startSide <= 0
      ? MapMode.TrackBefore
      : MapMode.TrackAfter;
  }

  // Only relevant when this.block == true
  get type() {
    return this.startSide != this.endSide
      ? BlockType.WidgetRange
      : this.startSide <= 0
      ? BlockType.WidgetBefore
      : BlockType.WidgetAfter;
  }

  get heightRelevant() {
    return (
      this.block ||
      (!!this.widget && (this.widget.estimatedHeight >= 5 || this.widget.lineBreaks > 0))
    );
  }

  eq(other: Decoration): boolean {
    return (
      other instanceof PointDecoration &&
      widgetsEq(this.widget, other.widget) &&
      this.block == other.block &&
      this.startSide == other.startSide &&
      this.endSide == other.endSide
    );
  }

  range(from: number, to = from) {
    if (this.isReplace && (from > to || (from == to && this.startSide > 0 && this.endSide <= 0))) {
      throw new RangeError("Invalid range for replacement decoration");
    }

    if (!this.isReplace && to != from) {
      throw new RangeError("Widget decorations can only have zero-length ranges");
    }

    return super.range(from, to);
  }
}

PointDecoration.prototype.point = true;

function getInclusive(
  spec: {
    inclusive?: boolean;
    inclusiveStart?: boolean;
    inclusiveEnd?: boolean;
  },
  block = false
): { start: boolean; end: boolean } {
  let { inclusiveStart: start, inclusiveEnd: end } = spec;

  if (start == null) {
    start = spec.inclusive;
  }

  if (end == null) {
    end = spec.inclusive;
  }

  return { start: start ?? block, end: end ?? block };
}

function widgetsEq(a: WidgetType | null, b: WidgetType | null): boolean {
  return a == b || !!(a && b && a.compare(b));
}

export function addRange(from: number, to: number, ranges: number[], margin = 0) {
  const last = ranges.length - 1;

  if (last >= 0 && ranges[last] + margin >= from) {
    ranges[last] = Math.max(ranges[last], to);
  } else {
    ranges.push(from, to);
  }
}
