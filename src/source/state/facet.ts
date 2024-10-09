import { Transaction, StateEffect, StateEffectType } from "./transaction";
import { EditorState } from "./state";

let nextID = 0;

type FacetConfig<Input, Output> = {
  /// How to combine the input values into a single output value. When
  /// not given, the array of input values becomes the output. This
  /// function will immediately be called on creating the facet, with
  /// an empty array, to compute the facet's default value when no
  /// inputs are present.
  combine?: (value: readonly Input[]) => Output;
  /// How to compare output values to determine whether the value of
  /// the facet changed. Defaults to comparing by `===` or, if no
  /// `combine` function was given, comparing each element of the
  /// array with `===`.
  compare?: (a: Output, b: Output) => boolean;
  /// How to compare input values to avoid recomputing the output
  /// value when no inputs changed. Defaults to comparing with `===`.
  compareInput?: (a: Input, b: Input) => boolean;
  /// Forbids dynamic inputs to this facet.
  static?: boolean;
  /// If given, these extension(s) (or the result of calling the given
  /// function with the facet) will be added to any state where this
  /// facet is provided. (Note that, while a facet's default value can
  /// be read from a state even if the facet wasn't present in the
  /// state at all, these extensions won't be added in that
  /// situation.)
  enables?: Extension | ((self: Facet<Input, Output>) => Extension);
};

/// A facet is a labeled value that is associated with an editor
/// state. It takes inputs from any number of extensions, and combines
/// those into a single output value.
///
/// Examples of uses of facets are the [tab
/// size](#state.EditorState^tabSize), [editor
/// attributes](#view.EditorView^editorAttributes), and [update
/// listeners](#view.EditorView^updateListener).
///
/// Note that `Facet` instances can be used anywhere where
/// [`FacetReader`](#state.FacetReader) is expected.
export class Facet<Input, Output = readonly Input[]> implements FacetReader<Output> {
  /// @internal
  readonly id = nextID++;
  /// @internal
  readonly default: Output;
  /// @internal
  readonly extensions: Extension | undefined;

  private constructor(
    /// @internal
    readonly combine: (values: readonly Input[]) => Output,
    /// @internal
    readonly compareInput: (a: Input, b: Input) => boolean,
    /// @internal
    readonly compare: (a: Output, b: Output) => boolean,
    private isStatic: boolean,
    enables: Extension | undefined | ((self: Facet<Input, Output>) => Extension)
  ) {
    this.default = combine([]);
    this.extensions = typeof enables == "function" ? enables(this) : enables;
  }

  /// Returns a facet reader for this facet, which can be used to
  /// [read](#state.EditorState.facet) it but not to define values for it.
  get reader(): FacetReader<Output> {
    return this;
  }

  /// Define a new facet.
  static define<Input, Output = readonly Input[]>(config: FacetConfig<Input, Output> = {}) {
    return new Facet<Input, Output>(
      config.combine || (((a: any) => a) as any),
      config.compareInput || ((a, b) => a === b),
      config.compare || (!config.combine ? (sameArray as any) : (a, b) => a === b),
      !!config.static,
      config.enables
    );
  }

  /// Returns an extension that adds the given value to this facet.
  of(value: Input): Extension {
    return new FacetProvider<Input>([], this, Provider.Static, value);
  }

  /// Create an extension that computes a value for the facet from a
  /// state. You must take care to declare the parts of the state that
  /// this value depends on, since your function is only called again
  /// for a new state when one of those parts changed.
  ///
  /// In cases where your value depends only on a single field, you'll
  /// want to use the [`from`](#state.Facet.from) method instead.
  compute(deps: readonly Slot<any>[], get: (state: EditorState) => Input): Extension {
    if (this.isStatic) throw new Error("Can't compute a static facet");
    return new FacetProvider<Input>(deps, this, Provider.Single, get);
  }

  /// Create an extension that computes zero or more values for this
  /// facet from a state.
  computeN(deps: readonly Slot<any>[], get: (state: EditorState) => readonly Input[]): Extension {
    if (this.isStatic) throw new Error("Can't compute a static facet");
    return new FacetProvider<Input>(deps, this, Provider.Multi, get);
  }

  /// Shorthand method for registering a facet source with a state
  /// field as input. If the field's type corresponds to this facet's
  /// input type, the getter function can be omitted. If given, it
  /// will be used to retrieve the input from the field value.
  from<T extends Input>(field: StateField<T>): Extension;
  from<T>(field: StateField<T>, get: (value: T) => Input): Extension;
  from<T>(field: StateField<T>, get?: (value: T) => Input): Extension {
    if (!get) get = (x) => x as any;
    return this.compute([field], (state) => get!(state.field(field)));
  }

