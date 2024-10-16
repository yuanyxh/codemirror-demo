import {
  Tree,
  SyntaxNode,
  ChangedRange,
  TreeFragment,
  NodeProp,
  NodeType,
  Input,
  PartialParse,
  Parser,
  IterMode,
} from "@lezer/common";
import type { LRParser, ParserConfig } from "@lezer/lr";
import {
  EditorState,
  StateField,
  Transaction,
  Extension,
  StateEffect,
  Facet,
  ChangeDesc,
  Text,
  TextIterator,
} from "@/state/index";
import { ViewPlugin, ViewUpdate, EditorView, logException } from "@/view/index";

/**
 * Node prop 存储在解析器的顶级语法节点中，以提供存储该语言的特定于语言的数据的方面
 */
export const languageDataProp = new NodeProp<Facet<{ [name: string]: any }>>();

/**
 * 用于定义 Facet 的辅助函数（将添加到顶部语法语言的节点通过 [`languageDataProp`](#language.languageDataProp))，这将是用于将语言数据与语言相关联
 * 你可能只在子类化时需要这个
 */
export function defineLanguageFacet(baseData?: { [name: string]: any }) {
  return Facet.define<{ [name: string]: any }>({
    combine: baseData ? (values) => values.concat(baseData!) : undefined,
  });
}

/// Some languages need to return different [language
/// data](#state.EditorState.languageDataAt) for some parts of their
/// tree. Sublanguages, registered by adding a [node
/// prop](#language.sublanguageProp) to the language's top syntax
/// node, provide a mechanism to do this.
///
/// (Note that when using nested parsing, where nested syntax is
/// parsed by a different parser and has its own top node type, you
/// don't need a sublanguage.)
export interface Sublanguage {
  /// Determines whether the data provided by this sublanguage should
  /// completely replace the regular data or be added to it (with
  /// higher-precedence). The default is `"extend"`.
  type?: "replace" | "extend";
  /// A predicate that returns whether the node at the queried
  /// position is part of the sublanguage.
  test: (node: SyntaxNode, state: EditorState) => boolean;
  /// The language data facet that holds the sublanguage's data.
  /// You'll want to use
  /// [`defineLanguageFacet`](#language.defineLanguageFacet) to create
  /// this.
  facet: Facet<{ [name: string]: any }>;
}

/// Syntax node prop used to register sublanguages. Should be added to
/// the top level node type for the language.
export const sublanguageProp = new NodeProp<Sublanguage[]>();

/**
 * 语言对象管理解析和每种语言 [元数据](#state.EditorState.languageDataAt)
 * 解析数据为作为 [Lezer](https://lezer.codemirror.net) 树进行管理
 * 班级可以通过 [`LRLanguage`](#language.LRLanguage) 直接使用 [Lezer](https://lezer.codemirror.net/) LR 解析器的子类，或通过 [`StreamLanguage`]
 * (#language.StreamLanguage) 子类对于流解析器
 */
export class Language {
  readonly extension: Extension;

  /**
   * 解析器对象, 将其用作 [嵌套解析器](https://lezer.codemirror.net/docs/ref#common.Parser)。
   */
  parser: Parser;

  /**
   * 构造一个语言对象
   * 如果你需要调用这个直接，首先定义一个数据 Facet (#language.defineLanguageFacet)，然后配置您的解析器以 [附加](#language.languageDataProp) 它
   * 到语言的外部语法节点
   */
  constructor(
    /**
     * (#state.EditorState.languageDataAt) Facet 用于该语言
     */
    readonly data: Facet<{ [name: string]: any }>,
    parser: Parser,
    extraExtensions: Extension[] = [],
    /** 语言名字 */
    readonly name: string = ""
  ) {
    /**
     * Kludge 将 EditorState.tree 定义为调试助手，EditorState 包实际上不知道语言和 lezer 树
     */
    if (!EditorState.prototype.hasOwnProperty("tree")) {
      Object.defineProperty(EditorState.prototype, "tree", {
        get() {
          return syntaxTree(this);
        },
      });
    }

    this.parser = parser;

    this.extension = [
      language.of(this),
      EditorState.languageData.of((state, pos, side) => {
        const top = topNodeAt(state, pos, side);
        const data = top.type.prop(languageDataProp);

        if (!data) {
          return [];
        }

        const base = state.facet(data);
        const sub = top.type.prop(sublanguageProp);

        if (sub) {
          const innerNode = top.resolve(pos - top.from, side);

          for (const sublang of sub) {
            if (sublang.test(innerNode, state)) {
              const data = state.facet(sublang.facet);

              return sublang.type == "replace" ? data : data.concat(base);
            }
          }
        }
        return base;
      }),
    ].concat(extraExtensions);
  }

