import { Text } from "./text";
import { findClusterBreak } from "./char";
import { ChangeSet, ChangeSpec, DefaultSplit } from "./change";
import { EditorSelection, SelectionRange, checkSelection } from "./selection";
import {
  Transaction,
  TransactionSpec,
  resolveTransaction,
  asArray,
  StateEffect,
} from "./transaction";
import {
  allowMultipleSelections,
  changeFilter,
  transactionFilter,
  transactionExtender,
  lineSeparator,
  languageData,
  readOnly,
} from "./extension";
import {
  Configuration,
  Facet,
  FacetReader,
  Extension,
  StateField,
  SlotStatus,
  ensureAddr,
  getAddr,
  Compartment,
  DynamicSlot,
} from "./facet";
import { CharCategory, makeCategorizer } from "./charcategory";

/// Options passed when [creating](#state.EditorState^create) an
/// editor state.
export interface EditorStateConfig {
  /// The initial document. Defaults to an empty document. Can be
  /// provided either as a plain string (which will be split into
  /// lines according to the value of the [`lineSeparator`
  /// facet](#state.EditorState^lineSeparator)), or an instance of
  /// the [`Text`](#state.Text) class (which is what the state will use
  /// to represent the document).
  doc?: string | Text;
  /// The starting selection. Defaults to a cursor at the very start
  /// of the document.
  selection?: EditorSelection | { anchor: number; head?: number };
  /// [Extension(s)](#state.Extension) to associate with this state.
  extensions?: Extension;
}

/// The editor state class is a persistent (immutable) data structure.
/// To update a state, you [create](#state.EditorState.update) a
/// [transaction](#state.Transaction), which produces a _new_ state
/// instance, without modifying the original object.
///
/// As such, _never_ mutate properties of a state directly. That'll
/// just break things.
export class EditorState {
  /// @internal
  readonly status: SlotStatus[];
  /// @internal
  computeSlot: null | ((state: EditorState, slot: DynamicSlot) => SlotStatus);

  private constructor(
    /// @internal
    readonly config: Configuration,
    /// The current document.
    readonly doc: Text,
    /// The current selection.
    readonly selection: EditorSelection,
    /// @internal
    readonly values: any[],
    computeSlot: (state: EditorState, slot: DynamicSlot) => SlotStatus,
    tr: Transaction | null
  ) {
    this.status = config.statusTemplate.slice();
    this.computeSlot = computeSlot;
    // Fill in the computed state immediately, so that further queries
    // for it made during the update return this state
    if (tr) tr._state = this;
    for (let i = 0; i < this.config.dynamicSlots.length; i++) ensureAddr(this, i << 1);
    this.computeSlot = null;
  }

  /// Retrieve the value of a [state field](#state.StateField). Throws
  /// an error when the state doesn't have that field, unless you pass
  /// `false` as second parameter.
  field<T>(field: StateField<T>): T;
  field<T>(field: StateField<T>, require: false): T | undefined;
  field<T>(field: StateField<T>, require: boolean = true): T | undefined {
    const addr = this.config.address[field.id];
    if (addr == null) {
      if (require) throw new RangeError("Field is not present in this state");
      return undefined;
    }
    ensureAddr(this, addr);
    return getAddr(this, addr);
  }

  /// Create a [transaction](#state.Transaction) that updates this
  /// state. Any number of [transaction specs](#state.TransactionSpec)
  /// can be passed. Unless
  /// [`sequential`](#state.TransactionSpec.sequential) is set, the
  /// [changes](#state.TransactionSpec.changes) (if any) of each spec
  /// are assumed to start in the _current_ document (not the document
  /// produced by previous specs), and its
  /// [selection](#state.TransactionSpec.selection) and
  /// [effects](#state.TransactionSpec.effects) are assumed to refer
  /// to the document created by its _own_ changes. The resulting
  /// transaction contains the combined effect of all the different
  /// specs. For [selection](#state.TransactionSpec.selection), later
  /// specs take precedence over earlier ones.
  update(...specs: readonly TransactionSpec[]): Transaction {
    return resolveTransaction(this, specs, true);
  }