  tag!: Output;
}

/// A facet reader can be used to fetch the value of a facet, through
/// [`EditorState.facet`](#state.EditorState.facet) or as a dependency
/// in [`Facet.compute`](#state.Facet.compute), but not to define new
/// values for the facet.
export type FacetReader<Output> = {
  /// @internal
  id: number;
  /// @internal
  default: Output;
  /// Dummy tag that makes sure TypeScript doesn't consider all object
  /// types as conforming to this type. Not actually present on the
  /// object.
  tag: Output;
};

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a == b || (a.length == b.length && a.every((e, i) => e === b[i]));
}

type Slot<T> = FacetReader<T> | StateField<T> | "doc" | "selection";

const enum Provider {
  Static,
  Single,
  Multi,
}

class FacetProvider<Input> {
  readonly id = nextID++;
  extension!: Extension; // Kludge to convince the type system these count as extensions

  constructor(
    readonly dependencies: readonly Slot<any>[],
    readonly facet: Facet<Input, any>,
    readonly type: Provider,
    readonly value:
      | ((state: EditorState) => Input)
      | ((state: EditorState) => readonly Input[])
      | Input
  ) {}

  dynamicSlot(addresses: { [id: number]: number }): DynamicSlot {
    const getter: (state: EditorState) => any = this.value as any;
    const compare = this.facet.compareInput;
    const id = this.id,
      idx = addresses[id] >> 1,
      multi = this.type == Provider.Multi;

    let depDoc = false,
      depSel = false;

    const depAddrs: number[] = [];
    for (const dep of this.dependencies) {
      if (dep == "doc") depDoc = true;
      else if (dep == "selection") depSel = true;
      else if (((addresses[dep.id] ?? 1) & 1) == 0) depAddrs.push(addresses[dep.id]);
    }

    return {
      create(state) {
        state.values[idx] = getter(state);
        return SlotStatus.Changed;
      },
      update(state, tr) {
        if (
          (depDoc && tr.docChanged) ||
          (depSel && (tr.docChanged || tr.selection)) ||
          ensureAll(state, depAddrs)
        ) {
          const newVal = getter(state);
          if (
            multi
              ? !compareArray(newVal, state.values[idx], compare)
              : !compare(newVal, state.values[idx])
          ) {
            state.values[idx] = newVal;
            return SlotStatus.Changed;
          }
        }
        return 0;
      },
      reconfigure: (state, oldState) => {
        let newVal: (state: EditorState) => any;
        const oldAddr = oldState.config.address[id];
        if (oldAddr != null) {
          const oldVal = getAddr(oldState, oldAddr);
          if (
            this.dependencies.every((dep) => {
              return dep instanceof Facet
                ? oldState.facet(dep) === state.facet(dep)
                : dep instanceof StateField
                ? oldState.field(dep, false) == state.field(dep, false)
                : true;
            }) ||
            (multi
              ? compareArray((newVal = getter(state)), oldVal, compare)
              : compare((newVal = getter(state)), oldVal))
          ) {
            state.values[idx] = oldVal;
            return 0;
          }
        } else {
          newVal = getter(state);
        }
        state.values[idx] = newVal;
        return SlotStatus.Changed;
      },
    };
  }
}

function compareArray<T>(a: readonly T[], b: readonly T[], compare: (a: T, b: T) => boolean) {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (!compare(a[i], b[i])) return false;
  return true;
}

function ensureAll(state: EditorState, addrs: readonly number[]) {
  let changed = false;
  for (const addr of addrs) if (ensureAddr(state, addr) & SlotStatus.Changed) changed = true;
  return changed;
}