  /** 查询该语言在给定位置是否处于活动状态 */
  isActiveAt(state: EditorState, pos: number, side: -1 | 0 | 1 = -1) {
    return topNodeAt(state, pos, side).type.prop(languageDataProp) == this.data;
  }

  /**
   * 查找使用该语言解析的文档区域，返回的区域将包括任何以嵌套语言为根的语言，当这些存在时，用这种语言
   */
  findRegions(state: EditorState) {
    const lang = state.facet(language);

    if (lang?.data == this.data) {
      return [{ from: 0, to: state.doc.length }];
    }

    if (!lang || !lang.allowsNesting) {
      return [];
    }

    const result: { from: number; to: number }[] = [];

    const explore = (tree: Tree, from: number) => {
      if (tree.prop(languageDataProp) == this.data) {
        result.push({ from, to: from + tree.length });
        return;
      }

      const mount = tree.prop(NodeProp.mounted);

      if (mount) {
        if (mount.tree.prop(languageDataProp) == this.data) {
          if (mount.overlay) {
            for (const r of mount.overlay) {
              result.push({ from: r.from + from, to: r.to + from });
            }
          } else {
            result.push({ from: from, to: from + tree.length });
          }

          return;
        } else if (mount.overlay) {
          const size = result.length;

          explore(mount.tree, mount.overlay[0].from + from);

          if (result.length > size) {
            return;
          }
        }
      }

      for (let i = 0; i < tree.children.length; i++) {
        const ch = tree.children[i];

        if (ch instanceof Tree) {
          explore(ch, tree.positions[i] + from);
        }
      }
    };

    explore(syntaxTree(state), 0);

    return result;
  }

  /**
   * 指示该语言是否允许嵌套语言, 默认实现返回 true
   */
  get allowsNesting() {
    return true;
  }

  static state: StateField<LanguageState>;

  static setState = StateEffect.define<LanguageState>();
}

function topNodeAt(state: EditorState, pos: number, side: -1 | 0 | 1) {
  const topLang = state.facet(language);
  let tree = syntaxTree(state).topNode;
  if (!topLang || topLang.allowsNesting) {
    for (
      let node: SyntaxNode | null = tree;
      node;
      node = node.enter(pos, side, IterMode.ExcludeBuffers)
    )
      if (node.type.isTop) tree = node;
  }
  return tree;
}

/// A subclass of [`Language`](#language.Language) for use with Lezer
/// [LR parsers](https://lezer.codemirror.net/docs/ref#lr.LRParser)
/// parsers.
export class LRLanguage extends Language {
  private constructor(
    data: Facet<{ [name: string]: any }>,
    readonly parser: LRParser,
    name?: string
  ) {
    super(data, parser, [], name);
  }

  /// Define a language from a parser.
  static define(spec: {
    /// The [name](#Language.name) of the language.
    name?: string;
    /// The parser to use. Should already have added editor-relevant
    /// node props (and optionally things like dialect and top rule)
    /// configured.
    parser: LRParser;
    /// [Language data](#state.EditorState.languageDataAt)
    /// to register for this language.
    languageData?: { [name: string]: any };
  }) {
    const data = defineLanguageFacet(spec.languageData);
    return new LRLanguage(
      data,
      spec.parser.configure({
        props: [languageDataProp.add((type) => (type.isTop ? data : undefined))],
      }),
      spec.name
    );
  }

  /// Create a new instance of this language with a reconfigured
  /// version of its parser and optionally a new name.
  configure(options: ParserConfig, name?: string): LRLanguage {
    return new LRLanguage(this.data, this.parser.configure(options), name || this.name);
  }

  get allowsNesting() {
    return this.parser.hasWrappers();
  }
}

/// Get the syntax tree for a state, which is the current (possibly
/// incomplete) parse tree of the active
/// [language](#language.Language), or the empty tree if there is no
/// language available.
export function syntaxTree(state: EditorState): Tree {
  const field = state.field(Language.state, false);
  return field ? field.tree : Tree.empty;
}

