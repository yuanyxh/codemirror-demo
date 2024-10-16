import {
  EditorState,
  Transaction,
  ChangeSet,
  ChangeDesc,
  Facet,
  Line,
  StateEffect,
  Extension,
  SelectionRange,
  RangeSet,
  EditorSelection,
} from "@/state/index";
import { StyleModule } from "style-mod";
import { DecorationSet, Decoration } from "../decorations/decoration";
import { EditorView, DOMEventHandlers } from "../editorview";
import { Attrs } from "../utils/attributes";
import { Isolate, autoDirection } from "../utils/bidi";
import { Rect, ScrollStrategy } from "../utils/dom";
import { MakeSelectionStyle } from "../utils/input";

/** 扩展定义 */

/**
 * Command 用于键绑定和其他类型的用户操作
 * 给定一个编辑器视图，他们检查其效果是否可以应用于编辑器
 * 如果可以，则将其作为副作用执行（#view.EditorView.dispatch）并返回 true
 */
export type Command = (target: EditorView) => boolean;

/** Facet 单击添加 Selection Range */
export const clickAddsSelectionRange = Facet.define<(event: MouseEvent) => boolean>();

/** Facet 拖拽移动 Selection */
export const dragMovesSelection = Facet.define<(event: MouseEvent) => boolean>();

/** Facet 移动 Selection 样式 */
export const mouseSelectionStyle = Facet.define<MakeSelectionStyle>();

/** Facet 异常接收 */
export const exceptionSink = Facet.define<(exception: any) => void>();

/** Facet 更新时间侦听 */
export const updateListener = Facet.define<(update: ViewUpdate) => void>();

/** Facet 输入处理 */
export const inputHandler =
  Facet.define<
    (view: EditorView, from: number, to: number, text: string, insert: () => Transaction) => boolean
  >();

/** Facet 焦点变化副作用 */
export const focusChangeEffect =
  Facet.define<(state: EditorState, focusing: boolean) => StateEffect<any> | null>();

/** Facet 剪切板输入过滤 */
export const clipboardInputFilter = Facet.define<(text: string, state: EditorState) => string>();
/** Facet 剪切板输出过滤 */
export const clipboardOutputFilter = Facet.define<(text: string, state: EditorState) => string>();

/** Facet 行文本方向 */
export const perLineTextDirection = Facet.define<boolean, boolean>({
  combine: (values) => values.some((x) => x),
});

/** Facet 原生选区隐藏 */
export const nativeSelectionHidden = Facet.define<boolean, boolean>({
  combine: (values) => values.some((x) => x),
});

/** Facet 滚动处理 */
export const scrollHandler =
  Facet.define<
    (
      view: EditorView,
      range: SelectionRange,
      options: { x: ScrollStrategy; y: ScrollStrategy; xMargin: number; yMargin: number }
    ) => boolean
  >();

export class ScrollTarget {
  constructor(
    readonly range: SelectionRange,
    readonly y: ScrollStrategy = "nearest",
    readonly x: ScrollStrategy = "nearest",
    readonly yMargin: number = 5,
    readonly xMargin: number = 5,
    // This data structure is abused to also store precise scroll
    // snapshots, instead of a `scrollIntoView` request. When this
    // flag is `true`, `range` points at a position in the reference
    // line, `yMargin` holds the difference between the top of that
    // line and the top of the editor, and `xMargin` holds the
    // editor's `scrollLeft`.
    readonly isSnapshot = false
  ) {}

  map(changes: ChangeDesc) {
    return changes.empty
      ? this
      : new ScrollTarget(
          this.range.map(changes),
          this.y,
          this.x,
          this.yMargin,
          this.xMargin,
          this.isSnapshot
        );
  }

  clip(state: EditorState) {
    return this.range.to <= state.doc.length
      ? this
      : new ScrollTarget(
          EditorSelection.cursor(state.doc.length),
          this.y,
          this.x,
          this.yMargin,
          this.xMargin,
          this.isSnapshot
        );
  }
}

export const scrollIntoView = StateEffect.define<ScrollTarget>({ map: (t, ch) => t.map(ch) });

export const setEditContextFormatting = StateEffect.define<DecorationSet>();

