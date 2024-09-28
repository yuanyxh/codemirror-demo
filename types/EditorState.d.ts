/** EditorState 配置项 */
declare interface EditorStateConfig {
  /**
   * 默认为空文档，可以传递纯字符串(根据 lineSeparator(换行符) 拆分为行) 或 Text 实例（EditorState 通过它表示文档）
   */
  doc?: string | Text;

  /**
   * 选区, 默认光标位于文档的开头
   */
  selection?: EditorSelection | { anchor: number; head?: number };

  /**
   * 和 EditorState 绑定的扩展
   */
  extensions?: Extension;
}

/**
 * EditorState 是不可变的数据结构，更新状态始终通过事务进行，事务会生成一个新的状态实例，而不修改原 EditorState
 * 永远不要直接改变状态的属性
 * */
declare class EditorState {
  /** 文档 */
  doc: Text;

  /** 选区 */
  selection: EditorSelection;

  /**
   * 检索 EditorState 中某个字段的值，没有该字段时抛出错误，除非传递 false 作为第二个参数
   */
  field<T>(field: StateField<T>): T;
  field<T>(field: StateField<T>, require: false): T | undefined;

  /**
   * 更新 EditorState，可以传递多个事务规范来描述更改，返回一个事务
   */
  update(...specs: readonly TransactionSpec[]): Transaction;

  /**
   * 替换选区内容，返回一个事务规范
   */
  replaceSelection(text: string | Text): TransactionSpec;

  /**
   * 对每个 range 运行指定函数，返回值可提供给 update 方法用于更新
   */
  changeByRange(
    f: (range: SelectionRange) => {
      range: SelectionRange;
      changes?: ChangeSpec;
      effects?: StateEffect<any> | readonly StateEffect<any>[];
    }
  ): {
    changes: ChangeSet;
    selection: EditorSelection;
    effects: readonly StateEffect<any>[];
  };

  /**
   * 通过指定的变更描述创建变更集，同时考虑文档长度和换行符
   *
   * changeSpec 默认 []
   */
  changes(spec?: ChangeSpec): ChangeSet;

  /**
   * 将字符串转换至 Text 实例，会考虑换行符
   */
  toText(string: string): Text;

  /**
   * 获取指定范围内的文档
   *
   * from 默认 0, to 默认文档长度
   */
  sliceDoc(from?: number, to?: number): string;

  /**
   * 获取 Facet 实例值
   */
  facet<Output>(facet: FacetReader<Output>): Output;

  /**
   * 将 EditorState 转换为 JSON 对象
   */
  toJSON(fields?: Record<string, StateField<any>>): any;

  /**
   * tab 所占列, 由 tabSize Facet 决定
   */
  tabSize: number;

  /**
   * 正确换行符
   */
  lineBreak: string;

  /**
   * Editor 是否只读
   */
  readOnly: boolean;

  phrase(phrase: string, ...insert: any[]): string;

  /**
   * 获取指定位置处的特定于语言(如 Java) 的附加数据
   *
   * side 默认 -1
   */
  languageDataAt<T>(name: string, pos: number, side?: -1 | 0 | 1): readonly T[];

  /**
   * 返回一个函数，该函数可以将字符串（预期表示单个字素簇）分类
   */
  charCategorizer(at: number): (char: string) => CharCategory;

  /**
   * 查找给定位置处的单词，包含其周围所有 word char 的 Range，如果没有 word char 与该位置相邻，则返回 null。
   */
  wordAt(pos: number): SelectionRange | null;

  /**
   * JSON 转换为 EditorState
   *
   * config 默认 {}
   */
  static fromJSON(
    json: any,
    config?: EditorStateConfig,
    fields?: Record<string, StateField<any>>
  ): EditorState;

  /**
   * 创建 EditorState
   *
   * config 默认 {}
   */
  static create(config?: EditorStateConfig): EditorState;

  /**
   * 是否允许多个选区
   */
  static allowMultipleSelections: Facet<boolean, boolean>;

  static tabSize: Facet<number, number>;

  static lineSeparator: Facet<string, string | undefined>;

  static readOnly: Facet<boolean, boolean>;

  static phrases: Facet<Record<string, string>>;

  static languageData: Facet<
    (state: EditorState, pos: number, side: -1 | 0 | 1) => readonly Record<string, any>[]
  >;

  /**
   * 注册变更操作的过滤器，过滤掉不需要的更新操作
   */
  static changeFilter: Facet<(tr: Transaction) => boolean | readonly number[]>;

  /**
   * 在更新文档前，通过 transactionFilter 有机会修改或替换事务规范
   */
  static transactionFilter: Facet<
    (tr: Transaction) => TransactionSpec | readonly TransactionSpec[]
  >;

