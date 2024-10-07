import {ChangeDesc} from "./change"

// A range's flags field is used like this:
// - 2 bits for bidi level (3 means unset) (only meaningful for
//   cursors)
// - 2 bits to indicate the side the cursor is associated with (only
//   for cursors)
// - 1 bit to indicate whether the range is inverted (head before
//   anchor) (only meaningful for non-empty ranges)
// - Any further bits hold the goal column (only for ranges
//   produced by vertical motion)
const enum RangeFlag {
  BidiLevelMask = 7,
  AssocBefore = 8,
  AssocAfter = 16,
  Inverted = 32,
  GoalColumnOffset = 6,
  NoGoalColumn = 0xffffff
}
  
/// A single selection range. When
/// [`allowMultipleSelections`](#state.EditorState^allowMultipleSelections)
/// is enabled, a [selection](#state.EditorSelection) may hold
/// multiple ranges. By default, selections hold exactly one range.
export class SelectionRange {
  private constructor(
    /// The lower boundary of the range.
    readonly from: number,
    /// The upper boundary of the range.
    readonly to: number,
    private flags: number
  ) {}

  /// The anchor of the range—the side that doesn't move when you
  /// extend it.
  get anchor() { return this.flags & RangeFlag.Inverted ? this.to : this.from }

  /// The head of the range, which is moved when the range is
  /// [extended](#state.SelectionRange.extend).
  get head() { return this.flags & RangeFlag.Inverted ? this.from : this.to }

  /// True when `anchor` and `head` are at the same position.
  get empty(): boolean { return this.from == this.to }

  /// If this is a cursor that is explicitly associated with the
  /// character on one of its sides, this returns the side. -1 means
  /// the character before its position, 1 the character after, and 0
  /// means no association.
  get assoc(): -1 | 0 | 1 { return this.flags & RangeFlag.AssocBefore ? -1 : this.flags & RangeFlag.AssocAfter ? 1 : 0 }

  /// The bidirectional text level associated with this cursor, if
  /// any.
  get bidiLevel(): number | null {
    const level = this.flags & RangeFlag.BidiLevelMask
    return level == 7 ? null : level
  }

  /// The goal column (stored vertical offset) associated with a
  /// cursor. This is used to preserve the vertical position when
  /// [moving](#view.EditorView.moveVertically) across
  /// lines of different length.
  get goalColumn() {
    const value = this.flags >> RangeFlag.GoalColumnOffset
    return value == RangeFlag.NoGoalColumn ? undefined : value
  }

  /// Map this range through a change, producing a valid range in the
  /// updated document.
  map(change: ChangeDesc, assoc = -1): SelectionRange {
    let from, to
    if (this.empty) {
      from = to = change.mapPos(this.from, assoc)
    } else {
      from = change.mapPos(this.from, 1)
      to = change.mapPos(this.to, -1)
    }
    return from == this.from && to == this.to ? this : new SelectionRange(from, to, this.flags)
  }

  /// Extend this range to cover at least `from` to `to`.
  extend(from: number, to: number = from) {
    if (from <= this.anchor && to >= this.anchor) return EditorSelection.range(from, to)
    const head = Math.abs(from - this.anchor) > Math.abs(to - this.anchor) ? from : to
    return EditorSelection.range(this.anchor, head)
  }

  /// Compare this range to another range.
  eq(other: SelectionRange, includeAssoc = false): boolean {
    return this.anchor == other.anchor && this.head == other.head &&
      (!includeAssoc || !this.empty || this.assoc == other.assoc)
  }

  /// Return a JSON-serializable object representing the range.
  toJSON(): any { return {anchor: this.anchor, head: this.head} }

  /// Convert a JSON representation of a range to a `SelectionRange`
  /// instance.
  static fromJSON(json: any): SelectionRange {
    if (!json || typeof json.anchor != "number" || typeof json.head != "number")
      throw new RangeError("Invalid JSON representation for SelectionRange")
    return EditorSelection.range(json.anchor, json.head)
  }

  /// @internal
  static create(from: number, to: number, flags: number) {
    return new SelectionRange(from, to, flags)
  }
}

/// An editor selection holds one or more selection ranges.
export class EditorSelection {
  private constructor(
    /// The ranges in the selection, sorted by position. Ranges cannot
    /// overlap (but they may touch, if they aren't empty).
    readonly ranges: readonly SelectionRange[],
    /// The index of the _main_ range in the selection (which is
    /// usually the range that was added last).
    readonly mainIndex: number
  ) {}

  /// Map a selection through a change. Used to adjust the selection
  /// position for changes.
  map(change: ChangeDesc, assoc = -1): EditorSelection {
    if (change.empty) return this
    return EditorSelection.create(this.ranges.map(r => r.map(change, assoc)), this.mainIndex)
  }

