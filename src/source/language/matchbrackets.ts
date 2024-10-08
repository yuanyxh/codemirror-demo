import { combineConfig, EditorState, Facet, StateField, Extension, Range } from "@/state/index";
import { syntaxTree } from "./language";
import { EditorView, Decoration, DecorationSet } from "@/view/index";
import { Tree, SyntaxNode, SyntaxNodeRef, NodeType, NodeProp } from "@lezer/common";

export interface Config {
  /// Whether the bracket matching should look at the character after
  /// the cursor when matching (if the one before isn't a bracket).
  /// Defaults to true.
  afterCursor?: boolean;
  /// The bracket characters to match, as a string of pairs. Defaults
  /// to `"()[]{}"`. Note that these are only used as fallback when
  /// there is no [matching
  /// information](https://lezer.codemirror.net/docs/ref/#common.NodeProp^closedBy)
  /// in the syntax tree.
  brackets?: string;
  /// The maximum distance to scan for matching brackets. This is only
  /// relevant for brackets not encoded in the syntax tree. Defaults
  /// to 10 000.
  maxScanDistance?: number;
  /// Can be used to configure the way in which brackets are
  /// decorated. The default behavior is to add the
  /// `cm-matchingBracket` class for matching pairs, and
  /// `cm-nonmatchingBracket` for mismatched pairs or single brackets.
  renderMatch?: (match: MatchResult, state: EditorState) => readonly Range<Decoration>[];
}

const baseTheme = EditorView.baseTheme({
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "#328c8252" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "#bb555544" },
});

const DefaultScanDist = 10000,
  DefaultBrackets = "()[]{}";

const bracketMatchingConfig = Facet.define<Config, Required<Config>>({
  combine(configs) {
    return combineConfig(configs, {
      afterCursor: true,
      brackets: DefaultBrackets,
      maxScanDistance: DefaultScanDist,
      renderMatch: defaultRenderMatch,
    });
  },
});

const matchingMark = Decoration.mark({ class: "cm-matchingBracket" }),
  nonmatchingMark = Decoration.mark({ class: "cm-nonmatchingBracket" });

function defaultRenderMatch(match: MatchResult) {
  const decorations = [];
  const mark = match.matched ? matchingMark : nonmatchingMark;
  decorations.push(mark.range(match.start.from, match.start.to));
  if (match.end) decorations.push(mark.range(match.end.from, match.end.to));
  return decorations;
}

const bracketMatchingState = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    if (!tr.docChanged && !tr.selection) return deco;
    let decorations: Range<Decoration>[] = [];
    const config = tr.state.facet(bracketMatchingConfig);
    for (const range of tr.state.selection.ranges) {
      if (!range.empty) continue;
      const match =
        matchBrackets(tr.state, range.head, -1, config) ||
        (range.head > 0 && matchBrackets(tr.state, range.head - 1, 1, config)) ||
        (config.afterCursor &&
          (matchBrackets(tr.state, range.head, 1, config) ||
            (range.head < tr.state.doc.length &&
              matchBrackets(tr.state, range.head + 1, -1, config))));
      if (match) decorations = decorations.concat(config.renderMatch(match, tr.state));
    }
    return Decoration.set(decorations, true);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const bracketMatchingUnique = [bracketMatchingState, baseTheme];

/// Create an extension that enables bracket matching. Whenever the
/// cursor is next to a bracket, that bracket and the one it matches
/// are highlighted. Or, when no matching bracket is found, another
/// highlighting style is used to indicate this.
export function bracketMatching(config: Config = {}): Extension {
  return [bracketMatchingConfig.of(config), bracketMatchingUnique];
}

/// When larger syntax nodes, such as HTML tags, are marked as
/// opening/closing, it can be a bit messy to treat the whole node as
/// a matchable bracket. This node prop allows you to define, for such
/// a node, a ‘handle’—the part of the node that is highlighted, and
/// that the cursor must be on to activate highlighting in the first
/// place.
export const bracketMatchingHandle = new NodeProp<(node: SyntaxNode) => SyntaxNode | null>();

function matchingNodes(node: NodeType, dir: -1 | 1, brackets: string): null | readonly string[] {
  const byProp = node.prop(dir < 0 ? NodeProp.openedBy : NodeProp.closedBy);
  if (byProp) return byProp;
  if (node.name.length == 1) {
    const index = brackets.indexOf(node.name);
    if (index > -1 && index % 2 == (dir < 0 ? 1 : 0)) return [brackets[index + dir]];
  }
  return null;
}