/// Try to get a parse tree that spans at least up to `upto`. The
/// method will do at most `timeout` milliseconds of work to parse
/// up to that point if the tree isn't already available.
export function ensureSyntaxTree(state: EditorState, upto: number, timeout = 50): Tree | null {
  const parse = state.field(Language.state, false)?.context;
  if (!parse) return null;
  const oldVieport = parse.viewport;
  parse.updateViewport({ from: 0, to: upto });
  const result = parse.isDone(upto) || parse.work(timeout, upto) ? parse.tree : null;
  parse.updateViewport(oldVieport);
  return result;
}

/// Queries whether there is a full syntax tree available up to the
/// given document position. If there isn't, the background parse
/// process _might_ still be working and update the tree further, but
/// there is no guarantee of that—the parser will [stop
/// working](#language.syntaxParserRunning) when it has spent a
/// certain amount of time or has moved beyond the visible viewport.
/// Always returns false if no language has been enabled.
export function syntaxTreeAvailable(state: EditorState, upto = state.doc.length) {
  return state.field(Language.state, false)?.context.isDone(upto) || false;
}

/// Move parsing forward, and update the editor state afterwards to
/// reflect the new tree. Will work for at most `timeout`
/// milliseconds. Returns true if the parser managed get to the given
/// position in that time.
export function forceParsing(view: EditorView, upto = view.viewport.to, timeout = 100): boolean {
  const success = ensureSyntaxTree(view.state, upto, timeout);
  if (success != syntaxTree(view.state)) view.dispatch({});
  return !!success;
}

/// Tells you whether the language parser is planning to do more
/// parsing work (in a `requestIdleCallback` pseudo-thread) or has
/// stopped running, either because it parsed the entire document,
/// because it spent too much time and was cut off, or because there
/// is no language parser enabled.
export function syntaxParserRunning(view: EditorView) {
  return view.plugin(parseWorker)?.isWorking() || false;
}

/// Lezer-style
/// [`Input`](https://lezer.codemirror.net/docs/ref#common.Input)
/// object for a [`Text`](#state.Text) object.
export class DocInput implements Input {
  private cursor: TextIterator;
  private cursorPos = 0;
  private string = "";

  /// Create an input object for the given document.
  constructor(readonly doc: Text) {
    this.cursor = doc.iter();
  }

  get length() {
    return this.doc.length;
  }

  private syncTo(pos: number) {
    this.string = this.cursor.next(pos - this.cursorPos).value;
    this.cursorPos = pos + this.string.length;
    return this.cursorPos - this.string.length;
  }

  chunk(pos: number) {
    this.syncTo(pos);
    return this.string;
  }

  get lineChunks() {
    return true;
  }

  read(from: number, to: number) {
    const stringStart = this.cursorPos - this.string.length;
    if (from < stringStart || to >= this.cursorPos) return this.doc.sliceString(from, to);
    else return this.string.slice(from - stringStart, to - stringStart);
  }
}

const enum Work {
  // Milliseconds of work time to perform immediately for a state doc change
  Apply = 20,
  // Minimum amount of work time to perform in an idle callback
  MinSlice = 25,
  // Amount of work time to perform in pseudo-thread when idle callbacks aren't supported
  Slice = 100,
  // Minimum pause between pseudo-thread slices
  MinPause = 100,
  // Maximum pause (timeout) for the pseudo-thread
  MaxPause = 500,
  // Parse time budgets are assigned per chunk—the parser can run for
  // ChunkBudget milliseconds at most during ChunkTime milliseconds.
  // After that, no further background parsing is scheduled until the
  // next chunk in which the editor is active.
  ChunkBudget = 3000,
  ChunkTime = 30000,
  // For every change the editor receives while focused, it gets a
  // small bonus to its parsing budget (as a way to allow active
  // editors to continue doing work).
  ChangeBonus = 50,
  // Don't eagerly parse this far beyond the end of the viewport
  MaxParseAhead = 1e5,
  // When initializing the state field (before viewport info is
  // available), pretend the viewport goes from 0 to here.
  InitViewport = 3000,
}

let currentContext: ParseContext | null = null;

/// A parse context provided to parsers working on the editor content.
export class ParseContext {
  private parse: PartialParse | null = null;
  /// @internal
  tempSkipped: { from: number; to: number }[] = [];