  /// @internal
  applyTransaction(tr: Transaction) {
    let conf: Configuration | null = this.config,
      { base, compartments } = conf;
    for (const effect of tr.effects) {
      if (effect.is(Compartment.reconfigure)) {
        if (conf) {
          compartments = new Map();
          conf.compartments.forEach((val, key) => compartments!.set(key, val));
          conf = null;
        }
        compartments.set(effect.value.compartment, effect.value.extension);
      } else if (effect.is(StateEffect.reconfigure)) {
        conf = null;
        base = effect.value;
      } else if (effect.is(StateEffect.appendConfig)) {
        conf = null;
        base = asArray(base).concat(effect.value);
      }
    }
    let startValues;
    if (!conf) {
      conf = Configuration.resolve(base, compartments, this);
      const intermediateState = new EditorState(
        conf,
        this.doc,
        this.selection,
        conf.dynamicSlots.map(() => null),
        (state, slot) => slot.reconfigure(state, this),
        null
      );
      startValues = intermediateState.values;
    } else {
      startValues = tr.startState.values.slice();
    }
    const selection = tr.startState.facet(allowMultipleSelections)
      ? tr.newSelection
      : tr.newSelection.asSingle();
    new EditorState(
      conf,
      tr.newDoc,
      selection,
      startValues,
      (state, slot) => slot.update(state, tr),
      tr
    );
  }