/// The result returned from `matchBrackets`.
export interface MatchResult {
  /// The extent of the bracket token found.
  start: { from: number; to: number };
  /// The extent of the matched token, if any was found.
  end?: { from: number; to: number };
  /// Whether the tokens match. This can be false even when `end` has
  /// a value, if that token doesn't match the opening token.
  matched: boolean;
}

function findHandle(node: SyntaxNodeRef) {
  const hasHandle = node.type.prop(bracketMatchingHandle);
  return hasHandle ? hasHandle(node.node) : node;
}

/// Find the matching bracket for the token at `pos`, scanning
/// direction `dir`. Only the `brackets` and `maxScanDistance`
/// properties are used from `config`, if given. Returns null if no
/// bracket was found at `pos`, or a match result otherwise.
export function matchBrackets(
  state: EditorState,
  pos: number,
  dir: -1 | 1,
  config: Config = {}
): MatchResult | null {
  const maxScanDistance = config.maxScanDistance || DefaultScanDist,
    brackets = config.brackets || DefaultBrackets;
  const tree = syntaxTree(state),
    node = tree.resolveInner(pos, dir);
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    const matches = matchingNodes(cur.type, dir, brackets);
    if (matches && cur.from < cur.to) {
      const handle = findHandle(cur);
      if (
        handle &&
        (dir > 0 ? pos >= handle.from && pos < handle.to : pos > handle.from && pos <= handle.to)
      )
        return matchMarkedBrackets(state, pos, dir, cur, handle, matches, brackets);
    }
  }
  return matchPlainBrackets(state, pos, dir, tree, node.type, maxScanDistance, brackets);
}

function matchMarkedBrackets(
  _state: EditorState,
  _pos: number,
  dir: -1 | 1,
  token: SyntaxNode,
  handle: SyntaxNodeRef,
  matching: readonly string[],
  brackets: string
) {
  const parent = token.parent,
    firstToken = { from: handle.from, to: handle.to };
  let depth = 0;
  const cursor = parent?.cursor();
  if (cursor && (dir < 0 ? cursor.childBefore(token.from) : cursor.childAfter(token.to)))
    do {
      if (dir < 0 ? cursor.to <= token.from : cursor.from >= token.to) {
        if (depth == 0 && matching.indexOf(cursor.type.name) > -1 && cursor.from < cursor.to) {
          const endHandle = findHandle(cursor);
          return {
            start: firstToken,
            end: endHandle ? { from: endHandle.from, to: endHandle.to } : undefined,
            matched: true,
          };
        } else if (matchingNodes(cursor.type, dir, brackets)) {
          depth++;
        } else if (matchingNodes(cursor.type, -dir as -1 | 1, brackets)) {
          if (depth == 0) {
            const endHandle = findHandle(cursor);
            return {
              start: firstToken,
              end:
                endHandle && endHandle.from < endHandle.to
                  ? { from: endHandle.from, to: endHandle.to }
                  : undefined,
              matched: false,
            };
          }
          depth--;
        }
      }
    } while (dir < 0 ? cursor.prevSibling() : cursor.nextSibling());
  return { start: firstToken, matched: false };
}

function matchPlainBrackets(
  state: EditorState,
  pos: number,
  dir: number,
  tree: Tree,
  tokenType: NodeType,
  maxScanDistance: number,
  brackets: string
) {
  const startCh = dir < 0 ? state.sliceDoc(pos - 1, pos) : state.sliceDoc(pos, pos + 1);
  const bracket = brackets.indexOf(startCh);
  if (bracket < 0 || (bracket % 2 == 0) != dir > 0) return null;

  const startToken = { from: dir < 0 ? pos - 1 : pos, to: dir > 0 ? pos + 1 : pos };
  const iter = state.doc.iterRange(pos, dir > 0 ? state.doc.length : 0);
  let depth = 0;
  for (let distance = 0; !iter.next().done && distance <= maxScanDistance; ) {
    const text = iter.value;
    if (dir < 0) distance += text.length;
    const basePos = pos + distance * dir;
    for (
      let pos = dir > 0 ? 0 : text.length - 1, end = dir > 0 ? text.length : -1;
      pos != end;
      pos += dir
    ) {
      const found = brackets.indexOf(text[pos]);
      if (found < 0 || tree.resolveInner(basePos + pos, 1).type != tokenType) continue;
      if ((found % 2 == 0) == dir > 0) {
        depth++;
      } else if (depth == 1) {
        // Closing
        return {
          start: startToken,
          end: { from: basePos + pos, to: basePos + pos + 1 },
          matched: found >> 1 == bracket >> 1,
        };
      } else {
        depth--;
      }
    }
    if (dir > 0) distance += text.length;
  }
  return iter.done ? { start: startToken, matched: false } : null;
}