  /**
   * transactionFilter 的有限操作，只能添加部分内容
   */
  static transactionExtender: Facet<
    (tr: Transaction) => Pick<TransactionSpec, "effects" | "annotations"> | null
  >;
}

/** 选区范围 */
declare class SelectionRange {
  /** 起始范围 */
  from: number;

  /** 结束范围 */
  to: number;

  /** 范围锚点，扩展范围时不会移动的那一侧 */
  anchor: number;

  /** 范围头部，扩展范围时会移动的那一侧 */
  head: number;

  /** anchor === head 时为 true，即没有选择任何内容 */
  empty: boolean;

  /**
   * -1 表示 ? 位置之前的字符，1 表示 ? 位置之后的字符，0 表示不关联。
   */
  assoc: -1 | 0 | 1;

  bidiLevel: number | null;

  /**
   * 列?
   */
  goalColumn: number | undefined;

  /**
   * 生成有效范围
   *
   * assoc 默认 -1
   * */
  map(change: ChangeDesc, assoc?: number): SelectionRange;

  /**
   * 继承范围
   *
   * to 默认为 from
   */
  extend(from: number, to?: number): SelectionRange;

  /**
   * 比较两个范围
   *
   * includeAssoc 默认为 false
   */
  eq(other: SelectionRange, includeAssoc?: boolean): boolean;

  toJSON(): any;

  static fromJSON(json: any): SelectionRange;
}

/** Editor 的选区, 可能有一个或多个 */
declare class EditorSelection {
  /**
   * 选区,，按位置排序，不能重叠可以相邻
   */
  ranges: readonly SelectionRange[];

  /**
   * 选区中主要范围的索引（通常是最后添加的范围）
   */
  mainIndex: number;

  /**
   * 生成有效范围
   *
   * assoc 默认 -1
   * */
  map(change: ChangeDesc, assoc?: number): EditorSelection;

  /**
   * 比较两个范围
   *
   * includeAssoc 默认为 false
   */
  eq(other: EditorSelection, includeAssoc?: boolean): boolean;

  /**
   * 获取主要选择范围
   * 通常应该通过使用诸如 changeByRange 之类的方法来确保代码适用于所有范围
   */
  main: SelectionRange;

  /**
   * 确保选择只有一个范围，返回仅包含当前 EditorSelection 的主范围的 SelectionRange
   */
  asSingle(): EditorSelection;

  /**
   * 添加范围
   *
   * main 默认为 true
   */
  addRange(range: SelectionRange, main?: boolean): EditorSelection;

  /**
   * 替换选区
   *
   * which 默认为 this.mainIndex
   */
  replaceRange(range: SelectionRange, which?: number): EditorSelection;

  toJSON(): any;

  static fromJSON(json: any): EditorSelection;

  /**
   * 创建包含一个 SelectionRange 的 EditorSelection
   *
   * head 默认为 anchor
   */
  static single(anchor: number, head?: number): EditorSelection;

  /**
   * 创建 EditorSelection
   *
   * mainIndex 默认为 0
   */
  static create(ranges: readonly SelectionRange[], mainIndex?: number): EditorSelection;

  /**
   * 在指定位置创建光标
   *
   * assoc 默认为 0
   * */
  static cursor(
    pos: number,
    assoc?: number,
    bidiLevel?: number,
    goalColumn?: number
  ): SelectionRange;

  /** 创建范围 */
  static range(
    anchor: number,
    head: number,
    goalColumn?: number,
    bidiLevel?: number
  ): SelectionRange;
}

/** 字符分类枚举 */
declare enum CharCategory {
  Word = "Word",

  Space = "Space",

  Other = "Other",
}

/**
 * 不可变的树形结构存储文档内容
 *
 * 通过代码单元偏移量和行号进行高效索引
 * 结构共享不可变更新
 * 访问和迭代文档的局部内容，无需复制或操作所有字符
 *
 * 行号从 1 开始，字符位置从 0 开始，并将每个换行符和 UTF-16 代码单元算作一个单元
 */
declare class Text {
  /** 字符串长度 */
  length: number;

  /** 字符串行数，始终大于等于 1 */
  lines: number;

  /** 获取指定字符串位置的 Line 实例 */
  lineAt(pos: number): Line;

  /** 获取指定行号的 Line 实例 */
  line(n: number): Line;

  /** 替换指定范围的文本 */
  replace(from: number, to: number, text: Text): Text;

  /** 从尾部添加内容 */
  append(other: Text): Text;

