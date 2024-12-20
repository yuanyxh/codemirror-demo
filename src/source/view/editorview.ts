import {
  EditorState,
  Transaction,
  TransactionSpec,
  Extension,
  Prec,
  ChangeDesc,
  EditorSelection,
  SelectionRange,
  StateEffect,
  Facet,
  Line,
  EditorStateConfig,
} from "@/state/index";
import { StyleModule, StyleSpec } from "style-mod";

import { DocView } from "./views/docview";
import { ContentView } from "./views/contentview";
import { InputState, focusChangeTransaction, isFocusChange } from "./utils/input";
import {
  Rect,
  focusPreventScroll,
  flattenRect,
  getRoot,
  ScrollStrategy,
  isScrolledToBottom,
  dispatchKey,
} from "./utils/dom";
import {
  posAtCoords,
  moveByChar,
  moveToLineBoundary,
  byGroup,
  moveVertically,
  skipAtoms,
} from "./utils/cursor";
import { BlockInfo } from "./utils/heightmap";
import { ViewState } from "./viewstate";
import {
  ViewUpdate,
  styleModule,
  contentAttributes,
  editorAttributes,
  AttrSource,
  clickAddsSelectionRange,
  dragMovesSelection,
  mouseSelectionStyle,
  exceptionSink,
  updateListener,
  logException,
  viewPlugin,
  ViewPlugin,
  PluginValue,
  PluginInstance,
  decorations,
  outerDecorations,
  atomicRanges,
  scrollMargins,
  MeasureRequest,
  editable,
  inputHandler,
  focusChangeEffect,
  perLineTextDirection,
  scrollIntoView,
  UpdateFlag,
  ScrollTarget,
  bidiIsolatedRanges,
  getIsolatedRanges,
  scrollHandler,
  clipboardInputFilter,
  clipboardOutputFilter,
} from "./extensions/extension";
import {
  theme,
  darkTheme,
  buildTheme,
  baseThemeID,
  baseLightID,
  baseDarkID,
  lightDarkIDs,
  baseTheme,
} from "./utils/theme";
import { DOMObserver } from "./utils/domobserver";
import { Attrs, updateAttrs, combineAttrs } from "./utils/attributes";
import browser from "./utils/browser";
import { computeOrder, trivialOrder, BidiSpan, Direction, Isolate, isolatesEq } from "./utils/bidi";
import { applyDOMChange, DOMChange } from "./utils/domchange";

/** 主要的编辑器视图 */

export interface EditorViewConfig extends EditorStateConfig {
  state?: EditorState;

  parent?: Element | DocumentFragment;

  root?: Document | ShadowRoot;

  /** 初始滚动位置 */
  scrollTo?: StateEffect<any>;

  /** 分发事务，修改状态 */
  dispatchTransactions?: (trs: readonly Transaction[], view: EditorView) => void;

  /** 已过时，分发事务，修改状态 */
  dispatch?: (tr: Transaction, view: EditorView) => void;
}

/** 更新状态 */
export const enum UpdateState {
  /**  不更新，闲置状态 */
  Idle,
  /** 布局检查状态 */
  Measuring,
  /** 更新/绘制中，通过 update 方法或布局检查返回的结果 */
  Updating,
}

// 更新机制
//
//  闲置 → 更新 ⇆ 闲置 (未选中) → 测量是否需要更新 → 闲置
//                                ↑      ↓
//                             需要更新 (测量)

export class EditorView {
  /** 当前编辑器状态 */
  get state() {
    return this.viewState.state;
  }

  /** 当前绘制的范围，codemirror 只绘制可见视口范围内的 dom */
  get viewport(): { from: number; to: number } {
    return this.viewState.viewport;
  }

  /**
   * 在可见视口中，可能有折叠区域，实际内容比展示出来的内容更多，这个属性是隐藏内容的集合
   */
  get visibleRanges(): readonly { from: number; to: number }[] {
    return this.viewState.visibleRanges;
  }

  /** 编辑器是否可见 */
  get inView() {
    return this.viewState.inView;
  }

  /** 用户是否使用 ime 输入，并已进行一项更改 */
  get composing() {
    return this.inputState.composing > 0;
  }

  /** 是否在编写内容 */
  get compositionStarted() {
    return this.inputState.composing >= 0;
  }

  /** 派发事务 */
  private dispatchTransactions: (trs: readonly Transaction[], view: EditorView) => void;

  private _root: DocumentOrShadowRoot;

  /** 根视图 */
  get root() {
    return this._root;
  }

  /** window */
  get win() {
    return this.dom.ownerDocument.defaultView || window;
  }

  /** 编辑器容器 */
  readonly dom: HTMLElement;

  /** 滚动容器（一般情况下） */
  readonly scrollDOM: HTMLElement;

  /**
   * 可编辑 dom 实例，与 state 映射，通过外部 dom 操作变更的内容会立即被撤销
   * 应该通过 dispatch 分发事务改变状态，以此来修改视图
   * */
  readonly contentDOM: HTMLElement;

  private announceDOM: HTMLElement;

  /** 输入事件的工具类 */
  inputState!: InputState;

  /** 与 state 通信的中间层 */
  public viewState: ViewState;

  /** 文档视图 */
  public docView: DocView;

  /** 插件集 */
  private plugins: PluginInstance[] = [];
  /** 插件 map 记录 */
  private pluginMap: Map<ViewPlugin<any>, PluginInstance | null> = new Map();

  /** 编辑器容器属性 */
  private editorAttrs: Attrs = {};
  /** 可编辑 dom 属性 */
  private contentAttrs: Attrs = {};
  /** 样式 module */

  private styleModules!: readonly StyleModule[];
  /** 双向文本的缓存 */
  private bidiCache: CachedOrder[] = [];

  /** 已被销毁 */
  private destroyed = false;

  /** 当前编辑器的更新状态 */
  updateState: UpdateState = UpdateState.Updating;

  /** dom 事件侦听工具 */
  observer: DOMObserver;

  /** 测量调度 */
  measureScheduled: number = -1;

  /** 测量请求 */
  measureRequests: MeasureRequest<any>[] = [];