  /// Compare this selection to another selection. By default, ranges
  /// are compared only by position. When `includeAssoc` is true,
  /// cursor ranges must also have the same
  /// [`assoc`](#state.SelectionRange.assoc) value.
  eq(other: EditorSelection, includeAssoc = false): boolean {
    if (this.ranges.length != other.ranges.length ||
        this.mainIndex != other.mainIndex) return false
    for (let i = 0; i < this.ranges.length; i++)
      if (!this.ranges[i].eq(other.ranges[i], includeAssoc)) return false
    return true
  }

  /// Get the primary selection range. Usually, you should make sure
  /// your code applies to _all_ ranges, by using methods like
  /// [`changeByRange`](#state.EditorState.changeByRange).
  get main(): SelectionRange { return this.ranges[this.mainIndex] }

  /// Make sure the selection only has one range. Returns a selection
  /// holding only the main range from this selection.
  asSingle() {
    return this.ranges.length == 1 ? this : new EditorSelection([this.main], 0)
  }

  /// Extend this selection with an extra range.
  addRange(range: SelectionRange, main: boolean = true) {
    return EditorSelection.create([range].concat(this.ranges), main ? 0 : this.mainIndex + 1)
  }

  /// Replace a given range with another range, and then normalize the
  /// selection to merge and sort ranges if necessary.
  replaceRange(range: SelectionRange, which: number = this.mainIndex) {
    const ranges = this.ranges.slice()
    ranges[which] = range
    return EditorSelection.create(ranges, this.mainIndex)
  }

  /// Convert this selection to an object that can be serialized to
  /// JSON.
  toJSON(): any {
    return {ranges: this.ranges.map(r => r.toJSON()), main: this.mainIndex}
  }

  /// Create a selection from a JSON representation.
  static fromJSON(json: any): EditorSelection {
    if (!json || !Array.isArray(json.ranges) || typeof json.main != "number" || json.main >= json.ranges.length)
      throw new RangeError("Invalid JSON representation for EditorSelection")
    return new EditorSelection(json.ranges.map((r: any) => SelectionRange.fromJSON(r)), json.main)
  }

  /// Create a selection holding a single range.
  static single(anchor: number, head: number = anchor) {
    return new EditorSelection([EditorSelection.range(anchor, head)], 0)
  }

  /// Sort and merge the given set of ranges, creating a valid
  /// selection.
  static create(ranges: readonly SelectionRange[], mainIndex: number = 0) {
    if (ranges.length == 0) throw new RangeError("A selection needs at least one range")
    for (let pos = 0, i = 0; i < ranges.length; i++) {
      const range = ranges[i]
      if (range.empty ? range.from <= pos : range.from < pos) return EditorSelection.normalized(ranges.slice(), mainIndex)
      pos = range.to
    }
    return new EditorSelection(ranges, mainIndex)
  }

  /// Create a cursor selection range at the given position. You can
  /// safely ignore the optional arguments in most situations.
  static cursor(pos: number, assoc = 0, bidiLevel?: number, goalColumn?: number) {
    return SelectionRange.create(
      pos, pos, (assoc == 0 ? 0 : assoc < 0 ? RangeFlag.AssocBefore : RangeFlag.AssocAfter) |
      (bidiLevel == null ? 7 : Math.min(6, bidiLevel)) |
      ((goalColumn ?? RangeFlag.NoGoalColumn) << RangeFlag.GoalColumnOffset))
  }

  /// Create a selection range.
  static range(anchor: number, head: number, goalColumn?: number, bidiLevel?: number) {
    const flags = ((goalColumn ?? RangeFlag.NoGoalColumn) << RangeFlag.GoalColumnOffset) |
      (bidiLevel == null ? 7 : Math.min(6, bidiLevel))
    return head < anchor ? SelectionRange.create(head, anchor, RangeFlag.Inverted | RangeFlag.AssocAfter | flags)
      : SelectionRange.create(anchor, head, (head > anchor ? RangeFlag.AssocBefore : 0) | flags)
  }

  /// @internal
  static normalized(ranges: SelectionRange[], mainIndex: number = 0): EditorSelection {
    const main = ranges[mainIndex]
    ranges.sort((a, b) => a.from - b.from)
    mainIndex = ranges.indexOf(main)
    for (let i = 1; i < ranges.length; i++) {
      const range = ranges[i], prev = ranges[i - 1]
      if (range.empty ? range.from <= prev.to : range.from < prev.to) {
        const from = prev.from, to = Math.max(range.to, prev.to)
        if (i <= mainIndex) mainIndex--
        ranges.splice(--i, 2, range.anchor > range.head ? EditorSelection.range(to, from) : EditorSelection.range(from, to))
      }
    }
    return new EditorSelection(ranges, mainIndex)
  }
}

export function checkSelection(selection: EditorSelection, docLength: number) {
  for (const range of selection.ranges)
    if (range.to > docLength) throw new RangeError("Selection points outside of document")
}