  private constructor(
    private parser: Parser,
    /// The current editor state.
    readonly state: EditorState,
    /// Tree fragments that can be reused by incremental re-parses.
    public fragments: readonly TreeFragment[] = [],
    /// @internal
    public tree: Tree,
    /// @internal
    public treeLen: number,
    /// The current editor viewport (or some overapproximation
    /// thereof). Intended to be used for opportunistically avoiding
    /// work (in which case
    /// [`skipUntilInView`](#language.ParseContext.skipUntilInView)
    /// should be called to make sure the parser is restarted when the
    /// skipped region becomes visible).
    public viewport: { from: number; to: number },
    /// @internal
    public skipped: { from: number; to: number }[],
    /// This is where skipping parsers can register a promise that,
    /// when resolved, will schedule a new parse. It is cleared when
    /// the parse worker picks up the promise. @internal
    public scheduleOn: Promise<unknown> | null
  ) {}

  /// @internal
  static create(parser: Parser, state: EditorState, viewport: { from: number; to: number }) {
    return new ParseContext(parser, state, [], Tree.empty, 0, viewport, [], null);
  }

  private startParse() {
    return this.parser.startParse(new DocInput(this.state.doc), this.fragments);
  }

  /// @internal
  work(until: number | (() => boolean), upto?: number) {
    if (upto != null && upto >= this.state.doc.length) upto = undefined;
    if (this.tree != Tree.empty && this.isDone(upto ?? this.state.doc.length)) {
      this.takeTree();
      return true;
    }
    return this.withContext(() => {
      if (typeof until == "number") {
        const endTime = Date.now() + until;
        until = () => Date.now() > endTime;
      }
      if (!this.parse) this.parse = this.startParse();
      if (
        upto != null &&
        (this.parse.stoppedAt == null || this.parse.stoppedAt > upto) &&
        upto < this.state.doc.length
      )
        this.parse.stopAt(upto);
      for (;;) {
        const done = this.parse.advance();
        if (done) {
          this.fragments = this.withoutTempSkipped(
            TreeFragment.addTree(done, this.fragments, this.parse.stoppedAt != null)
          );
          this.treeLen = this.parse.stoppedAt ?? this.state.doc.length;
          this.tree = done;
          this.parse = null;
          if (this.treeLen < (upto ?? this.state.doc.length)) this.parse = this.startParse();
          else return true;
        }
        if (until()) return false;
      }
    });
  }

  /// @internal
  takeTree() {
    let pos, tree: Tree | undefined | null;
    if (this.parse && (pos = this.parse.parsedPos) >= this.treeLen) {
      if (this.parse.stoppedAt == null || this.parse.stoppedAt > pos) this.parse.stopAt(pos);
      this.withContext(() => {
        while (!(tree = this.parse!.advance())) {
          /** empty */
        }
      });
      this.treeLen = pos;
      this.tree = tree!;
      this.fragments = this.withoutTempSkipped(
        TreeFragment.addTree(this.tree, this.fragments, true)
      );
      this.parse = null;
    }
  }

  private withContext<T>(f: () => T): T {
    const prev = currentContext;
    currentContext = this;
    try {
      return f();
    } finally {
      currentContext = prev;
    }
  }

  private withoutTempSkipped(fragments: readonly TreeFragment[]) {
    for (let r; (r = this.tempSkipped.pop()); ) fragments = cutFragments(fragments, r.from, r.to);
    return fragments;
  }

  /// @internal
  changes(changes: ChangeDesc, newState: EditorState) {
    let { fragments, tree, treeLen, viewport, skipped } = this;
    this.takeTree();
    if (!changes.empty) {
      const ranges: ChangedRange[] = [];
      changes.iterChangedRanges((fromA, toA, fromB, toB) =>
        ranges.push({ fromA, toA, fromB, toB })
      );
      fragments = TreeFragment.applyChanges(fragments, ranges);
      tree = Tree.empty;
      treeLen = 0;
      viewport = { from: changes.mapPos(viewport.from, -1), to: changes.mapPos(viewport.to, 1) };
      if (this.skipped.length) {
        skipped = [];
        for (const r of this.skipped) {
          const from = changes.mapPos(r.from, 1),
            to = changes.mapPos(r.to, -1);
          if (from < to) skipped.push({ from, to });
        }
      }
    }
    return new ParseContext(
      this.parser,
      newState,
      fragments,
      tree,
      treeLen,
      viewport,
      skipped,
      this.scheduleOn
    );
  }