  constructor(config: EditorViewConfig = {}) {
    // 创建可编辑 dom
    this.contentDOM = document.createElement("div");

    // 创建滚动 dom
    this.scrollDOM = document.createElement("div");
    this.scrollDOM.tabIndex = -1;
    this.scrollDOM.className = "cm-scroller";
    this.scrollDOM.appendChild(this.contentDOM);

    this.announceDOM = document.createElement("div");
    this.announceDOM.className = "cm-announced";
    this.announceDOM.setAttribute("aria-live", "polite");

    // 创建编辑器容器
    this.dom = document.createElement("div");
    this.dom.appendChild(this.announceDOM);
    this.dom.appendChild(this.scrollDOM);

    // 将编辑器容器附加到 parent
    if (config.parent) {
      config.parent.appendChild(this.dom);
    }

    // 创建状态分发器
    const { dispatch } = config;

    this.dispatchTransactions =
      config.dispatchTransactions ||
      (dispatch && ((trs: readonly Transaction[]) => trs.forEach((tr) => dispatch!(tr, this)))) ||
      ((trs: readonly Transaction[]) => this.update(trs));

    this.dispatch = this.dispatch.bind(this);

    // 根元素
    this._root = (config.root || getRoot(config.parent) || document) as DocumentOrShadowRoot;

    // 创建视图状态
    this.viewState = new ViewState(config.state || EditorState.create(config));

    // 创建 scrollTarget
    if (config.scrollTo && config.scrollTo.is(scrollIntoView)) {
      this.viewState.scrollTarget = config.scrollTo.value.clip(this.viewState.state);
    }

    // 获取所有视图插件
    this.plugins = this.state.facet(viewPlugin).map((spec) => new PluginInstance(spec));

    // 创建插件，生命周期 create
    for (const plugin of this.plugins) {
      plugin.update(this);
    }

    this.observer = new DOMObserver(this);

    this.inputState = new InputState(this);
    /** contentDOM 注册输入等相关事件 */
    this.inputState.ensureHandlers(this.plugins);

    /** 创建文档视图 */
    this.docView = new DocView(this);

    // 渲染样式
    this.mountStyles();

    // 更新属性
    this.updateAttrs();

    // 更新状态变为闲置
    this.updateState = UpdateState.Idle;

    // 测量布局
    this.requestMeasure();

    /** 等待字体加载完成，布局完成后重新计算布局 */
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => this.requestMeasure());
    }
  }

  /// All regular editor state updates should go through this. It
  /// takes a transaction, array of transactions, or transaction spec
  /// and updates the view to show the new state produced by that
  /// transaction. Its implementation can be overridden with an
  /// [option](#view.EditorView.constructor^config.dispatchTransactions).
  /// This function is bound to the view instance, so it does not have
  /// to be called as a method.
  ///
  /// Note that when multiple `TransactionSpec` arguments are
  /// provided, these define a single transaction (the specs will be
  /// merged), not a sequence of transactions.
  dispatch(tr: Transaction): void;
  dispatch(trs: readonly Transaction[]): void;
  dispatch(...specs: TransactionSpec[]): void;
  dispatch(...input: (Transaction | readonly Transaction[] | TransactionSpec)[]) {
    const trs =
      input.length == 1 && input[0] instanceof Transaction
        ? (input as readonly Transaction[])
        : input.length == 1 && Array.isArray(input[0])
        ? (input[0] as readonly Transaction[])
        : [this.state.update(...(input as TransactionSpec[]))];
    this.dispatchTransactions(trs, this);
  }

  /// Update the view for the given array of transactions. This will
  /// update the visible document and selection to match the state
  /// produced by the transactions, and notify view plugins of the
  /// change. You should usually call
  /// [`dispatch`](#view.EditorView.dispatch) instead, which uses this
  /// as a primitive.
  update(transactions: readonly Transaction[]) {
    if (this.updateState != UpdateState.Idle) {
      throw new Error("Calls to EditorView.update are not allowed while an update is in progress");
    }

    let redrawn = false;
    let attrsChanged = false;
    let state = this.state;
    for (const tr of transactions) {
      if (tr.startState != state) {
        throw new RangeError(
          "Trying to update state with a transaction that doesn't start from the previous state."
        );
      }

      state = tr.state;
    }

    if (this.destroyed) {
      this.viewState.state = state;
      return;
    }

    const focus = this.hasFocus;

    let focusFlag = 0;
    let dispatchFocus: Transaction | null = null;

    if (transactions.some((tr) => tr.annotation(isFocusChange))) {
      this.inputState.notifiedFocused = focus;
      // If a focus-change transaction is being dispatched, set this update flag.
      focusFlag = UpdateFlag.Focus;
    } else if (focus != this.inputState.notifiedFocused) {
      this.inputState.notifiedFocused = focus;
      // Schedule a separate focus transaction if necessary, otherwise
      // add a flag to this update
      dispatchFocus = focusChangeTransaction(state, focus);

      if (!dispatchFocus) {
        focusFlag = UpdateFlag.Focus;
      }
    }

    // If there was a pending DOM change, eagerly read it and try to
    // apply it after the given transactions.
    const pendingKey = this.observer.delayedAndroidKey;
    let domChange: DOMChange | null = null;

    if (pendingKey) {
      this.observer.clearDelayedAndroidKey();
      domChange = this.observer.readChange();

      // Only try to apply DOM changes if the transactions didn't
      // change the doc or selection.
      if (
        (domChange && !this.state.doc.eq(state.doc)) ||
        !this.state.selection.eq(state.selection)
      ) {
        domChange = null;
      }
    } else {
      this.observer.clear();
    }

    // When the phrases change, redraw the editor
    if (state.facet(EditorState.phrases) != this.state.facet(EditorState.phrases)) {
      return this.setState(state);
    }

    const update = ViewUpdate.create(this, state, transactions);
    update.flags |= focusFlag;

    let scrollTarget = this.viewState.scrollTarget;

    try {
      this.updateState = UpdateState.Updating;

      for (const tr of transactions) {
        if (scrollTarget) {
          scrollTarget = scrollTarget.map(tr.changes);
        }

        if (tr.scrollIntoView) {
          const { main } = tr.state.selection;

          scrollTarget = new ScrollTarget(
            main.empty ? main : EditorSelection.cursor(main.head, main.head > main.anchor ? -1 : 1)
          );
        }

        for (const e of tr.effects) {
          if (e.is(scrollIntoView)) {
            scrollTarget = e.value.clip(this.state);
          }
        }
      }

      this.viewState.update(update, scrollTarget);

      this.bidiCache = CachedOrder.update(this.bidiCache, update.changes);

      if (!update.empty) {
        this.updatePlugins(update);
        this.inputState.update(update);
      }

      redrawn = this.docView.update(update);

      if (this.state.facet(styleModule) != this.styleModules) {
        this.mountStyles();
      }

      attrsChanged = this.updateAttrs();

      this.showAnnouncements(transactions);
      this.docView.updateSelection(
        redrawn,
        transactions.some((tr) => tr.isUserEvent("select.pointer"))
      );
    } finally {
      this.updateState = UpdateState.Idle;
    }

    if (update.startState.facet(theme) != update.state.facet(theme)) {
      this.viewState.mustMeasureContent = true;
    }

    if (
      redrawn ||
      attrsChanged ||
      scrollTarget ||
      this.viewState.mustEnforceCursorAssoc ||
      this.viewState.mustMeasureContent
    ) {
      this.requestMeasure();
    }

    if (redrawn) {
      this.docViewUpdate();
    }

    if (!update.empty) {
      for (const listener of this.state.facet(updateListener)) {
        try {
          listener(update);
        } catch (e) {
          logException(this.state, e, "update listener");
        }
      }
    }

    if (dispatchFocus || domChange) {
      Promise.resolve().then(() => {
        if (dispatchFocus && this.state == dispatchFocus.startState) {
          this.dispatch(dispatchFocus);
        }

        if (domChange) {
          if (!applyDOMChange(this, domChange) && pendingKey!.force) {
            dispatchKey(this.contentDOM, pendingKey!.key, pendingKey!.keyCode);
          }
        }
      });
    }
  }

  /// Reset the view to the given state. (This will cause the entire
  /// document to be redrawn and all view plugins to be reinitialized,
  /// so you should probably only use it when the new state isn't
  /// derived from the old state. Otherwise, use
  /// [`dispatch`](#view.EditorView.dispatch) instead.)
  setState(newState: EditorState) {
    if (this.updateState != UpdateState.Idle) {
      throw new Error(
        "Calls to EditorView.setState are not allowed while an update is in progress"
      );
    }

    if (this.destroyed) {
      this.viewState.state = newState;
      return;
    }

    this.updateState = UpdateState.Updating;
    const hadFocus = this.hasFocus;

    try {
      for (const plugin of this.plugins) {
        plugin.destroy(this);
      }

      this.viewState = new ViewState(newState);
      this.plugins = newState.facet(viewPlugin).map((spec) => new PluginInstance(spec));
      this.pluginMap.clear();

      for (const plugin of this.plugins) {
        plugin.update(this);
      }

      this.docView.destroy();
      this.docView = new DocView(this);
      this.inputState.ensureHandlers(this.plugins);
      this.mountStyles();
      this.updateAttrs();
      this.bidiCache = [];
    } finally {
      this.updateState = UpdateState.Idle;
    }

    if (hadFocus) {
      this.focus();
    }

    this.requestMeasure();
  }

  private updatePlugins(update: ViewUpdate) {
    const prevSpecs = update.startState.facet(viewPlugin);
    const specs = update.state.facet(viewPlugin);

    if (prevSpecs != specs) {
      const newPlugins = [];

      for (const spec of specs) {
        const found = prevSpecs.indexOf(spec);

        if (found < 0) {
          newPlugins.push(new PluginInstance(spec));
        } else {
          const plugin = this.plugins[found];
          plugin.mustUpdate = update;
          newPlugins.push(plugin);
        }
      }

      for (const plugin of this.plugins) {
        if (plugin.mustUpdate != update) {
          plugin.destroy(this);
        }
      }

      this.plugins = newPlugins;
      this.pluginMap.clear();
    } else {
      for (const p of this.plugins) {
        p.mustUpdate = update;
      }
    }

    for (let i = 0; i < this.plugins.length; i++) {
      this.plugins[i].update(this);
    }

    if (prevSpecs != specs) {
      this.inputState.ensureHandlers(this.plugins);
    }
  }

  private docViewUpdate() {
    for (const plugin of this.plugins) {
      const val = plugin.value;
      if (val && val.docViewUpdate) {
        try {
          val.docViewUpdate(this);
        } catch (e) {
          logException(this.state, e, "doc view update listener");
        }
      }
    }
  }

  /** 测量布局 */
  measure(flush = true) {
    if (this.destroyed) {
      return;
    }

    if (this.measureScheduled > -1) {
      this.win.cancelAnimationFrame(this.measureScheduled);
    }

    if (this.observer.delayedAndroidKey) {
      this.measureScheduled = -1;
      this.requestMeasure();
      return;
    }

    this.measureScheduled = 0; // Prevent requestMeasure calls from scheduling another animation frame

    if (flush) {
      this.observer.forceFlush();
    }

    let updated: ViewUpdate | null = null;
    const sDOM = this.scrollDOM;
    let scrollTop = sDOM.scrollTop * this.scaleY;
    let { scrollAnchorPos, scrollAnchorHeight } = this.viewState;

    if (Math.abs(scrollTop - this.viewState.scrollTop) > 1) {
      scrollAnchorHeight = -1;
    }

    this.viewState.scrollAnchorHeight = -1;

    try {
      for (let i = 0; ; i++) {
        if (scrollAnchorHeight < 0) {
          if (isScrolledToBottom(sDOM)) {
            scrollAnchorPos = -1;
            scrollAnchorHeight = this.viewState.heightMap.height;
          } else {
            const block = this.viewState.scrollAnchorAt(scrollTop);
            scrollAnchorPos = block.from;
            scrollAnchorHeight = block.top;
          }
        }

        this.updateState = UpdateState.Measuring;
        const changed = this.viewState.measure(this);

        if (!changed && !this.measureRequests.length && this.viewState.scrollTarget == null) {
          break;
        }

        if (i > 5) {
          console.warn(
            this.measureRequests.length
              ? "Measure loop restarted more than 5 times"
              : "Viewport failed to stabilize"
          );

          break;
        }

        let measuring: MeasureRequest<any>[] = [];
        // Only run measure requests in this cycle when the viewport didn't change
        if (!(changed & UpdateFlag.Viewport)) {
          [this.measureRequests, measuring] = [measuring, this.measureRequests];
        }

        const measured = measuring.map((m) => {
          try {
            return m.read(this);
          } catch (e) {
            logException(this.state, e);
            return BadMeasure;
          }
        });

        const update = ViewUpdate.create(this, this.state, []);
        let redrawn = false;
        update.flags |= changed;

        if (!updated) {
          updated = update;
        } else {
          updated.flags |= changed;
        }

        this.updateState = UpdateState.Updating;
        if (!update.empty) {
          this.updatePlugins(update);
          this.inputState.update(update);
          this.updateAttrs();
          redrawn = this.docView.update(update);

          if (redrawn) {
            this.docViewUpdate();
          }
        }

        for (let i = 0; i < measuring.length; i++) {
          if (measured[i] != BadMeasure) {
            try {
              const m = measuring[i];
              if (m.write) {
                m.write(measured[i], this);
              }
            } catch (e) {
              logException(this.state, e);
            }
          }
        }

        if (redrawn) {
          this.docView.updateSelection(true);
        }

        if (!update.viewportChanged && this.measureRequests.length == 0) {
          if (this.viewState.editorHeight) {
            if (this.viewState.scrollTarget) {
              this.docView.scrollIntoView(this.viewState.scrollTarget);
              this.viewState.scrollTarget = null;
              scrollAnchorHeight = -1;
              continue;
            } else {
              const newAnchorHeight =
                scrollAnchorPos < 0
                  ? this.viewState.heightMap.height
                  : this.viewState.lineBlockAt(scrollAnchorPos).top;
              const diff = newAnchorHeight - scrollAnchorHeight;

              if (diff > 1 || diff < -1) {
                scrollTop = scrollTop + diff;
                sDOM.scrollTop = scrollTop / this.scaleY;
                scrollAnchorHeight = -1;
                continue;
              }
            }
          }

          break;
        }
      }
    } finally {
      this.updateState = UpdateState.Idle;
      this.measureScheduled = -1;
    }

    if (updated && !updated.empty) {
      for (const listener of this.state.facet(updateListener)) {
        listener(updated);
      }
    }
  }

  /// Get the CSS classes for the currently active editor themes.
  get themeClasses() {
    return (
      baseThemeID +
      " " +
      (this.state.facet(darkTheme) ? baseDarkID : baseLightID) +
      " " +
      this.state.facet(theme)
    );
  }

  private updateAttrs() {
    const editorAttrs = attrsFromFacet(this, editorAttributes, {
      class: "cm-editor" + (this.hasFocus ? " cm-focused " : " ") + this.themeClasses,
    });

    const contentAttrs: Attrs = {
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
      contenteditable: !this.state.facet(editable) ? "false" : "true",
      class: "cm-content",
      style: `${browser.tabSize}: ${this.state.tabSize}`,
      role: "textbox",
      "aria-multiline": "true",
    };

    if (this.state.readOnly) {
      contentAttrs["aria-readonly"] = "true";
    }

    attrsFromFacet(this, contentAttributes, contentAttrs);

    // 更新 dom 属性
    const changed = this.observer.ignore(() => {
      const changedContent = updateAttrs(this.contentDOM, this.contentAttrs, contentAttrs);
      const changedEditor = updateAttrs(this.dom, this.editorAttrs, editorAttrs);

      return changedContent || changedEditor;
    });

    this.editorAttrs = editorAttrs;
    this.contentAttrs = contentAttrs;

    return changed;
  }

  private showAnnouncements(trs: readonly Transaction[]) {
    let first = true;

    for (const tr of trs) {
      for (const effect of tr.effects) {
        if (effect.is(EditorView.announce)) {
          if (first) {
            this.announceDOM.textContent = "";
          }

          first = false;
          const div = this.announceDOM.appendChild(document.createElement("div"));
          div.textContent = effect.value;
        }
      }
    }
  }

  private mountStyles() {
    this.styleModules = this.state.facet(styleModule);

    const nonce = this.state.facet(EditorView.cspNonce);

    StyleModule.mount(
      this.root,
      this.styleModules.concat(baseTheme).reverse(),
      nonce ? { nonce } : undefined
    );
  }

  private readMeasured() {
    if (this.updateState == UpdateState.Updating) {
      throw new Error("Reading the editor layout isn't allowed during an update");
    }

    if (this.updateState == UpdateState.Idle && this.measureScheduled > -1) {
      this.measure(false);
    }
  }

  /**
   * 安排布局测量，可选择提供回调进行自定义 DOM 测量，然后进行 DOM 写入阶段
   * 使用这最好是直接读取 DOM 布局
   * 例如，一个事件处理程序，因为它将确保测量和其他组件完成的绘制是同步的，避免了不必要的 DOM 布局计算。
   */
  requestMeasure<T>(request?: MeasureRequest<T>) {
    if (this.measureScheduled < 0) {
      this.measureScheduled = this.win.requestAnimationFrame(() => this.measure());
    }

    if (request) {
      if (this.measureRequests.indexOf(request) > -1) {
        return;
      }

      if (request.key != null) {
        for (let i = 0; i < this.measureRequests.length; i++) {
          if (this.measureRequests[i].key === request.key) {
            this.measureRequests[i] = request;
            return;
          }
        }
      }

      this.measureRequests.push(request);
    }
  }

  /**
   * 获取特定插件的值（如果存在）
   * 请注意，崩溃的插件可以从视图中删除，因此即使您知道您注册了给定的插件，也建议检查此方法的返回值
   */
  plugin<T extends PluginValue>(plugin: ViewPlugin<T>): T | null {
    let known = this.pluginMap.get(plugin);

    if (known === undefined || (known && known.spec != plugin)) {
      this.pluginMap.set(plugin, (known = this.plugins.find((p) => p.spec == plugin) || null));
    }

    return known && (known.update(this).value as T);
  }

  /// The top position of the document, in screen coordinates. This
  /// may be negative when the editor is scrolled down. Points
  /// directly to the top of the first line, not above the padding.
  get documentTop() {
    return this.contentDOM.getBoundingClientRect().top + this.viewState.paddingTop;
  }

  /// Reports the padding above and below the document.
  get documentPadding() {
    return { top: this.viewState.paddingTop, bottom: this.viewState.paddingBottom };
  }

  /// If the editor is transformed with CSS, this provides the scale
  /// along the X axis. Otherwise, it will just be 1. Note that
  /// transforms other than translation and scaling are not supported.
  get scaleX() {
    return this.viewState.scaleX;
  }

  /// Provide the CSS transformed scale along the Y axis.
  get scaleY() {
    return this.viewState.scaleY;
  }

  /// Find the text line or block widget at the given vertical
  /// position (which is interpreted as relative to the [top of the
  /// document](#view.EditorView.documentTop)).
  elementAtHeight(height: number) {
    this.readMeasured();

    return this.viewState.elementAtHeight(height);
  }

  /// Find the line block (see
  /// [`lineBlockAt`](#view.EditorView.lineBlockAt) at the given
  /// height, again interpreted relative to the [top of the
  /// document](#view.EditorView.documentTop).
  lineBlockAtHeight(height: number): BlockInfo {
    this.readMeasured();

    return this.viewState.lineBlockAtHeight(height);
  }

  /// Get the extent and vertical position of all [line
  /// blocks](#view.EditorView.lineBlockAt) in the viewport. Positions
  /// are relative to the [top of the
  /// document](#view.EditorView.documentTop);
  get viewportLineBlocks() {
    return this.viewState.viewportLines;
  }

  /// Find the line block around the given document position. A line
  /// block is a range delimited on both sides by either a
  /// non-[hidden](#view.Decoration^replace) line break, or the
  /// start/end of the document. It will usually just hold a line of
  /// text, but may be broken into multiple textblocks by block
  /// widgets.
  lineBlockAt(pos: number): BlockInfo {
    return this.viewState.lineBlockAt(pos);
  }

  /// The editor's total content height.
  get contentHeight() {
    return this.viewState.contentHeight;
  }

  /// Move a cursor position by [grapheme
  /// cluster](#state.findClusterBreak). `forward` determines whether
  /// the motion is away from the line start, or towards it. In
  /// bidirectional text, the line is traversed in visual order, using
  /// the editor's [text direction](#view.EditorView.textDirection).
  /// When the start position was the last one on the line, the
  /// returned position will be across the line break. If there is no
  /// further line, the original position is returned.
  ///
  /// By default, this method moves over a single cluster. The
  /// optional `by` argument can be used to move across more. It will
  /// be called with the first cluster as argument, and should return
  /// a predicate that determines, for each subsequent cluster,
  /// whether it should also be moved over.
  moveByChar(
    start: SelectionRange,
    forward: boolean,
    by?: (initial: string) => (next: string) => boolean
  ) {
    return skipAtoms(this, start, moveByChar(this, start, forward, by));
  }

  /// Move a cursor position across the next group of either
  /// [letters](#state.EditorState.charCategorizer) or non-letter
  /// non-whitespace characters.
  moveByGroup(start: SelectionRange, forward: boolean) {
    return skipAtoms(
      this,
      start,
      moveByChar(this, start, forward, (initial) => byGroup(this, start.head, initial))
    );
  }

  /// Get the cursor position visually at the start or end of a line.
  /// Note that this may differ from the _logical_ position at its
  /// start or end (which is simply at `line.from`/`line.to`) if text
  /// at the start or end goes against the line's base text direction.
  visualLineSide(line: Line, end: boolean) {
    const order = this.bidiSpans(line);
    const dir = this.textDirectionAt(line.from);
    const span = order[end ? order.length - 1 : 0];

    return EditorSelection.cursor(
      span.side(end, dir) + line.from,
      span.forward(!end, dir) ? 1 : -1
    );
  }

  /// Move to the next line boundary in the given direction. If
  /// `includeWrap` is true, line wrapping is on, and there is a
  /// further wrap point on the current line, the wrap point will be
  /// returned. Otherwise this function will return the start or end
  /// of the line.
  moveToLineBoundary(start: SelectionRange, forward: boolean, includeWrap = true) {
    return moveToLineBoundary(this, start, forward, includeWrap);
  }

  /// Move a cursor position vertically. When `distance` isn't given,
  /// it defaults to moving to the next line (including wrapped
  /// lines). Otherwise, `distance` should provide a positive distance
  /// in pixels.
  ///
  /// When `start` has a
  /// [`goalColumn`](#state.SelectionRange.goalColumn), the vertical
  /// motion will use that as a target horizontal position. Otherwise,
  /// the cursor's own horizontal position is used. The returned
  /// cursor will have its goal column set to whichever column was
  /// used.
  moveVertically(start: SelectionRange, forward: boolean, distance?: number) {
    return skipAtoms(this, start, moveVertically(this, start, forward, distance));
  }

  /// Find the DOM parent node and offset (child offset if `node` is
  /// an element, character offset when it is a text node) at the
  /// given document position.
  ///
  /// Note that for positions that aren't currently in
  /// `visibleRanges`, the resulting DOM position isn't necessarily
  /// meaningful (it may just point before or after a placeholder
  /// element).
  domAtPos(pos: number): { node: Node; offset: number } {
    return this.docView.domAtPos(pos);
  }

  /// Find the document position at the given DOM node. Can be useful
  /// for associating positions with DOM events. Will raise an error
  /// when `node` isn't part of the editor content.
  posAtDOM(node: Node, offset: number = 0) {
    return this.docView.posFromDOM(node, offset);
  }

  /// Get the document position at the given screen coordinates. For
  /// positions not covered by the visible viewport's DOM structure,
  /// this will return null, unless `false` is passed as second
  /// argument, in which case it'll return an estimated position that
  /// would be near the coordinates if it were rendered.
  posAtCoords(coords: { x: number; y: number }, precise: false): number;
  posAtCoords(coords: { x: number; y: number }): number | null;
  posAtCoords(coords: { x: number; y: number }, precise = true): number | null {
    this.readMeasured();
    return posAtCoords(this, coords, precise);
  }

  /// Get the screen coordinates at the given document position.
  /// `side` determines whether the coordinates are based on the
  /// element before (-1) or after (1) the position (if no element is
  /// available on the given side, the method will transparently use
  /// another strategy to get reasonable coordinates).
  coordsAtPos(pos: number, side: -1 | 1 = 1): Rect | null {
    this.readMeasured();

    const rect = this.docView.coordsAt(pos, side);

    if (!rect || rect.left == rect.right) {
      return rect;
    }

    const line = this.state.doc.lineAt(pos);
    const order = this.bidiSpans(line);
    const span = order[BidiSpan.find(order, pos - line.from, -1, side)];

    return flattenRect(rect, (span.dir == Direction.LTR) == side > 0);
  }

  /// Return the rectangle around a given character. If `pos` does not
  /// point in front of a character that is in the viewport and
  /// rendered (i.e. not replaced, not a line break), this will return
  /// null. For space characters that are a line wrap point, this will
  /// return the position before the line break.
  coordsForChar(pos: number): Rect | null {
    this.readMeasured();

    return this.docView.coordsForChar(pos);
  }

  /// The default width of a character in the editor. May not
  /// accurately reflect the width of all characters (given variable
  /// width fonts or styling of invididual ranges).
  get defaultCharacterWidth() {
    return this.viewState.heightOracle.charWidth;
  }

  /// The default height of a line in the editor. May not be accurate
  /// for all lines.
  get defaultLineHeight() {
    return this.viewState.heightOracle.lineHeight;
  }

  /// The text direction
  /// ([`direction`](https://developer.mozilla.org/en-US/docs/Web/CSS/direction)
  /// CSS property) of the editor's content element.
  get textDirection(): Direction {
    return this.viewState.defaultTextDirection;
  }

  /**
   * 求给定位置块的文本方向，如下由 CSS 分配
   * 如果 (#view.EditorView^perLineTextDirection) 未启用，或者给定位置位于视口之外，这将始终返回与 (#view.EditorView.textDirection)
   * 注意这可能会触发 DOM 布局
   */
  textDirectionAt(pos: number) {
    const perLine = this.state.facet(perLineTextDirection);

    if (!perLine || pos < this.viewport.from || pos > this.viewport.to) {
      return this.textDirection;
    }

    this.readMeasured();

    return this.docView.textDirectionAt(pos);
  }

  /// Whether this editor [wraps lines](#view.EditorView.lineWrapping)
  /// (as determined by the
  /// [`white-space`](https://developer.mozilla.org/en-US/docs/Web/CSS/white-space)
  /// CSS property of its content element).
  get lineWrapping(): boolean {
    return this.viewState.heightOracle.lineWrapping;
  }

  /// Returns the bidirectional text structure of the given line
  /// (which should be in the current document) as an array of span
  /// objects. The order of these spans matches the [text
  /// direction](#view.EditorView.textDirection)—if that is
  /// left-to-right, the leftmost spans come first, otherwise the
  /// rightmost spans come first.
  bidiSpans(line: Line) {
    if (line.length > MaxBidiLine) {
      return trivialOrder(line.length);
    }

    const dir = this.textDirectionAt(line.from);
    let isolates: readonly Isolate[] | undefined;

    for (const entry of this.bidiCache) {
      if (
        entry.from == line.from &&
        entry.dir == dir &&
        (entry.fresh || isolatesEq(entry.isolates, (isolates = getIsolatedRanges(this, line))))
      ) {
        return entry.order;
      }
    }

    if (!isolates) {
      isolates = getIsolatedRanges(this, line);
    }

    const order = computeOrder(line.text, dir, isolates);
    this.bidiCache.push(new CachedOrder(line.from, line.to, dir, isolates, true, order));

    return order;
  }

  /// Check whether the editor has focus.
  get hasFocus(): boolean {
    // Safari return false for hasFocus when the context menu is open
    // or closing, which leads us to ignore selection changes from the
    // context menu because it looks like the editor isn't focused.
    // This kludges around that.
    return (
      (this.dom.ownerDocument.hasFocus() ||
        (browser.safari && this.inputState?.lastContextMenu > Date.now() - 3e4)) &&
      this.root.activeElement == this.contentDOM
    );
  }

  /// Put focus on the editor.
  focus() {
    this.observer.ignore(() => {
      focusPreventScroll(this.contentDOM);
      this.docView.updateSelection();
    });
  }

  /// Update the [root](##view.EditorViewConfig.root) in which the editor lives. This is only
  /// necessary when moving the editor's existing DOM to a new window or shadow root.
  setRoot(root: Document | ShadowRoot) {
    if (this._root != root) {
      this._root = root;

      this.observer.setWindow(
        (root.nodeType == 9 ? (root as Document) : root.ownerDocument!).defaultView || window
      );

      this.mountStyles();
    }
  }

  /// Clean up this editor view, removing its element from the
  /// document, unregistering event handlers, and notifying
  /// plugins. The view instance can no longer be used after
  /// calling this.
  destroy() {
    if (this.root.activeElement == this.contentDOM) {
      this.contentDOM.blur();
    }

    for (const plugin of this.plugins) {
      plugin.destroy(this);
    }

    this.plugins = [];

    this.inputState.destroy();
    this.docView.destroy();

    this.dom.remove();

    this.observer.destroy();
    if (this.measureScheduled > -1) {
      this.win.cancelAnimationFrame(this.measureScheduled);
    }

    this.destroyed = true;
  }

  /**
   * 返回一个可以 [添加](#state.TransactionSpec.effects) 到交易中的 StateEffect
   * 使其将给定位置或范围滚动到视图中
   */
  static scrollIntoView(
    pos: number | SelectionRange,
    options: {
      /// By default (`"nearest"`) the position will be vertically
      /// scrolled only the minimal amount required to move the given
      /// position into view. You can set this to `"start"` to move it
      /// to the top of the view, `"end"` to move it to the bottom, or
      /// `"center"` to move it to the center.
      y?: ScrollStrategy;
      /// Effect similar to
      /// [`y`](#view.EditorView^scrollIntoView^options.y), but for the
      /// horizontal scroll position.
      x?: ScrollStrategy;
      /// Extra vertical distance to add when moving something into
      /// view. Not used with the `"center"` strategy. Defaults to 5.
      /// Must be less than the height of the editor.
      yMargin?: number;
      /// Extra horizontal distance to add. Not used with the `"center"`
      /// strategy. Defaults to 5. Must be less than the width of the
      /// editor.
      xMargin?: number;
    } = {}
  ): StateEffect<unknown> {
    return scrollIntoView.of(
      new ScrollTarget(
        typeof pos == "number" ? EditorSelection.cursor(pos) : pos,
        options.y,
        options.x,
        options.yMargin,
        options.xMargin
      )
    );
  }

  /**
   * 返回一个效果，将编辑器重置为当前状态（在调用此方法的时间）滚动位置
   * 请注意，这只影响编辑器自己的可滚动元素，而不影响父元素
   * 参见 (#view.EditorViewConfig.scrollTo)
   *
   * 该效果应与与该效果相同的文档一起使用
   */
  scrollSnapshot() {
    const { scrollTop, scrollLeft } = this.scrollDOM;
    const ref = this.viewState.scrollAnchorAt(scrollTop);

    return scrollIntoView.of(
      new ScrollTarget(
        EditorSelection.cursor(ref.from),
        "start",
        "start",
        ref.top - scrollTop,
        scrollLeft,
        true
      )
    );
  }

  /// Enable or disable tab-focus mode, which disables key bindings
  /// for Tab and Shift-Tab, letting the browser's default
  /// focus-changing behavior go through instead. This is useful to
  /// prevent trapping keyboard users in your editor.
  ///
  /// Without argument, this toggles the mode. With a boolean, it
  /// enables (true) or disables it (false). Given a number, it
  /// temporarily enables the mode until that number of milliseconds
  /// have passed or another non-Tab key is pressed.
  setTabFocusMode(to?: boolean | number) {
    if (to == null) {
      this.inputState.tabFocusMode = this.inputState.tabFocusMode < 0 ? 0 : -1;
    } else if (typeof to == "boolean") {
      this.inputState.tabFocusMode = to ? 0 : -1;
    } else if (this.inputState.tabFocusMode != 0) {
      this.inputState.tabFocusMode = Date.now() + to;
    }
  }

  /**
   * Facet 添加 [样式模块](https://github.com/marijnh/style-mod#documentation) 到编辑器视图
   * 该视图将确保该模块是安装在其 (#view.EditorView.constructor^config.root)
   */
  static styleModule = styleModule;

  /**
   * 返回可用于添加 DOM 事件处理程序的扩展
   * 该值应该是将事件名称映射到处理程序的对象功能
   * 对于任何给定的事件，此类函数按以下顺序排序扩展优先级，第一个返回 true 的处理程序将假设已经处理了该事件，并且没有其他处理程序或将为它激活内置行为
   * 这些已注册在 (#view.EditorView.contentDOM) 上，除了对于 “scroll” 处理程序，它将在任何时候被调用编辑器的 (#view.EditorView.scrollDOM) 或其中之一
   */
  static domEventHandlers(handlers: DOMEventHandlers<any>): Extension {
    return ViewPlugin.define(() => ({}), { eventHandlers: handlers });
  }

  /**
   * 创建一个注册 DOM 事件观察器的扩展
   * 与 (#view.EditorView^domEventHandlers) 相反, 不能通过更高的优先级阻止观察者运行
   * 处理程序返回 true，他们也不阻止其他处理程序和观察者在返回 true 时停止运行，并且不应该调用 “preventDefault”
   */
  static domEventObservers(observers: DOMEventHandlers<any>): Extension {
    return ViewPlugin.define(() => ({}), { eventObservers: observers });
  }

  /**
   * 输入处理程序可以覆盖对可编辑内容的更改方式处理 DOM 内容
   * 处理程序传递文档发现变化的位置以及新的位置内容
   * 当返回 true 时，不再有输入处理程序调用并阻止默认行为
   * `insert` 参数可用于获取默认事务，这将应用于此输入，这在以下情况下很有用：将自定义行为作为单独的事务进行分派
   */
  static inputHandler = inputHandler;

  /** 剪切板输入 Facet */
  static clipboardInputFilter = clipboardInputFilter;

  /// Transform text copied or dragged from the editor.
  static clipboardOutputFilter = clipboardOutputFilter;

  /// Scroll handlers can override how things are scrolled into view.
  /// If they return `true`, no further handling happens for the
  /// scrolling. If they return false, the default scroll behavior is
  /// applied. Scroll handlers should never initiate editor updates.
  static scrollHandler = scrollHandler;

  /// This facet can be used to provide functions that create effects
  /// to be dispatched when the editor's focus state changes.
  static focusChangeEffect = focusChangeEffect;

  /**
   * 默认情况下，编辑器假定其所有内容都具有相同的 [文字方向](#view.Direction)
   * 使用 “true” 配置它使其读取每个（渲染）的文本方向分别行
   */
  static perLineTextDirection = perLineTextDirection;

  /**
   * 允许您提供一个应在以下情况下调用的函数：
   * 库从扩展捕获异常（主要是从视图插件，但可能被其他扩展用来路由异常来自用户代码提供的回调）
   * 这主要用于调试和日志记录
   * 请参阅[`logException`](#view.logException)
   */
  static exceptionSink = exceptionSink;

  /**
   * 每次视图更新时要调用的函数
   */
  static updateListener = updateListener;

  /// Facet that controls whether the editor content DOM is editable.
  /// When its highest-precedence value is `false`, the element will
  /// not have its `contenteditable` attribute set. (Note that this
  /// doesn't affect API calls that change the editor content, even
  /// when those are bound to keys or buttons. See the
  /// [`readOnly`](#state.EditorState.readOnly) facet for that.)
  static editable = editable;

  /**
   * 允许您影响鼠标选择的方式
   * 此 Facet 的函数将被 “mousedown” 事件调用在编辑器上，并且可以返回一个覆盖方式的对象
   * 选择是根据鼠标单击或拖动计算的
   */
  static mouseSelectionStyle = mouseSelectionStyle;

  /**
   * Facet 用于配置是否给定选择拖动事件应移动或复制选择
   * 给定的谓词将是使用 “mousedown” 事件调用，并且可以在以下情况下返回 “true” 拖动应该移动内容
   */
  static dragMovesSelection = dragMovesSelection;

  /**
   * Facet 用于配置给定的选择单击是否添加现有选择的新范围或完全替换它
   * 默认行为是在 macOS 上检查 `event.metaKey`，其他架构的 “event.ctrlKey”
   */
  static clickAddsSelectionRange = clickAddsSelectionRange;

  /**
   * 确定哪些[装饰](#view.Decoration)的 Facet 显示在视图中
   * 装饰品可以分为两种方式 - 直接或通过采用编辑器视图的函数
   *
   * 只有直接提供的装饰套件才允许影响编辑器的垂直布局结构
   * 提供的内容为在计算新视口之后调用函数，因此不得引入块小部件或替换覆盖换行符的装饰
   *
   * 如果您希望装饰范围表现得像原子单位光标移动和删除用途，还提供范围设置包含装饰品 (#view.EditorView^atomicRanges)
   */
  static decorations = decorations;

  /// Facet that works much like
  /// [`decorations`](#view.EditorView^decorations), but puts its
  /// inputs at the very bottom of the precedence stack, meaning mark
  /// decorations provided here will only be split by other, partially
  /// overlapping \`outerDecorations\` ranges, and wrap around all
  /// regular decorations. Use this for mark elements that should, as
  /// much as possible, remain in one piece.
  static outerDecorations = outerDecorations;

  /**
   * 用于提供应被视为原子的范围, 涉及光标运动
   * 这会导致类似的方法 [`moveByChar`](#view.EditorView.moveByChar) 和 [`moveVertically`](#view.EditorView.moveVertically)（以及建立在它们之上的命令
   * 在以下情况下跳过这些区域, 选择端点将进入它们
   * 这并不会阻止直接程序化 (#state.TransactionSpec.selection) 不再进入此类地区
   */
  static atomicRanges = atomicRanges;

  /**
   * 当范围装饰添加 “unicode-bidi:isolate” 样式时，它们还应该包括一个 (#view.MarkDecorationSpec.bidiIsolate) 属性在他们的装饰规范中，并通过这个 Facet 暴露
   * 出来，所以编辑器可以计算正确的文本顺序（其他值对于 “unicode-bidi”，当然 “正常” 除外支持）
   */
  static bidiIsolatedRanges = bidiIsolatedRanges;

  /// Facet that allows extensions to provide additional scroll
  /// margins (space around the sides of the scrolling element that
  /// should be considered invisible). This can be useful when the
  /// plugin introduces elements that cover part of that element (for
  /// example a horizontally fixed gutter).
  static scrollMargins = scrollMargins;

  /// Create a theme extension. The first argument can be a
  /// [`style-mod`](https://github.com/marijnh/style-mod#documentation)
  /// style spec providing the styles for the theme. These will be
  /// prefixed with a generated class for the style.
  ///
  /// Because the selectors will be prefixed with a scope class, rule
  /// that directly match the editor's [wrapper
  /// element](#view.EditorView.dom)—to which the scope class will be
  /// added—need to be explicitly differentiated by adding an `&` to
  /// the selector for that element—for example
  /// `&.cm-focused`.
  ///
  /// When `dark` is set to true, the theme will be marked as dark,
  /// which will cause the `&dark` rules from [base
  /// themes](#view.EditorView^baseTheme) to be used (as opposed to
  /// `&light` when a light theme is active).
  static theme(spec: { [selector: string]: StyleSpec }, options?: { dark?: boolean }): Extension {
    const prefix = StyleModule.newName();
    const result = [theme.of(prefix), styleModule.of(buildTheme(`.${prefix}`, spec))];

    if (options && options.dark) {
      result.push(darkTheme.of(true));
    }

    return result;
  }

  /// This facet records whether a dark theme is active. The extension
  /// returned by [`theme`](#view.EditorView^theme) automatically
  /// includes an instance of this when the `dark` option is set to
  /// true.
  static darkTheme = darkTheme;

  /// Create an extension that adds styles to the base theme. Like
  /// with [`theme`](#view.EditorView^theme), use `&` to indicate the
  /// place of the editor wrapper element when directly targeting
  /// that. You can also use `&dark` or `&light` instead to only
  /// target editors with a dark or light theme.
  static baseTheme(spec: { [selector: string]: StyleSpec }): Extension {
    return Prec.lowest(styleModule.of(buildTheme("." + baseThemeID, spec, lightDarkIDs)));
  }

  /**
   * 提供创建时使用的内容安全策略随机数编辑器的样式表，当没有时保留空字符串，已提供随机数
   */
  static cspNonce = Facet.define<string, string>({
    combine: (values) => (values.length ? values[0] : ""),
  });

  /// Facet that provides additional DOM attributes for the editor's
  /// editable DOM element.
  static contentAttributes = contentAttributes;

  /// Facet that provides DOM attributes for the editor's outer
  /// element.
  static editorAttributes = editorAttributes;

  /**
   * 一个在编辑器中启用换行的扩展（通过在内容中将 CSS `white-space` 设置为 `pre-wrap`）。
   */
  static lineWrapping = EditorView.contentAttributes.of({ class: "cm-lineWrapping" });

  /// State effect used to include screen reader announcements in a
  /// transaction. These will be added to the DOM in a visually hidden
  /// element with `aria-live="polite"` set, and should be used to
  /// describe effects that are visually obvious but may not be
  /// noticed by screen reader users (such as moving to the next
  /// search match).
  static announce = StateEffect.define<string>();

  /// Retrieve an editor view instance from the view's DOM
  /// representation.
  static findFromDOM(dom: HTMLElement): EditorView | null {
    const content = dom.querySelector(".cm-content");
    const cView = (content && ContentView.get(content)) || ContentView.get(dom);
    return (cView?.rootView as DocView)?.view || null;
  }
}

