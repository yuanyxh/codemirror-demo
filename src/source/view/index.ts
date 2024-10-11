export { EditorView } from "./editorview";
export type { EditorViewConfig, DOMEventMap, DOMEventHandlers } from "./editorview";
export { ViewPlugin, logException } from "./extension";
export type { Command, PluginValue, ViewUpdate, PluginSpec } from "./extension";
export { Decoration, WidgetType, BlockType } from "./decorations/decoration";
export type { DecorationSet } from "./decorations/decoration";
export { BlockInfo } from "./heightmap";
export type { MouseSelectionStyle } from "./input";
export { BidiSpan, Direction } from "./bidi";
export { keymap, runScopeHandlers } from "./keymap";
export type { KeyBinding } from "./keymap";
export { drawSelection, getDrawSelectionConfig } from "./draw-selection";
export { dropCursor } from "./dropcursor";
export { highlightSpecialChars } from "./special-chars";
export { scrollPastEnd } from "./scrollpastend";
export { highlightActiveLine } from "./decorations/active-line";
export { placeholder } from "./placeholder";
export type { Rect } from "./dom";
export { layer, RectangleMarker } from "./layer";
export type { LayerMarker } from "./layer";
export { MatchDecorator } from "./matchdecorator";
export { rectangularSelection, crosshairCursor } from "./rectangular-selection";
export {
  showTooltip,
  tooltips,
  getTooltip,
  hoverTooltip,
  hasHoverTooltips,
  closeHoverTooltips,
  repositionTooltips,
} from "./tooltip";
export type { Tooltip, TooltipView, HoverTooltipSource } from "./tooltip";
export { showPanel, getPanel, panels } from "./panel";
export type { PanelConstructor, Panel } from "./panel";
export {
  lineNumbers,
  highlightActiveLineGutter,
  gutter,
  gutters,
  GutterMarker,
  gutterLineClass,
  gutterWidgetClass,
  lineNumberMarkers,
  lineNumberWidgetMarker,
} from "./gutter";
export { highlightWhitespace, highlightTrailingWhitespace } from "./highlight-space";

import {
  HeightMap,
  HeightOracle,
  MeasuredHeights,
  QueryType,
  clearHeightChangeFlag,
  heightChangeFlag,
} from "./heightmap";
import { ChangedRange } from "./extension";
import { computeOrder, moveVisually } from "./bidi";
/// @internal
export const __test = {
  HeightMap,
  HeightOracle,
  MeasuredHeights,
  QueryType,
  ChangedRange,
  computeOrder,
  moveVisually,
  clearHeightChangeFlag,
  getHeightChangeFlag: () => heightChangeFlag,
};