/** 异常输出程序 */
export function logException(state: EditorState, exception: any, context?: string) {
  const handler = state.facet(exceptionSink);
  if (handler.length) {
    handler[0](exception);
  } else if (window.onerror) {
    window.onerror(String(exception), context, undefined, undefined, exception);
  } else if (context) {
    console.error(context + ":", exception);
  } else {
    console.error(exception);
  }
}

/** Facet 可编辑性? */
export const editable = Facet.define<boolean, boolean>({
  combine: (values) => (values.length ? values[0] : true),
});

/** 这是插件对象所遵循的接口 */
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
export interface PluginValue extends Object {
  /**
   * 通知插件视图中发生的更新, 这在视图更新其自己的 DOM 之前被调用
   * 这是负责更新插件的内部状态（包括任何可以被插件字段读取的状态）和 _writing_ 更新中更改的 DOM
   * 以免不必要的布局重新计算，它不应该读取 DOM 布局——使用 (#view.EditorView.requestMeasure) 安排
   * 如果需要，您的代码处于 DOM 读取阶段
   * */
  update?(update: ViewUpdate): void;

  /// Called when the document view is updated (due to content,
  /// decoration, or viewport changes). Should not try to immediately
  /// start another view update. Often useful for calling
  /// [`requestMeasure`](#view.EditorView.requestMeasure).
  docViewUpdate?(view: EditorView): void;

  /// Called when the plugin is no longer going to be used. Should
  /// revert any changes the plugin made to the DOM.
  destroy?(): void;
}

let nextPluginID = 0;

export const viewPlugin = Facet.define<ViewPlugin<any>>();

/** 在定义 (#view.ViewPlugin) 时提供附加信息 */
export interface PluginSpec<V extends PluginValue> {
  /**
   * 注册给定的 (#view.EditorView^domEventHandlers)
   * 调用时，这些会将其 “this” 绑定到 PluginValue
   */
  eventHandlers?: DOMEventHandlers<V>;

  /**
   * 注册 (#view.EditorView^domEventObservers)
   * 当被调用时，将把他们的 “this” 绑定到 PluginValue
   */
  eventObservers?: DOMEventHandlers<V>;

  /**
   * 指定插件在添加到编辑器配置时提供附加扩展
   */
  provide?: (plugin: ViewPlugin<V>) => Extension;

  /**
   * 允许插件提供装饰
   * 当给出时，这应该是一个函数，它接受 PluginValue 并返回 (#view.DecorationSet)
   */
  decorations?: (value: V) => DecorationSet;
}

/**
 * 视图插件将状态值与视图关联起来
 * 他们可以影响内容的绘制方式，并收到视图中发生的事情的通知
 */
export class ViewPlugin<V extends PluginValue> {
  /// Instances of this class act as extensions.
  extension: Extension;

  private constructor(
    readonly id: number,
    readonly create: (view: EditorView) => V,
    readonly domEventHandlers: DOMEventHandlers<V> | undefined,
    readonly domEventObservers: DOMEventHandlers<V> | undefined,
    buildExtensions: (plugin: ViewPlugin<V>) => Extension
  ) {
    this.extension = buildExtensions(this);
  }

  /**
   * 在给定编辑器视图的情况下，从创建插件值的构造函数定义插件
   */
  static define<V extends PluginValue>(create: (view: EditorView) => V, spec?: PluginSpec<V>) {
    const { eventHandlers, eventObservers, provide, decorations: deco } = spec || {};

    return new ViewPlugin<V>(nextPluginID++, create, eventHandlers, eventObservers, (plugin) => {
      const ext = [viewPlugin.of(plugin)];

      if (deco) {
        ext.push(
          decorations.of((view) => {
            const pluginInst = view.plugin(plugin);

            return pluginInst ? deco(pluginInst) : Decoration.none;
          })
        );
      }

      if (provide) {
        ext.push(provide(plugin));
      }

      return ext;
    });
  }

  /**
   * 为一个类创建一个插件，该类的构造函数采用单个编辑器视图作为参数
   */
  static fromClass<V extends PluginValue>(
    cls: { new (view: EditorView): V },
    spec?: PluginSpec<V>
  ) {
    return ViewPlugin.define((view) => new cls(view), spec);
  }
}

export class PluginInstance {
  // When starting an update, all plugins have this field set to the
  // update object, indicating they need to be updated. When finished
  // updating, it is set to `false`. Retrieving a plugin that needs to
  // be updated with `view.plugin` forces an eager update.
  mustUpdate: ViewUpdate | null = null;
  // This is null when the plugin is initially created, but
  // initialized on the first update.
  value: PluginValue | null = null;

