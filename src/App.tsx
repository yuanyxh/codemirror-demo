import { minimalSetup, EditorView } from "@/basic-setup/codemirror";
import { useEffect, useRef } from "react";
import {
  placeholder,
  crosshairCursor,
  rectangularSelection,
  dropCursor,
  scrollPastEnd,
  highlightActiveLine,
  lineNumbers,
  gutter,
  highlightActiveLineGutter,
  // highlightSpecialChars,
  // keymap,
} from "@/view/index";
// import { indentWithTab } from "@/commands/commands";
import styles from "./App.module.css";

/**
 * 可用的预定义扩展或相关工具
 *
 * ViewPlugin 用于定义视图插件
 * Decoration 装饰器的抽象类
 * WidgetType 小部件装饰器的抽象类
 * keymap 按键绑定的 Facet
 * drawSelection 绘制选区的扩展函数
 * dropCursor 拖拽时在当前位置绘制光标的扩展函数
 * highlightSpecialChars 高亮特殊字符的扩展函数
 * scrollPastEnd 确保每行都能滚动到顶部的扩展函数
 * highlightActiveLine 高亮当前活动行的扩展函数
 * placeholder 空编辑器时展示的占位符扩展函数
 * layer 生成图层视图的扩展函数
 * rectangularSelection 矩形选区的扩展函数
 * crosshairCursor 十字光标的扩展函数
 * showTooltip tooltip 相关的 Facet
 * tooltips 工具栏的扩展函数
 * hoverTooltip hover 工具栏的扩展函数
 * showPanel 面板的 Facet
 * panels 面板的扩展函数
 * lineNumbers 行号的扩展函数
 * highlightActiveLineGutter 高亮活动行的行号的扩展函数
 * gutter 行号扩展函数
 * gutters 行号扩展函数
 * GutterMarker 行号标记类
 * gutterLineClass 行号标记类
 * gutterWidgetClass 行号标记类
 * lineNumberMarkers 行号标记类
 * lineNumberWidgetMarker 行号标记类
 * highlightWhitespace 高亮空白的扩展函数
 * highlightTrailingWhitespace 高亮尾随空白的扩展函数
 */

function App() {
  const divRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();

  useEffect(() => {
    viewRef.current = new EditorView({
      doc: "Hello\n\n```javascript\nlet x = 'y'\n```\t",
      extensions: [
        minimalSetup,
        placeholder("aiyouniganma"),
        crosshairCursor({ key: "Control" }),
        scrollPastEnd(),
        dropCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        lineNumbers(),
        gutter({}),
        rectangularSelection({
          // eventFilter(event) {
          //   return true;
          // },
        }),
        // keymap.of([indentWithTab]),
        // highlightSpecialChars({ addSpecialChars: /\t/ }),
        // EditorView.lineWrapping,
      ],
      // extensions: [basicSetup, markdown({ codeLanguages: languages })],
      parent: divRef.current!,
    });

    return () => {
      viewRef.current?.destroy();
    };
  }, []);

  return (
    <div className={styles.container}>
      <div ref={divRef} className={styles.editor}></div>
    </div>
  );
}

export default App;