  /// @internal
  updateViewport(viewport: { from: number; to: number }) {
    if (this.viewport.from == viewport.from && this.viewport.to == viewport.to) return false;
    this.viewport = viewport;
    const startLen = this.skipped.length;
    for (let i = 0; i < this.skipped.length; i++) {
      const { from, to } = this.skipped[i];
      if (from < viewport.to && to > viewport.from) {
        this.fragments = cutFragments(this.fragments, from, to);
        this.skipped.splice(i--, 1);
      }
    }
    if (this.skipped.length >= startLen) return false;
    this.reset();
    return true;
  }

  /// @internal
  reset() {
    if (this.parse) {
      this.takeTree();
      this.parse = null;
    }
  }

  /// Notify the parse scheduler that the given region was skipped
  /// because it wasn't in view, and the parse should be restarted
  /// when it comes into view.
  skipUntilInView(from: number, to: number) {
    this.skipped.push({ from, to });
  }

  /// Returns a parser intended to be used as placeholder when
  /// asynchronously loading a nested parser. It'll skip its input and
  /// mark it as not-really-parsed, so that the next update will parse
  /// it again.
  ///
  /// When `until` is given, a reparse will be scheduled when that
  /// promise resolves.
  static getSkippingParser(until?: Promise<unknown>): Parser {
    return new (class extends Parser {
      createParse(
        _input: Input,
        _fragments: readonly TreeFragment[],
        ranges: readonly { from: number; to: number }[]
      ): PartialParse {
        const from = ranges[0].from,
          to = ranges[ranges.length - 1].to;
        const parser = {
          parsedPos: from,
          advance() {
            const cx = currentContext;
            if (cx) {
              for (const r of ranges) cx.tempSkipped.push(r);
              if (until)
                cx.scheduleOn = cx.scheduleOn ? Promise.all([cx.scheduleOn, until]) : until;
            }
            this.parsedPos = to;
            return new Tree(NodeType.none, [], [], to - from);
          },
          stoppedAt: null,
          stopAt() {},
        };
        return parser;
      }
    })();
  }

  /// @internal
  isDone(upto: number) {
    upto = Math.min(upto, this.state.doc.length);
    const frags = this.fragments;
    return this.treeLen >= upto && frags.length && frags[0].from == 0 && frags[0].to >= upto;
  }

  /// Get the context for the current parse, or `null` if no editor
  /// parse is in progress.
  static get() {
    return currentContext;
  }
}

function cutFragments(fragments: readonly TreeFragment[], from: number, to: number) {
  return TreeFragment.applyChanges(fragments, [{ fromA: from, toA: to, fromB: from, toB: to }]);
}

class LanguageState {
  // The current tree. Immutable, because directly accessible from
  // the editor state.
  readonly tree: Tree;

  constructor(
    // A mutable parse state that is used to preserve work done during
    // the lifetime of a state when moving to the next state.
    readonly context: ParseContext
  ) {
    this.tree = context.tree;
  }

  apply(tr: Transaction) {
    if (!tr.docChanged && this.tree == this.context.tree) return this;
    const newCx = this.context.changes(tr.changes, tr.state);
    // If the previous parse wasn't done, go forward only up to its
    // end position or the end of the viewport, to avoid slowing down
    // state updates with parse work beyond the viewport.
    const upto =
      this.context.treeLen == tr.startState.doc.length
        ? undefined
        : Math.max(tr.changes.mapPos(this.context.treeLen), newCx.viewport.to);
    if (!newCx.work(Work.Apply, upto)) newCx.takeTree();
    return new LanguageState(newCx);
  }

  static init(state: EditorState) {
    const vpTo = Math.min(Work.InitViewport, state.doc.length);
    const parseState = ParseContext.create(state.facet(language)!.parser, state, {
      from: 0,
      to: vpTo,
    });
    if (!parseState.work(Work.Apply, vpTo)) parseState.takeTree();
    return new LanguageState(parseState);
  }
}

Language.state = StateField.define<LanguageState>({
  create: LanguageState.init,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(Language.setState)) return e.value;
    if (tr.startState.facet(language) != tr.state.facet(language))
      return LanguageState.init(tr.state);
    return value.apply(tr);
  },
});