  /// Create a [transaction spec](#state.TransactionSpec) that
  /// replaces every selection range with the given content.
  replaceSelection(text: string | Text): TransactionSpec {
    if (typeof text == "string") text = this.toText(text);
    return this.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    }));
  }

  /// Create a set of changes and a new selection by running the given
  /// function for each range in the active selection. The function
  /// can return an optional set of changes (in the coordinate space
  /// of the start document), plus an updated range (in the coordinate
  /// space of the document produced by the call's own changes). This
  /// method will merge all the changes and ranges into a single
  /// changeset and selection, and return it as a [transaction
  /// spec](#state.TransactionSpec), which can be passed to
  /// [`update`](#state.EditorState.update).
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
  } {
    const sel = this.selection;
    const result1 = f(sel.ranges[0]);
    let changes = this.changes(result1.changes);
    const ranges = [result1.range];
    let effects = asArray(result1.effects);
    for (let i = 1; i < sel.ranges.length; i++) {
      const result = f(sel.ranges[i]);
      const newChanges = this.changes(result.changes),
        newMapped = newChanges.map(changes);
      for (let j = 0; j < i; j++) ranges[j] = ranges[j].map(newMapped);
      const mapBy = changes.mapDesc(newChanges, true);
      ranges.push(result.range.map(mapBy));
      changes = changes.compose(newMapped);
      effects = StateEffect.mapEffects(effects, newMapped).concat(
        StateEffect.mapEffects(asArray(result.effects), mapBy)
      );
    }
    return {
      changes,
      selection: EditorSelection.create(ranges, sel.mainIndex),
      effects,
    };
  }

  /// Create a [change set](#state.ChangeSet) from the given change
  /// description, taking the state's document length and line
  /// separator into account.
  changes(spec: ChangeSpec = []) {
    if (spec instanceof ChangeSet) return spec;
    return ChangeSet.of(spec, this.doc.length, this.facet(EditorState.lineSeparator));
  }

  /// Using the state's [line
  /// separator](#state.EditorState^lineSeparator), create a
  /// [`Text`](#state.Text) instance from the given string.
  toText(string: string): Text {
    return Text.of(string.split(this.facet(EditorState.lineSeparator) || DefaultSplit));
  }

  /// Return the given range of the document as a string.
  sliceDoc(from = 0, to = this.doc.length) {
    return this.doc.sliceString(from, to, this.lineBreak);
  }

  /// Get the value of a state [facet](#state.Facet).
  facet<Output>(facet: FacetReader<Output>): Output {
    const addr = this.config.address[facet.id];
    if (addr == null) return facet.default;
    ensureAddr(this, addr);
    return getAddr(this, addr);
  }

  /// Convert this state to a JSON-serializable object. When custom
  /// fields should be serialized, you can pass them in as an object
  /// mapping property names (in the resulting object, which should
  /// not use `doc` or `selection`) to fields.
  toJSON(fields?: { [prop: string]: StateField<any> }): any {
    const result: any = {
      doc: this.sliceDoc(),
      selection: this.selection.toJSON(),
    };
    if (fields)
      for (const prop in fields) {
        const value = fields[prop];
        if (value instanceof StateField && this.config.address[value.id] != null)
          result[prop] = value.spec.toJSON!(this.field(fields[prop]), this);
      }
    return result;
  }

  /// Deserialize a state from its JSON representation. When custom
  /// fields should be deserialized, pass the same object you passed
  /// to [`toJSON`](#state.EditorState.toJSON) when serializing as
  /// third argument.
  static fromJSON(
    json: any,
    config: EditorStateConfig = {},
    fields?: { [prop: string]: StateField<any> }
  ): EditorState {
    if (!json || typeof json.doc != "string")
      throw new RangeError("Invalid JSON representation for EditorState");
    const fieldInit = [];
    if (fields)
      for (const prop in fields) {
        if (Object.prototype.hasOwnProperty.call(json, prop)) {
          const field = fields[prop],
            value = json[prop];
          fieldInit.push(field.init((state) => field.spec.fromJSON!(value, state)));
        }
      }

    return EditorState.create({
      doc: json.doc,
      selection: EditorSelection.fromJSON(json.selection),
      extensions: config.extensions ? fieldInit.concat([config.extensions]) : fieldInit,
    });
  }

  /// Create a new state. You'll usually only need this when
  /// initializing an editor—updated states are created by applying
  /// transactions.
  static create(config: EditorStateConfig = {}): EditorState {
    const configuration = Configuration.resolve(config.extensions || [], new Map());
    const doc =
      config.doc instanceof Text
        ? config.doc
        : Text.of(
            (config.doc || "").split(
              configuration.staticFacet(EditorState.lineSeparator) || DefaultSplit
            )
          );
    let selection = !config.selection
      ? EditorSelection.single(0)
      : config.selection instanceof EditorSelection
      ? config.selection
      : EditorSelection.single(config.selection.anchor, config.selection.head);
    checkSelection(selection, doc.length);
    if (!configuration.staticFacet(allowMultipleSelections)) selection = selection.asSingle();
    return new EditorState(
      configuration,
      doc,
      selection,
      configuration.dynamicSlots.map(() => null),
      (state, slot) => slot.create(state),
      null
    );
  }

  /// A facet that, when enabled, causes the editor to allow multiple
  /// ranges to be selected. Be careful though, because by default the
  /// editor relies on the native DOM selection, which cannot handle
  /// multiple selections. An extension like
  /// [`drawSelection`](#view.drawSelection) can be used to make
  /// secondary selections visible to the user.
  static allowMultipleSelections = allowMultipleSelections;

  /// Configures the tab size to use in this state. The first
  /// (highest-precedence) value of the facet is used. If no value is
  /// given, this defaults to 4.
  static tabSize = Facet.define<number, number>({
    combine: (values) => (values.length ? values[0] : 4),
  });

  /// The size (in columns) of a tab in the document, determined by
  /// the [`tabSize`](#state.EditorState^tabSize) facet.
  get tabSize() {
    return this.facet(EditorState.tabSize);
  }

  /// The line separator to use. By default, any of `"\n"`, `"\r\n"`
  /// and `"\r"` is treated as a separator when splitting lines, and
  /// lines are joined with `"\n"`.
  ///
  /// When you configure a value here, only that precise separator
  /// will be used, allowing you to round-trip documents through the
  /// editor without normalizing line separators.
  static lineSeparator = lineSeparator;

  /// Get the proper [line-break](#state.EditorState^lineSeparator)
  /// string for this state.
  get lineBreak() {
    return this.facet(EditorState.lineSeparator) || "\n";
  }

  /// This facet controls the value of the
  /// [`readOnly`](#state.EditorState.readOnly) getter, which is
  /// consulted by commands and extensions that implement editing
  /// functionality to determine whether they should apply. It
  /// defaults to false, but when its highest-precedence value is
  /// `true`, such functionality disables itself.
  ///
  /// Not to be confused with
  /// [`EditorView.editable`](#view.EditorView^editable), which
  /// controls whether the editor's DOM is set to be editable (and
  /// thus focusable).
  static readOnly = readOnly;

  /// Returns true when the editor is
  /// [configured](#state.EditorState^readOnly) to be read-only.
  get readOnly() {
    return this.facet(readOnly);
  }

  /// Registers translation phrases. The
  /// [`phrase`](#state.EditorState.phrase) method will look through
  /// all objects registered with this facet to find translations for
  /// its argument.
  static phrases = Facet.define<{ [key: string]: string }>({
    compare(a, b) {
      const kA = Object.keys(a),
        kB = Object.keys(b);
      return kA.length == kB.length && kA.every((k) => a[k as any] == b[k as any]);
    },
  });

  /// Look up a translation for the given phrase (via the
  /// [`phrases`](#state.EditorState^phrases) facet), or return the
  /// original string if no translation is found.
  ///
  /// If additional arguments are passed, they will be inserted in
  /// place of markers like `$1` (for the first value) and `$2`, etc.
  /// A single `$` is equivalent to `$1`, and `$$` will produce a
  /// literal dollar sign.
  phrase(phrase: string, ...insert: any[]): string {
    for (const map of this.facet(EditorState.phrases))
      if (Object.prototype.hasOwnProperty.call(map, phrase)) {
        phrase = map[phrase];
        break;
      }
    if (insert.length)
      phrase = phrase.replace(/\$(\$|\d*)/g, (m, i) => {
        if (i == "$") return "$";
        const n = +(i || 1);
        return !n || n > insert.length ? m : insert[n - 1];
      });
    return phrase;
  }

  /// A facet used to register [language
  /// data](#state.EditorState.languageDataAt) providers.
  static languageData = languageData;

  /// Find the values for a given language data field, provided by the
  /// the [`languageData`](#state.EditorState^languageData) facet.
  ///
  /// Examples of language data fields are...
  ///
  /// - [`"commentTokens"`](#commands.CommentTokens) for specifying
  ///   comment syntax.
  /// - [`"autocomplete"`](#autocomplete.autocompletion^config.override)
  ///   for providing language-specific completion sources.
  /// - [`"wordChars"`](#state.EditorState.charCategorizer) for adding
  ///   characters that should be considered part of words in this
  ///   language.
  /// - [`"closeBrackets"`](#autocomplete.CloseBracketConfig) controls
  ///   bracket closing behavior.
  languageDataAt<T>(name: string, pos: number, side: -1 | 0 | 1 = -1): readonly T[] {
    const values: T[] = [];
    for (const provider of this.facet(languageData)) {
      for (const result of provider(this, pos, side)) {
        if (Object.prototype.hasOwnProperty.call(result, name)) values.push(result[name]);
      }
    }
    return values;
  }

  /// Return a function that can categorize strings (expected to
  /// represent a single [grapheme cluster](#state.findClusterBreak))
  /// into one of:
  ///
  ///  - Word (contains an alphanumeric character or a character
  ///    explicitly listed in the local language's `"wordChars"`
  ///    language data, which should be a string)
  ///  - Space (contains only whitespace)
  ///  - Other (anything else)
  charCategorizer(at: number): (char: string) => CharCategory {
    return makeCategorizer(this.languageDataAt<string>("wordChars", at).join(""));
  }

  /// Find the word at the given position, meaning the range
  /// containing all [word](#state.CharCategory.Word) characters
  /// around it. If no word characters are adjacent to the position,
  /// this returns null.
  wordAt(pos: number): SelectionRange | null {
    const { text, from, length } = this.doc.lineAt(pos);
    const cat = this.charCategorizer(pos);
    let start = pos - from,
      end = pos - from;
    while (start > 0) {
      const prev = findClusterBreak(text, start, false);
      if (cat(text.slice(prev, start)) != CharCategory.Word) break;
      start = prev;
    }
    while (end < length) {
      const next = findClusterBreak(text, end);
      if (cat(text.slice(end, next)) != CharCategory.Word) break;
      end = next;
    }
    return start == end ? null : EditorSelection.range(start + from, end + from);
  }

  /// Facet used to register change filters, which are called for each
  /// transaction (unless explicitly
  /// [disabled](#state.TransactionSpec.filter)), and can suppress
  /// part of the transaction's changes.
  ///
  /// Such a function can return `true` to indicate that it doesn't
  /// want to do anything, `false` to completely stop the changes in
  /// the transaction, or a set of ranges in which changes should be
  /// suppressed. Such ranges are represented as an array of numbers,
  /// with each pair of two numbers indicating the start and end of a
  /// range. So for example `[10, 20, 100, 110]` suppresses changes
  /// between 10 and 20, and between 100 and 110.
  static changeFilter = changeFilter;

  /// Facet used to register a hook that gets a chance to update or
  /// replace transaction specs before they are applied. This will
  /// only be applied for transactions that don't have
  /// [`filter`](#state.TransactionSpec.filter) set to `false`. You
  /// can either return a single transaction spec (possibly the input
  /// transaction), or an array of specs (which will be combined in
  /// the same way as the arguments to
  /// [`EditorState.update`](#state.EditorState.update)).
  ///
  /// When possible, it is recommended to avoid accessing
  /// [`Transaction.state`](#state.Transaction.state) in a filter,
  /// since it will force creation of a state that will then be
  /// discarded again, if the transaction is actually filtered.
  ///
  /// (This functionality should be used with care. Indiscriminately
  /// modifying transaction is likely to break something or degrade
  /// the user experience.)
  static transactionFilter = transactionFilter;

  /// This is a more limited form of
  /// [`transactionFilter`](#state.EditorState^transactionFilter),
  /// which can only add
  /// [annotations](#state.TransactionSpec.annotations) and
  /// [effects](#state.TransactionSpec.effects). _But_, this type
  /// of filter runs even if the transaction has disabled regular
  /// [filtering](#state.TransactionSpec.filter), making it suitable
  /// for effects that don't need to touch the changes or selection,
  /// but do want to process every transaction.
  ///
  /// Extenders run _after_ filters, when both are present.
  static transactionExtender = transactionExtender;
}

Compartment.reconfigure = StateEffect.define<{ compartment: Compartment; extension: Extension }>();