function dynamicFacetSlot<Input, Output>(
  addresses: { [id: number]: number },
  facet: Facet<Input, Output>,
  providers: readonly FacetProvider<Input>[]
): DynamicSlot {
  const providerAddrs = providers.map((p) => addresses[p.id]);
  const providerTypes = providers.map((p) => p.type);
  const dynamic = providerAddrs.filter((p) => !(p & 1));
  const idx = addresses[facet.id] >> 1;

  function get(state: EditorState) {
    const values: Input[] = [];
    for (let i = 0; i < providerAddrs.length; i++) {
      const value = getAddr(state, providerAddrs[i]);
      if (providerTypes[i] == Provider.Multi) for (const val of value) values.push(val);
      else values.push(value);
    }
    return facet.combine(values);
  }

  return {
    create(state) {
      for (const addr of providerAddrs) ensureAddr(state, addr);
      state.values[idx] = get(state);
      return SlotStatus.Changed;
    },
    update(state, _tr) {
      if (!ensureAll(state, dynamic)) return 0;
      const value = get(state);
      if (facet.compare(value, state.values[idx])) return 0;
      state.values[idx] = value;
      return SlotStatus.Changed;
    },
    reconfigure(state, oldState) {
      const depChanged = ensureAll(state, providerAddrs);
      const oldProviders = oldState.config.facets[facet.id],
        oldValue = oldState.facet(facet);
      if (oldProviders && !depChanged && sameArray(providers, oldProviders)) {
        state.values[idx] = oldValue;
        return 0;
      }
      const value = get(state);
      if (facet.compare(value, oldValue)) {
        state.values[idx] = oldValue;
        return 0;
      }
      state.values[idx] = value;
      return SlotStatus.Changed;
    },
  };
}

type StateFieldSpec<Value> = {
  /// Creates the initial value for the field when a state is created.
  create: (state: EditorState) => Value;

  /// Compute a new value from the field's previous value and a
  /// [transaction](#state.Transaction).
  update: (value: Value, transaction: Transaction) => Value;

  /// Compare two values of the field, returning `true` when they are
  /// the same. This is used to avoid recomputing facets that depend
  /// on the field when its value did not change. Defaults to using
  /// `===`.
  compare?: (a: Value, b: Value) => boolean;

  /// Provide extensions based on this field. The given function will
  /// be called once with the initialized field. It will usually want
  /// to call some facet's [`from`](#state.Facet.from) method to
  /// create facet inputs from this field, but can also return other
  /// extensions that should be enabled when the field is present in a
  /// configuration.
  provide?: (field: StateField<Value>) => Extension;

  /// A function used to serialize this field's content to JSON. Only
  /// necessary when this field is included in the argument to
  /// [`EditorState.toJSON`](#state.EditorState.toJSON).
  toJSON?: (value: Value, state: EditorState) => any;

  /// A function that deserializes the JSON representation of this
  /// field's content.
  fromJSON?: (json: any, state: EditorState) => Value;
};

const initField = Facet.define<{
  field: StateField<unknown>;
  create: (state: EditorState) => unknown;
}>({ static: true });

/// Fields can store additional information in an editor state, and
/// keep it in sync with the rest of the state.
export class StateField<Value> {
  /// @internal
  public provides: Extension | undefined = undefined;

  private constructor(
    /// @internal
    readonly id: number,
    private createF: (state: EditorState) => Value,
    private updateF: (value: Value, tr: Transaction) => Value,
    private compareF: (a: Value, b: Value) => boolean,
    /// @internal
    readonly spec: StateFieldSpec<Value>
  ) {}

  /// Define a state field.
  static define<Value>(config: StateFieldSpec<Value>): StateField<Value> {
    const field = new StateField<Value>(
      nextID++,
      config.create,
      config.update,
      config.compare || ((a, b) => a === b),
      config
    );
    if (config.provide) field.provides = config.provide(field);
    return field;
  }

  private create(state: EditorState) {
    const init = state.facet(initField).find((i) => i.field == this);
    return (init?.create || this.createF)(state);
  }

  /// @internal
  slot(addresses: { [id: number]: number }): DynamicSlot {
    const idx = addresses[this.id] >> 1;
    return {
      create: (state) => {
        state.values[idx] = this.create(state);
        return SlotStatus.Changed;
      },
      update: (state, tr) => {
        const oldVal = state.values[idx];
        const value = this.updateF(oldVal, tr);
        if (this.compareF(oldVal, value)) return 0;
        state.values[idx] = value;
        return SlotStatus.Changed;
      },
      reconfigure: (state, oldState) => {
        if (oldState.config.address[this.id] != null) {
          state.values[idx] = oldState.field(this);
          return 0;
        }
        state.values[idx] = this.create(state);
        return SlotStatus.Changed;
      },
    };
  }

  /// Returns an extension that enables this field and overrides the
  /// way it is initialized. Can be useful when you need to provide a
  /// non-default starting value for the field.
  init(create: (state: EditorState) => Value): Extension {
    return [this, initField.of({ field: this as any, create })];
  }

  /// State field instances can be used as
  /// [`Extension`](#state.Extension) values to enable the field in a
  /// given state.
  get extension(): Extension {
    return this;
  }
}

