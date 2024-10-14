export { EditorView } from "./editorview";
export type { EditorViewConfig, DOMEventMap, DOMEventHandlers } from "./editorview";
export { ViewPlugin, logException } from "./extensions/extension";
export type { Command, PluginValue, ViewUpdate, PluginSpec } from "./extensions/extension";
export { Decoration, WidgetType, BlockType } from "./decorations/decoration";
export type { DecorationSet } from "./decorations/decoration";
export { BlockInfo } from "./utils/heightmap";
export type { MouseSelectionStyle } from "./utils/input";
export { BidiSpan, Direction } from "./utils/bidi";
export { keymap, runScopeHandlers } from "./extensions/keymap";
export type { KeyBinding } from "./extensions/keymap";
export { drawSelection, getDrawSelectionConfig } from "./extensions/draw-selection";
export { dropCursor } from "./extensions/dropcursor";
export { highlightSpecialChars } from "./extensions/special-chars";
export { scrollPastEnd } from "./extensions/scrollpastend";
export { highlightActiveLine } from "./decorations/active-line";
export { placeholder } from "./extensions/placeholder";
export type { Rect } from "./utils/dom";
export { layer, RectangleMarker } from "./extensions/layer";
export type { LayerMarker } from "./extensions/layer";
export { MatchDecorator } from "./utils/matchdecorator";
export { rectangularSelection, crosshairCursor } from "./extensions/rectangular-selection";
export {
  showTooltip,
  tooltips,
  getTooltip,
  hoverTooltip,
  hasHoverTooltips,
  closeHoverTooltips,
  repositionTooltips,
} from "./extensions/tooltip";
export type { Tooltip, TooltipView, HoverTooltipSource } from "./extensions/tooltip";
export { showPanel, getPanel, panels } from "./extensions/panel";
export type { PanelConstructor, Panel } from "./extensions/panel";
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
} from "./extensions/gutter";
export { highlightWhitespace, highlightTrailingWhitespace } from "./decorations/highlight-space";

import {
  HeightMap,
  HeightOracle,
  MeasuredHeights,
  QueryType,
  clearHeightChangeFlag,
  heightChangeFlag,
} from "./utils/heightmap";
import { ChangedRange } from "./extensions/extension";
import { computeOrder, moveVisually } from "./utils/bidi";

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