/// Helper type that maps event names to event object types, or the
/// `any` type for unknown events.
export interface DOMEventMap extends HTMLElementEventMap {
  [other: string]: any;
}

/// Event handlers are specified with objects like this. For event
/// types known by TypeScript, this will infer the event argument type
/// to hold the appropriate event object type. For unknown events, it
/// is inferred to `any`, and should be explicitly set if you want type
/// checking.
export type DOMEventHandlers<This> = {
  [event in keyof DOMEventMap]?: (
    this: This,
    event: DOMEventMap[event],
    view: EditorView
  ) => boolean | void;
};

// Maximum line length for which we compute accurate bidi info
const MaxBidiLine = 4096;

const BadMeasure = {};

class CachedOrder {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly dir: Direction,
    readonly isolates: readonly Isolate[],
    readonly fresh: boolean,
    readonly order: readonly BidiSpan[]
  ) {}

  static update(cache: CachedOrder[], changes: ChangeDesc) {
    if (changes.empty && !cache.some((c) => c.fresh)) {
      return cache;
    }

    const result = [];
    const lastDir = cache.length ? cache[cache.length - 1].dir : Direction.LTR;

    for (let i = Math.max(0, cache.length - 10); i < cache.length; i++) {
      const entry = cache[i];

      if (entry.dir == lastDir && !changes.touchesRange(entry.from, entry.to)) {
        result.push(
          new CachedOrder(
            changes.mapPos(entry.from, 1),
            changes.mapPos(entry.to, -1),
            entry.dir,
            entry.isolates,
            false,
            entry.order
          )
        );
      }
    }

    return result;
  }
}

/** 从 Facet 中获取所有 dom 属性值 */
function attrsFromFacet(view: EditorView, facet: Facet<AttrSource>, base: Attrs) {
  for (let sources = view.state.facet(facet), i = sources.length - 1; i >= 0; i--) {
    const source = sources[i];
    const value = typeof source == "function" ? source(view) : source;

    if (value) {
      combineAttrs(value, base);
    }
  }
  return base;
}