let requestIdle = (callback: (deadline?: IdleDeadline) => void) => {
  const timeout = setTimeout(() => callback(), Work.MaxPause);
  return () => clearTimeout(timeout);
};

if (typeof requestIdleCallback != "undefined")
  requestIdle = (callback: (deadline?: IdleDeadline) => void) => {
    let idle = -1;
    const timeout = window.setTimeout(() => {
      idle = requestIdleCallback(callback, { timeout: Work.MaxPause - Work.MinPause });
    }, Work.MinPause);
    return () => (idle < 0 ? clearTimeout(timeout) : cancelIdleCallback(idle));
  };

const isInputPending =
  typeof navigator != "undefined" && (navigator as any).scheduling?.isInputPending
    ? () => (navigator as any).scheduling.isInputPending()
    : null;

const parseWorker = ViewPlugin.fromClass(
  class ParseWorker {
    working: (() => void) | null = null;
    workScheduled = 0;
    // End of the current time chunk
    chunkEnd = -1;
    // Milliseconds of budget left for this chunk
    chunkBudget = -1;

    constructor(readonly view: EditorView) {
      this.work = this.work.bind(this);
      this.scheduleWork();
    }

    update(update: ViewUpdate) {
      const cx = this.view.state.field(Language.state).context;
      if (cx.updateViewport(update.view.viewport) || this.view.viewport.to > cx.treeLen)
        this.scheduleWork();
      if (update.docChanged || update.selectionSet) {
        if (this.view.hasFocus) this.chunkBudget += Work.ChangeBonus;
        this.scheduleWork();
      }
      this.checkAsyncSchedule(cx);
    }

    scheduleWork() {
      if (this.working) return;
      const { state } = this.view,
        field = state.field(Language.state);
      if (field.tree != field.context.tree || !field.context.isDone(state.doc.length))
        this.working = requestIdle(this.work);
    }

    work(deadline?: IdleDeadline) {
      this.working = null;

      const now = Date.now();
      if (this.chunkEnd < now && (this.chunkEnd < 0 || this.view.hasFocus)) {
        // Start a new chunk
        this.chunkEnd = now + Work.ChunkTime;
        this.chunkBudget = Work.ChunkBudget;
      }
      if (this.chunkBudget <= 0) return; // No more budget

      const {
          state,
          viewport: { to: vpTo },
        } = this.view,
        field = state.field(Language.state);
      if (field.tree == field.context.tree && field.context.isDone(vpTo + Work.MaxParseAhead))
        return;
      const endTime =
        Date.now() +
        Math.min(
          this.chunkBudget,
          Work.Slice,
          deadline && !isInputPending ? Math.max(Work.MinSlice, deadline.timeRemaining() - 5) : 1e9
        );
      const viewportFirst = field.context.treeLen < vpTo && state.doc.length > vpTo + 1000;
      const done = field.context.work(() => {
        return (isInputPending && isInputPending()) || Date.now() > endTime;
      }, vpTo + (viewportFirst ? 0 : Work.MaxParseAhead));
      this.chunkBudget -= Date.now() - now;
      if (done || this.chunkBudget <= 0) {
        field.context.takeTree();
        this.view.dispatch({ effects: Language.setState.of(new LanguageState(field.context)) });
      }
      if (this.chunkBudget > 0 && !(done && !viewportFirst)) this.scheduleWork();
      this.checkAsyncSchedule(field.context);
    }

    checkAsyncSchedule(cx: ParseContext) {
      if (cx.scheduleOn) {
        this.workScheduled++;
        cx.scheduleOn
          .then(() => this.scheduleWork())
          .catch((err) => logException(this.view.state, err))
          .then(() => this.workScheduled--);
        cx.scheduleOn = null;
      }
    }

    destroy() {
      if (this.working) this.working();
    }

    isWorking() {
      return !!(this.working || this.workScheduled > 0);
    }
  },
  {
    eventHandlers: {
      focus() {
        this.scheduleWork();
      },
    },
  }
);

/**
 * 用于将语言与编辑器状态关联起来的方面
 * 通过 `Language` 对象的 `extension` 属性（所以你不需要手动将您的语言包含在其中）可用于访问状态的当前语言
 */
export const language = Facet.define<Language, Language | null>({
  combine(languages) {
    return languages.length ? languages[0] : null;
  },
  enables: (language) => [
    Language.state,
    parseWorker,
    EditorView.contentAttributes.compute([language], (state) => {
      const lang = state.facet(language);
      return lang && lang.name ? { "data-language": lang.name } : ({} as {});
    }),
  ],
});