  /**
   * 获取指定范围的文本内容
   *
   * to 默认为 this.length
   */
  slice(from: number, to?: number): Text;

  /** 获取指定范围的字符串 */
  sliceString(from: number, to?: number, lineSep?: string): string;

  /** 比较文本是否相同 */
  eq(other: Text): boolean;

  /**
   * 迭代文本, 当 dir 为 -1 时，从结束到开始迭代, 将行及其之间的分隔符作为单独的字符串返回。
   *
   * dir 默认为 1
   */
  iter(dir?: 1 | -1): TextIterator;

  /**
   * 迭代指定范围的文本
   *
   * to 默认为 this.length
   * */
  iterRange(from: number, to?: number): TextIterator;

  /** 迭代行，不返回行之间的换行符，并为空行生成空字符串 */
  iterLines(from?: number, to?: number): TextIterator;

  toString(): string;

  toJSON(): string[];

  children: readonly Text[] | null;

  [Symbol.iterator](): Iterator<string>;

  static of(text: readonly string[]): Text;

  static empty: Text;
}

/** 描述文档中的一行，在查询行时按需创建 */
declare class Line {
  /** 行的起始位置 */
  from: number;

  /** 行的结束位置, 换行符之前或文档最后 */
  to: number;

  /** 行号 */
  number: number;

  /** 内容 */
  text: string;

  /** 内容的长度，不包含换行符 */
  length: number;
}

/** Text 迭代器 */
declare interface TextIterator extends Iterator<string>, Iterable<string> {
  next(skip?: number): TextIterator;

  /** 当前值 */
  value: string;

  /** 已迭代完成 */
  done: boolean;

  /** 当前字符串是否是换行符 */
  lineBreak: boolean;
}

/**
 * 计算给定字符串位置处的列位置，同时考虑扩展字符和制表符大小
 *
 * to 默认为 string.length
 */
declare type countColumn = (string: string, tabSize: number, to?: number) => number;

/**
 * 查找与字符串中给定列位置相对应的偏移量，考虑扩展字符和制表符大小。
 * 默认情况下，当字符串太短时将返回字符串长度，在这种情况下传递 strict true 使其返回 -1
 */
declare type findColumn = (
  string: string,
  col: number,
  tabSize: number,
  strict?: boolean
) => number;

/**
 * 获取给定位置的码点
 */
declare type codePointAt = (str: string, pos: number) => number;

/** 码点转换为字符串 */
declare type fromCodePoint = (code: number) => string;

/** 计算一个字符在 js 中的长度 */
declare type codePointSize = (code: number) => 1 | 2;

/**
 * 如果 forward 为true，则返回在（不等于）pos 之后的下一个字素簇中断，否则返回之前。
 * 如果字符串中没有其他可用的簇中断，则返回 pos 本身
 * 跨代理项对移动、扩展字符（当 includeExtending 为 true 时）、使用零宽度连接符连接的字符以及标记表情符号
 *
 * forward 默认为 true
 * includeExtending 默认为 true
 */
declare type findClusterBreak = (
  str: string,
  pos: number,
  forward?: boolean,
  includeExtending?: boolean
) => number;

/** 事务描述 */
declare interface TransactionSpec {
  /** 对文档的更改描述 */
  changes?: ChangeSpec;

  /**
   * 设置后，此事务显式更新 EditorSelection
   */
  selection?: EditorSelection | { anchor: number; head?: number } | undefined;

  /**
   * 将状态副作用附加到事务?
   */
  effects?: StateEffect<any> | readonly StateEffect<any>[];

  /** 为事务设置注释? */
  annotations?: Annotation<any> | readonly Annotation<any>[];

  /** 注释的简写? */
  userEvent?: string;

  /** 需要滚动到当前选择 */
  scrollIntoView?: boolean;

  /** 默认事务会经过过滤器，设置 false 禁用  */
  filter?: boolean;
  /* ? */
  sequential?: boolean;
}

/**
 * EditorState.changes 的参数
 * 用于 TransactionSpec.changes，以简洁地描述文档更改
 */
declare type ChangeSpec =
  | { from: number; to?: number; insert?: string | Text }
  | ChangeSet
  | readonly ChangeSpec[];

/**
 * 对 EditorState 的更改被分组为事务
 * 用户操作创建单个事务，事务可能包含任意数量的文档更改、可能更改选择或具有其他效果
 * 通过调用 EditorState.update 创建事务，或通过调用 EditorView.dispatch 立即分派事务。
 */
declare class Transaction {
  /** 事务开始时的状态 */
  startState: EditorState;

  /** 文档变更描述 */
  changes: ChangeSet;