/// Extension values can be
/// [provided](#state.EditorStateConfig.extensions) when creating a
/// state to attach various kinds of configuration and behavior
/// information. They can either be built-in extension-providing
/// objects, such as [state fields](#state.StateField) or [facet
/// providers](#state.Facet.of), or objects with an extension in its
/// `extension` property. Extensions can be nested in arrays
/// arbitrarily deep—they will be flattened when processed.
export type Extension = { extension: Extension } | readonly Extension[];

const Prec_ = { lowest: 4, low: 3, default: 2, high: 1, highest: 0 };

function prec(value: number) {
  return (ext: Extension) => new PrecExtension(ext, value) as Extension;
}

/// By default extensions are registered in the order they are found
/// in the flattened form of nested array that was provided.
/// Individual extension values can be assigned a precedence to
/// override this. Extensions that do not have a precedence set get
/// the precedence of the nearest parent with a precedence, or
/// [`default`](#state.Prec.default) if there is no such parent. The
/// final ordering of extensions is determined by first sorting by
/// precedence and then by order within each precedence.
export const Prec = {
  /// The highest precedence level, for extensions that should end up
  /// near the start of the precedence ordering.
  highest: prec(Prec_.highest),
  /// A higher-than-default precedence, for extensions that should
  /// come before those with default precedence.
  high: prec(Prec_.high),
  /// The default precedence, which is also used for extensions
  /// without an explicit precedence.
  default: prec(Prec_.default),
  /// A lower-than-default precedence.
  low: prec(Prec_.low),
  /// The lowest precedence level. Meant for things that should end up
  /// near the end of the extension order.
  lowest: prec(Prec_.lowest),
};

class PrecExtension {
  constructor(readonly inner: Extension, readonly prec: number) {}
  extension!: Extension;
}

/// Extension compartments can be used to make a configuration
/// dynamic. By [wrapping](#state.Compartment.of) part of your
/// configuration in a compartment, you can later
/// [replace](#state.Compartment.reconfigure) that part through a
/// transaction.
export class Compartment {
  /// Create an instance of this compartment to add to your [state
  /// configuration](#state.EditorStateConfig.extensions).
  of(ext: Extension): Extension {
    return new CompartmentInstance(this, ext);
  }

  /// Create an [effect](#state.TransactionSpec.effects) that
  /// reconfigures this compartment.
  reconfigure(content: Extension): StateEffect<unknown> {
    return Compartment.reconfigure.of({ compartment: this, extension: content });
  }

  /// Get the current content of the compartment in the state, or
  /// `undefined` if it isn't present.
  get(state: EditorState): Extension | undefined {
    return state.config.compartments.get(this);
  }

  /// This is initialized in state.ts to avoid a cyclic dependency
  /// @internal
  static reconfigure: StateEffectType<{ compartment: Compartment; extension: Extension }>;
}

export class CompartmentInstance {
  constructor(readonly compartment: Compartment, readonly inner: Extension) {}
  extension!: Extension;
}

export interface DynamicSlot {
  create(state: EditorState): SlotStatus;
  update(state: EditorState, tr: Transaction): SlotStatus;
  reconfigure(state: EditorState, oldState: EditorState): SlotStatus;
}

/** 配置值 */
export class Configuration {
  readonly statusTemplate: SlotStatus[] = [];

  constructor(
    readonly base: Extension,
    readonly compartments: Map<Compartment, Extension>,
    readonly dynamicSlots: DynamicSlot[],
    readonly address: { [id: number]: number },
    readonly staticValues: readonly any[],
    readonly facets: { [id: number]: readonly FacetProvider<any>[] }
  ) {
    while (this.statusTemplate.length < dynamicSlots.length) {
      this.statusTemplate.push(SlotStatus.Unresolved);
    }
  }

  /** 获取静态方面值 */
  staticFacet<Output>(facet: Facet<any, Output>) {
    const addr = this.address[facet.id];
    return addr == null ? facet.default : this.staticValues[addr >> 1];
  }

