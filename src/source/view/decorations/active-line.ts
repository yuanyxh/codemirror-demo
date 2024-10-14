import { Extension } from "@/state/index";
import { EditorView } from "../editorview";
import { ViewPlugin, ViewUpdate } from "../extensions/extension";
import { Decoration, DecorationSet } from "./decoration";

/** 高亮光标所在行工具 */

/**
 * 使用 “cm-activeLine” 类标记光标所在的行
 */
export function highlightActiveLine(): Extension {
  return activeLineHighlighter;
}

const lineDeco = Decoration.line({ class: "cm-activeLine" });

const activeLineHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.getDeco(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.getDeco(update.view);
      }
    }

    getDeco(view: EditorView) {
      let lastLineStart = -1;

      const deco = [];
      for (const r of view.state.selection.ranges) {
        const line = view.lineBlockAt(r.head);

        if (line.from > lastLineStart) {
          deco.push(lineDeco.range(line.from));

          lastLineStart = line.from;
        }
      }

      return Decoration.set(deco);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