  /**
   * 此事务设置的选择，如果未显式设置选择，则为未定义
   */
  selection: EditorSelection | undefined;

  /**
   * 附加数据?
   */
  effects: readonly StateEffect<any>[];

  /** 分发事务后是否滚动到选择 */
  scrollIntoView: boolean;

  /** 变更操作的新文档 */
  newDoc: Text;

  /** 新选区 */
  newSelection: EditorSelection;

  /** 新状态 */
  state: EditorState;

  /** 获取给定注释类型的值（如果有） */
  annotation<T>(type: AnnotationType<T>): T | undefined;

  /** 指示事务是否更改了文档 */
  docChanged: boolean;

  /**
   * 指示此事务是否重新配置状态
   */
  reconfigured: boolean;

  /** 是用户事件? */
  isUserEvent(event: string): boolean;

  /**
   * 存储事务时间戳的注释，
   * 自动添加到每个事务
   */
  static time: AnnotationType<number>;

  /**
   * 用户事件集
   *
   * "input" 输入时
   * "input.type" 输入时
   * "input.type.compose" 组合输入时
   * "input.paste" 粘贴或拖拽输入时 "input.drop"
   * "input.complete" 自动完成时
   * "delete" 删除内容时
   * "delete.selection" 删除选区时
   * "delete.forward" 向前删除时
   * "delete.backward" 向后删除时
   * "delete.cut" 剪切时
   * "move" 移动内容时
   * "move.drop" 拖拽移动内容时
   * "select" 选择时
   * "select.pointer" 鼠标或其他指针设备选择时
   * "undo" and "redo" 历史记录操作
   */
  static userEvent: AnnotationType<string>;

  /** 事务是否应添加到撤消历史记录中 */
  static addToHistory: AnnotationType<boolean>;

  /** 事务是由远程更改的 */
  static remote: AnnotationType<boolean>;
}

/**
 * 描述变更操作
 */
declare class ChangeDesc {
  /** 更改前的文档长度 */
  length: number;

  /** 更改后的文档长度 */
  newLength: number;

  /** 当该集合中存在实际更改时为 false */
  empty: boolean;

  /**
   * 迭代更改留下的未更改部分，posA 提供旧文档中范围的位置，posB 提供更改文档中的新位置。
   */
  iterGaps(f: (posA: number, posB: number, length: number) => any): void;

  /**
   * 迭代更改的范围，fromA/toA 提供起始文档中的更改范围，fromB/toB 提供更改文档中的替换范围
   *
   * individual 默认为 false
   */
  iterChangedRanges(
    f: (fromA: number, toA: number, fromB: number, toB: number) => any,
    individual?: boolean
  ): void;

  /**
   * 计算在这组更改之后应用另一组更改的综合效果
   * 该组之后的文档长度应与之前的长度相匹配
   */
  composeDesc(other: ChangeDesc): ChangeDesc;

  /**
   * 当前描述映射到指定描述?
   *
   * before 默认为 false
   */
  mapDesc(other: ChangeDesc, before?: boolean): ChangeDesc;

  /**
   * 通过这些更改映射给定位置，以生成指向新文档的位置
   * assoc 指示该位置应与哪一侧关联。当它为负数或零时，映射将尝试保持位置靠近其前面的字符（如果有），并在该点插入或跨该点替换之前移动它
   * 当它为正数时，该位置与其后面的字符相关联，并且将向前移动以在该位置插入或跨该位置替换
   * mode 确定是否应报告删除，默认为 MapMode.Simple（不报告删除）
   *
   * assoc 默认 -1
   */
  mapPos(pos: number, assoc?: number): number;
  mapPos(pos: number, assoc: number, mode: MapMode): number | null;

  /**
   * 检查变更是否涉及指定的范围
   *
   * to 默认为 from
   */
  touchesRange(from: number, to?: number): boolean | "cover";

  toJSON(): readonly number[];

  static fromJSON(json: any): ChangeDesc;
}

declare enum MapMode {
  /** 将位置映射到有效的新位置，即使其上下文已删除 */
  Simple = "Simple",

  /** 如果删除发生在整个位置，则返回 null */
  TrackDel = "TrackDel",

  /** 如果删除该位置之前的字符，则返回 null */
  TrackBefore = "TrackBefore",
  /** 如果删除该位置后的字符，则返回 null。 */
  TrackAfter = "TrackAfter",
}

/**
 * 更改集表示对文档的一组修改，它存储文档长度，并且只能应用于恰好具有该长度的文档
 */
declare class ChangeSet extends ChangeDesc {
  /**
   * 将更改应用到文档，返回修改后的文档
   */
  apply(doc: Text): Text;

