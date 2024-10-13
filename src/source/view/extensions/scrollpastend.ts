import { Extension } from "@/state/index";
import { ViewPlugin, ViewUpdate, contentAttributes } from "./extension";

/** 确保文档每行可滚动到编辑器顶部的扩展 */

const plugin = ViewPlugin.fromClass(
  class {
    height = 1000;
    attrs = { style: "padding-bottom: 1000px" };

    update(update: ViewUpdate) {
      const { view } = update;

      const height =
        view.viewState.editorHeight - view.defaultLineHeight - view.documentPadding.top - 0.5;

      if (height >= 0 && height != this.height) {
        this.height = height;
        this.attrs = { style: `padding-bottom: ${height}px` };
      }
    }
  }
);

/**
 * 返回一个扩展，确保内容的下边距等于编辑器的高度减去行高，以便文档中的每一行都可以滚动到编辑器的顶部
 * 仅当编辑器可滚动时这才有意义，并且不应在采用其内容大小的编辑器中启用
 */
export function scrollPastEnd(): Extension {
  return [plugin, contentAttributes.of((view) => view.plugin(plugin)?.attrs || null)];
}