  /** 整合配置 */
  static resolve(
    base: Extension,
    compartments: Map<Compartment, Extension>,
    oldState?: EditorState
  ) {
    const fields: StateField<any>[] = [];
    const facets: { [id: number]: FacetProvider<any>[] } = Object.create(null);
    const newCompartments = new Map<Compartment, Extension>();

    for (const ext of flatten(base, compartments, newCompartments)) {
      if (ext instanceof StateField) {
        fields.push(ext);
      } else {
        (facets[ext.facet.id] || (facets[ext.facet.id] = [])).push(ext);
      }
    }

    const address: { [id: number]: number } = Object.create(null);
    const staticValues: any[] = [];
    const dynamicSlots: ((address: { [id: number]: number }) => DynamicSlot)[] = [];

    for (const field of fields) {
      address[field.id] = dynamicSlots.length << 1;

      dynamicSlots.push((a) => field.slot(a));
    }

    const oldFacets = oldState?.config.facets;
    for (const id in facets) {
      const providers = facets[id];
      const facet = providers[0].facet;

      const oldProviders = (oldFacets && oldFacets[id]) || [];

      if (providers.every((p) => p.type == Provider.Static)) {
        address[facet.id] = (staticValues.length << 1) | 1;

        if (sameArray(oldProviders, providers)) {
          staticValues.push(oldState!.facet(facet));
        } else {
          const value = facet.combine(providers.map((p) => p.value));

          staticValues.push(
            oldState && facet.compare(value, oldState.facet(facet)) ? oldState.facet(facet) : value
          );
        }
      } else {
        for (const p of providers) {
          if (p.type == Provider.Static) {
            address[p.id] = (staticValues.length << 1) | 1;
            staticValues.push(p.value);
          } else {
            address[p.id] = dynamicSlots.length << 1;
            dynamicSlots.push((a) => p.dynamicSlot(a));
          }
        }

        address[facet.id] = dynamicSlots.length << 1;
        dynamicSlots.push((a) => dynamicFacetSlot(a, facet, providers));
      }
    }

    const dynamic = dynamicSlots.map((f) => f(address));
    return new Configuration(base, newCompartments, dynamic, address, staticValues, facets);
  }
}

/** 扁平化，按 default 优先级排序 */
function flatten(
  extension: Extension,
  compartments: Map<Compartment, Extension>,
  newCompartments: Map<Compartment, Extension>
) {
  /** 结果数据 */
  const result: (FacetProvider<any> | StateField<any>)[][] = [[], [], [], [], []];

  /** 暂存 */
  const seen = new Map<Extension, number>();

  function inner(ext: Extension, prec: number) {
    /** 缓存获取扩展优先级 */
    const known = seen.get(ext);

    if (known != null) {
      if (known <= prec) {
        return;
      }

      const found = result[known].indexOf(ext as any);

      if (found > -1) {
        result[known].splice(found, 1);
      }

      if (ext instanceof CompartmentInstance) {
        newCompartments.delete(ext.compartment);
      }
    }

    seen.set(ext, prec);

    if (Array.isArray(ext)) {
      for (const e of ext) {
        inner(e, prec);
      }
    } else if (ext instanceof CompartmentInstance) {
      if (newCompartments.has(ext.compartment)) {
        throw new RangeError(`Duplicate use of compartment in extensions`);
      }

      const content = compartments.get(ext.compartment) || ext.inner;
      newCompartments.set(ext.compartment, content);

      inner(content, prec);
    } else if (ext instanceof PrecExtension) {
      inner(ext.inner, ext.prec);
    } else if (ext instanceof StateField) {
      result[prec].push(ext);

      if (ext.provides) {
        inner(ext.provides, prec);
      }
    } else if (ext instanceof FacetProvider) {
      result[prec].push(ext);

      if (ext.facet.extensions) {
        inner(ext.facet.extensions, Prec_.default);
      }
    } else {
      const content = (ext as any).extension;

      if (!content) {
        throw new Error(
          `Unrecognized extension value in extension set (${ext}). This sometimes happens because multiple instances of @/state/index are loaded, breaking instanceof checks.`
        );
      }

      inner(content, prec);
    }
  }

  inner(extension, Prec_.default);

  return result.reduce((a, b) => a.concat(b));
}

export const enum SlotStatus {
  Unresolved = 0,
  Changed = 1,
  Computed = 2,
  Computing = 4,
}

export function ensureAddr(state: EditorState, addr: number) {
  if (addr & 1) return SlotStatus.Computed;
  const idx = addr >> 1;
  const status = state.status[idx];
  if (status == SlotStatus.Computing)
    throw new Error("Cyclic dependency between fields and/or facets");
  if (status & SlotStatus.Computed) return status;
  state.status[idx] = SlotStatus.Computing;
  const changed = state.computeSlot!(state, state.config.dynamicSlots[idx]);
  return (state.status[idx] = SlotStatus.Computed | changed);
}

export function getAddr(state: EditorState, addr: number) {
  return addr & 1 ? state.config.staticValues[addr >> 1] : state.values[addr >> 1];
}