  constructor(public spec: ViewPlugin<any> | null) {}

  update(view: EditorView) {
    if (!this.value) {
      if (this.spec) {
        try {
          this.value = this.spec.create(view);
        } catch (e) {
          logException(view.state, e, "CodeMirror plugin crashed");
          this.deactivate();
        }
      }
    } else if (this.mustUpdate) {
      const update = this.mustUpdate;
      this.mustUpdate = null;

      if (this.value.update) {
        try {
          this.value.update(update);
        } catch (e) {
          logException(update.state, e, "CodeMirror plugin crashed");

          if (this.value.destroy) {
            try {
              this.value.destroy();
            } catch (_) {
              /** empty */
            }
          }

          this.deactivate();
        }
      }
    }

    return this;
  }

  destroy(view: EditorView) {
    if (this.value?.destroy) {
      try {
        this.value.destroy();
      } catch (e) {
        logException(view.state, e, "CodeMirror plugin crashed");
      }
    }
  }

  deactivate() {
    this.spec = this.value = null;
  }
}

export interface MeasureRequest<T> {
  /// Called in a DOM read phase to gather information that requires
  /// DOM layout. Should _not_ mutate the document.
  read(view: EditorView): T;
  /// Called in a DOM write phase to update the document. Should _not_
  /// do anything that triggers DOM layout.
  write?(measure: T, view: EditorView): void;
  /// When multiple requests with the same key are scheduled, only the
  /// last one will actually be run.
  key?: any;
}

export type AttrSource = Attrs | ((view: EditorView) => Attrs | null);

/** Facet 编辑属性 */
export const editorAttributes = Facet.define<AttrSource>();

/** Facet 内容属性 */
export const contentAttributes = Facet.define<AttrSource>();

// Facet 装饰器
export const decorations = Facet.define<DecorationSet | ((view: EditorView) => DecorationSet)>();

export const outerDecorations = Facet.define<
  DecorationSet | ((view: EditorView) => DecorationSet)
>();

export const atomicRanges = Facet.define<(view: EditorView) => RangeSet<any>>();

export const bidiIsolatedRanges = Facet.define<
  DecorationSet | ((view: EditorView) => DecorationSet)
>();

export function getIsolatedRanges(view: EditorView, line: Line): readonly Isolate[] {
  const isolates = view.state.facet(bidiIsolatedRanges);
  if (!isolates.length) return isolates as any[];
  const sets = isolates.map<DecorationSet>((i) => (i instanceof Function ? i(view) : i));
  const result: Isolate[] = [];
  RangeSet.spans(sets, line.from, line.to, {
    point() {},
    span(fromDoc, toDoc, active, open) {
      const from = fromDoc - line.from,
        to = toDoc - line.from;
      let level = result;
      for (let i = active.length - 1; i >= 0; i--, open--) {
        let direction = active[i].spec.bidiIsolate,
          update;
        if (direction == null) direction = autoDirection(line.text, from, to);
        if (
          open > 0 &&
          level.length &&
          (update = level[level.length - 1]).to == from &&
          update.direction == direction
        ) {
          update.to = to;
          level = update.inner as Isolate[];
        } else {
          const add = { from, to, direction, inner: [] };
          level.push(add);
          level = add.inner;
        }
      }
    },
  });
  return result;
}

export const scrollMargins = Facet.define<(view: EditorView) => Partial<Rect> | null>();

export function getScrollMargins(view: EditorView) {
  let left = 0,
    right = 0,
    top = 0,
    bottom = 0;
  for (const source of view.state.facet(scrollMargins)) {
    const m = source(view);
    if (m) {
      if (m.left != null) {
        left = Math.max(left, m.left);
      }
      if (m.right != null) {
        right = Math.max(right, m.right);
      }
      if (m.top != null) {
        top = Math.max(top, m.top);
      }
      if (m.bottom != null) {
        bottom = Math.max(bottom, m.bottom);
      }
    }
  }
  return { left, right, top, bottom };
}

export const styleModule = Facet.define<StyleModule>();

export const enum UpdateFlag {
  Focus = 1,
  Height = 2,
  Viewport = 4,
  Geometry = 8,
}