  /**
   * 给定更改之前的文档，返回可将当前文档倒退为指定文档的变更集
   */
  invert(doc: Text): ChangeSet;

  /** 组合变更集，other 在当前变更集之后 */
  compose(other: ChangeSet): ChangeSet;

  /**
   * 映射到其他变更集
   *
   * before 默认为 false
   */
  map(other: ChangeDesc, before?: boolean): ChangeSet;

  /**
   * 迭代变更
   *
   * individual 默认为 false
   */
  iterChanges(
    f: (fromA: number, toA: number, fromB: number, toB: number, inserted: Text) => any,
    individual?: boolean
  );

  /** 变更描述 */
  desc: ChangeDesc;

  toJSON(): any;

  static of(changes: ChangeSpec, length: number, lineSep?: string): ChangeSet;

  static empty(length: number): ChangeSet;

  static fromJSON(json: any): ChangeSet;
}

/**
 * 标记值，可扩展的元数据
 */
declare class Annotation<T> {
  type: AnnotationType<T>;

  value: T;

  static define<T>(): AnnotationType<T>;
}

declare class AnnotationType<T> {
  of(value: T): Annotation<T>;
}

/** 附加数据 */
declare class StateEffect<Value> {
  value: Value;

  /** 映射数据 */
  map(mapping: ChangeDesc): StateEffect<Value> | undefined;

  /** 是否是给定类型的 effect */
  is<T>(type: StateEffectType<T>): boolean;

  /** 定义新的 effect 类型 */
  static define<Value = null>(spec?: {
    map?: (value: Value, mapping: ChangeDesc) => Value | undefined;
  }): StateEffectType<Value>;

  static mapEffects(
    effects: readonly StateEffect<any>[],
    mapping: ChangeDesc
  ): readonly StateEffect<any>[];

  /** 重新配置 */
  static reconfigure: StateEffectType<Extension>;

  /** 添加配置 */
  static appendConfig: StateEffectType<Extension>;
}

/** 状态 type */
declare class StateEffectType<Value> {
  of(value: Value): StateEffect<Value>;
}

/** 不需要访问实际编辑器视图的命令子类型，对于定义可以在浏览器环境之外运行和测试的命令最有用 */
declare type StateCommand = (target: {
  state: EditorState;
  dispatch: (transaction: Transaction) => any;
}) => boolean;

declare type Extension = { extension: Extension } | readonly Extension[];

/** 字段可以在 EditorState 中存储附加信息，并使其与状态的其余部分保持同步 */
declare class StateField<Value> {
  /**
   * 返回启用此字段并覆盖其初始化方式的扩展
   * 当您需要为字段提供非默认起始值​​时非常有用
   * */
  init(create: (state: EditorState) => Value): Extension;

  /** 状态字段实例可以用作扩展值以在给定状态下启用该字段 */
  extension: Extension;

  /** 定义状态字段 */
  static define<Value>(config: {
    /** 状态初始值 */
    create(state: EditorState): Value;

    /** 更新状态值 */
    update(value: Value, transaction: Transaction): Value;

    /** 比较字段值 */
    compare?: (a: Value, b: Value) => boolean;

    /** 提供字段扩展 */
    provide?: (field: StateField<Value>) => Extension;

    toJSON?: (value: Value, state: EditorState) => any;

    fromJSON?: (json: any, state: EditorState) => Value;
  }): StateField<Value>;
}

/** 标记值 */
declare class Facet<Input, Output = readonly Input[]> implements FacetReader<Output> {
  of(value: Input): Extension;

  compute(
    deps: readonly (StateField<any> | "doc" | "selection" | FacetReader<any>)[],
    get: (state: EditorState) => Input
  ): Extension;

  computeN(
    deps: readonly (StateField<any> | "doc" | "selection" | FacetReader<any>)[],
    get: (state: EditorState) => readonly Input[]
  ): Extension;

  from<T extends Input>(field: StateField<T>): Extension;
  from<T>(field: StateField<T>, get: (value: T) => Input): Extension;

  static define<Input, Output = readonly Input[]>(config?: {
    combine?: (value: readonly Input[]) => Output;

    compare?: (a: Output, b: Output) => boolean;

    compareInput?: (a: Input, b: Input) => boolean;

    static?: boolean;

    enables?: Extension | ((self: Facet<Input, Output>) => Extension);
  }): Facet<Input, Output>;
}

declare type FacetReader<Output> = {
  tag: Output;
};

declare type Prec = {
  highest(ext: Extension): Extension;

  high(ext: Extension): Extension;

  default(ext: Extension): Extension;

  low(ext: Extension): Extension;

  lowest(ext: Extension): Extension;
};