/**
 * 此类将 [语言](#language.Language) 与可选的支持扩展集
 * 语言包有鼓励导出一个可选的函数配置对象并返回一个 `LanguageSupport` 实例，如下客户端代码使用包的主要方式
 */
export class LanguageSupport {
  /// An extension including both the language and its support
  /// extensions. (Allowing the object to be used as an extension
  /// value itself.)
  extension: Extension;

  constructor(
    readonly language: Language,
    /**
     * 一组可选的支持扩展
     * 当嵌套一个语言为另一种语言，鼓励使用外语包括其内部语言的支持扩展在它自己的一组支持扩展中
     */
    readonly support: Extension = []
  ) {
    this.extension = [language, support];
  }
}

/**
 * 语言描述用于存储有关语言的元数据并动态加载它们
 * 他们的主要作用是寻找文件名的适当语言或动态加载嵌套解析器
 */
export class LanguageDescription {
  private loading: Promise<LanguageSupport> | null = null;

  private constructor(
    /// 语言名称
    readonly name: string,
    /**
     * 模式的替代名称（小写，包括 `this.name`）
     */
    readonly alias: readonly string[],
    /**
     * 与该语言关联的文件扩展名
     */
    readonly extensions: readonly string[],
    /**
     * 应该与此关联的可选文件名模式语言
     */
    readonly filename: RegExp | undefined,
    private loadFunc: () => Promise<LanguageSupport>,
    /**
     * 如果该语言已加载，这将保持其值
     */
    public support: LanguageSupport | undefined = undefined
  ) {}

  /// Start loading the the language. Will return a promise that
  /// resolves to a [`LanguageSupport`](#language.LanguageSupport)
  /// object when the language successfully loads.
  load(): Promise<LanguageSupport> {
    return (
      this.loading ||
      (this.loading = this.loadFunc().then(
        (support) => (this.support = support),
        (err) => {
          this.loading = null;
          throw err;
        }
      ))
    );
  }

  /**
   * 创建语言描述
   */
  static of(spec: {
    name: string;
    alias?: readonly string[];
    extensions?: readonly string[];
    filename?: RegExp;
    load?: () => Promise<LanguageSupport>;
    support?: LanguageSupport;
  }) {
    let load = spec.load;

    const support = spec.support;

    if (!load) {
      if (!support) {
        throw new RangeError("Must pass either 'load' or 'support' to LanguageDescription.of");
      }

      load = () => Promise.resolve(support!);
    }

    return new LanguageDescription(
      spec.name,
      (spec.alias || []).concat(spec.name).map((s) => s.toLowerCase()),
      spec.extensions || [],
      spec.filename,
      load,
      support
    );
  }

  /**
   * 在给定的描述数组中查找一种语言匹配文件名
   * 将首场比赛 [`filename`](#language.LanguageDescription.filename) 模式，然后 [扩展](#language.LanguageDescription.extensions), 并返回第一个匹配的语言。
   */
  static matchFilename(descs: readonly LanguageDescription[], filename: string) {
    for (const d of descs) {
      if (d.filename && d.filename.test(filename)) {
        return d;
      }
    }

    const ext = /\.([^.]+)$/.exec(filename);

    if (ext) {
      for (const d of descs) {
        if (d.extensions.indexOf(ext[1]) > -1) {
          return d;
        }
      }
    }

    return null;
  }

  /**
   * 查找名称或别名与给定匹配的语言名称（不区分大小写）
   * 如果 `fuzzy` 为 true，并且没有直接找到匹配项，这也会搜索其名称的语言或别名出现在字符串中（对于短于三个的名称字符，仅当被非单词字符包围时）
   */
  static matchLanguageName(descs: readonly LanguageDescription[], name: string, fuzzy = true) {
    name = name.toLowerCase();

    for (const d of descs) {
      if (d.alias.some((a) => a == name)) {
        return d;
      }
    }

    if (fuzzy) {
      for (const d of descs) {
        for (const a of d.alias) {
          const found = name.indexOf(a);

          if (
            found > -1 &&
            (a.length > 2 || (!/\w/.test(name[found - 1]) && !/\w/.test(name[found + a.length])))
          ) {
            return d;
          }
        }
      }
    }

    return null;
  }
}