/** 已变更的文档范围 */
export class ChangedRange {
  constructor(
    /** 从 a 变更到 b, fromA-toA 是原范围 fromB-toB 是变更后的范围 */
    readonly fromA: number,
    readonly toA: number,
    readonly fromB: number,
    readonly toB: number
  ) {}

  join(other: ChangedRange): ChangedRange {
    return new ChangedRange(
      Math.min(this.fromA, other.fromA),
      Math.max(this.toA, other.toA),
      Math.min(this.fromB, other.fromB),
      Math.max(this.toB, other.toB)
    );
  }

  addToSet(set: ChangedRange[]): ChangedRange[] {
    let i = set.length;
    let me: ChangedRange = this;

    for (; i > 0; i--) {
      const range = set[i - 1];

      if (range.fromA > me.toA) {
        continue;
      }

      if (range.toA < me.fromA) {
        break;
      }

      me = me.join(range);
      set.splice(i - 1, 1);
    }

    set.splice(i, 0, me);

    return set;
  }

  static extendWithRanges(
    diff: readonly ChangedRange[],
    ranges: number[]
  ): readonly ChangedRange[] {
    if (ranges.length == 0) return diff;
    const result: ChangedRange[] = [];
    for (let dI = 0, rI = 0, posA = 0, posB = 0; ; dI++) {
      const next = dI == diff.length ? null : diff[dI],
        off = posA - posB;
      const end = next ? next.fromB : 1e9;
      while (rI < ranges.length && ranges[rI] < end) {
        const from = ranges[rI],
          to = ranges[rI + 1];
        const fromB = Math.max(posB, from),
          toB = Math.min(end, to);
        if (fromB <= toB) new ChangedRange(fromB + off, toB + off, fromB, toB).addToSet(result);
        if (to > end) break;
        else rI += 2;
      }
      if (!next) return result;
      new ChangedRange(next.fromA, next.toA, next.fromB, next.toB).addToSet(result);
      posA = next.toA;
      posB = next.toB;
    }
  }
}

/** 视图 [插件](#view.ViewPlugin) 被给予此实例类，它描述每当视图更新时发生的事情 */
export class ViewUpdate {
  /// The changes made to the document by this update.
  readonly changes: ChangeSet;
  /// The previous editor state.
  readonly startState: EditorState;
  /// @internal
  flags = 0;
  /// @internal
  changedRanges: readonly ChangedRange[];

  private constructor(
    /// The editor view that the update is associated with.
    readonly view: EditorView,
    /// The new editor state.
    readonly state: EditorState,
    /// The transactions involved in the update. May be empty.
    readonly transactions: readonly Transaction[]
  ) {
    this.startState = view.state;
    this.changes = ChangeSet.empty(this.startState.doc.length);

    for (const tr of transactions) {
      this.changes = this.changes.compose(tr.changes);
    }

    const changedRanges: ChangedRange[] = [];
    this.changes.iterChangedRanges((fromA, toA, fromB, toB) =>
      changedRanges.push(new ChangedRange(fromA, toA, fromB, toB))
    );
    this.changedRanges = changedRanges;
  }

  /// @internal
  static create(view: EditorView, state: EditorState, transactions: readonly Transaction[]) {
    return new ViewUpdate(view, state, transactions);
  }

  /// Tells you whether the [viewport](#view.EditorView.viewport) or
  /// [visible ranges](#view.EditorView.visibleRanges) changed in this
  /// update.
  get viewportChanged() {
    return (this.flags & UpdateFlag.Viewport) > 0;
  }

  /// Indicates whether the height of a block element in the editor
  /// changed in this update.
  get heightChanged() {
    return (this.flags & UpdateFlag.Height) > 0;
  }

  /// Returns true when the document was modified or the size of the
  /// editor, or elements within the editor, changed.
  get geometryChanged() {
    return this.docChanged || (this.flags & (UpdateFlag.Geometry | UpdateFlag.Height)) > 0;
  }

  /// True when this update indicates a focus change.
  get focusChanged() {
    return (this.flags & UpdateFlag.Focus) > 0;
  }

  /// Whether the document changed in this update.
  get docChanged() {
    return !this.changes.empty;
  }

  /// Whether the selection was explicitly set in this update.
  get selectionSet() {
    return this.transactions.some((tr) => tr.selection);
  }

  /// @internal
  get empty() {
    return this.flags == 0 && this.transactions.length == 0;
  }
}
