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
  keymap,
  // MatchDecorator,
  // ViewPlugin,
  // Decoration,
} from "@/view/index";
// import { indentWithTab } from "@/commands/commands";
import styles from "./App.module.css";
import { EditorState, Prec, Facet /* Extension */, StateField, StateEffect } from "@/state/index";
// import { insertTab } from "@/commands/commands";

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
 * EditorView.scrollIntoView 滚动位置的 StateEffect 函数
 * EditorView.styleModule 样式模块的 StateEffect
 * EditorView.domEventHandlers 注册 dom 事件的 ViewPlugin
 * EditorView.domEventObservers 注册事件侦听的 ViewPlugin
 * EditorView.inputHandler 输入处理的 Facet，可以通过他覆盖默认的输入行为
 * EditorView.clipboardInputFilter 剪切板输入的 Facet
 * EditorView.clipboardOutputFilter 剪切板输出的 Facet
 * EditorView.scrollHandler 滚动事件的 Facet
 * EditorView.focusChangeEffect 焦点变化的 Facet
 * EditorView.perLineTextDirection 设置每行的文本方向的 Facet
 * EditorView.exceptionSink 从生命周期中捕获异常的 Facet
 * EditorView.updateListener 文档更新事件的 Facet
 * EditorView.editable 是否可编辑的 Facet
 * EditorView.mouseSelectionStyle 鼠标选区的样式 Facet
 * EditorView.dragMovesSelection 是否应该拖动选区的 Facet
 * EditorView.clickAddsSelectionRange 点击添加选区的 Facet
 * EditorView.decorations 装饰器的 Facet
 * EditorView.outerDecorations 优先级低的装饰器 Facet
 * EditorView.atomicRanges 原子范围的 Facet
 * EditorView.bidiIsolatedRanges
 * EditorView.scrollMargins 提供额外的 margin 的 Facet
 * EditorView.theme 主题插件函数
 * EditorView.darkTheme 是否启用 dark 主题
 * EditorView.baseTheme 添加样式到基础主题的扩展函数
 * EditorView.cspNonce
 * EditorView.contentAttributes 可编辑 dom 的属性 Facet
 * EditorView.editorAttributes 编辑器容器的 属性 Facet
 * EditorView.lineWrapping
 * EditorView.announce
 * EditorState.allowMultipleSelections 允许多选的 Facet
 * EditorState.tabSize tab 缩进的 Facet
 * EditorState.lineSeparator 换行符的 Facet
 * EditorState.readOnly 编辑器的只读 Facet
 * EditorState.phrases 注册短语的 Facet
 * EditorState.languageData 注册语言的 Facet
 * EditorState.changeFilter 注册更新时的过滤器 Facet, 让允许的更新通过
 * EditorState.transactionFilter
 * EditorState.transactionExtender
 */

const test = Facet.define<boolean>();
const effectDefine = StateEffect.define<string>();
const test2 = StateField.define<string>({
  create(_state) {
    return "";
  },
  update(_value, transaction) {
    for (let i = 0; i < transaction.effects.length; i++) {
      const effect = transaction.effects[i];

      if (effect.is(effectDefine)) {
        console.log(effect.value);

        return effect.value;
      }
    }

    return "no";
  },
});

// function matcher(decorator: MatchDecorator): Extension {
//   return ViewPlugin.define(
//     (view) => ({
//       decorations: decorator.createDeco(view),
//       update(u): void {
//         this.decorations = decorator.updateDeco(u, this.decorations);
//       },
//     }),
//     {
//       decorations: (v) => v.decorations,
//     }
//   );
// }

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

        // matcher(
        //   new MatchDecorator({
        //     regexp: /#\s.*/g,
        //     decoration: (match) => {
        //       console.log(match);

        //       return Decoration.mark({ class: "yellow" });
        //     },
        //     boundary: /\S/,
        //   })
        // ),
        highlightActiveLine(),
        EditorState.readOnly.of(false),
        EditorView.updateListener.of((viewUpdate) => {
          console.log(viewUpdate);
        }),
        Prec.high(
          keymap.of([
            {
              key: "Tab",
              run(v) {
                console.log(v);

                return true;
              },
              // preventDefault: true,
            },
          ])
        ),
        test2,
        test.compute([], (v) => {
          console.log("00xx", v);

          return false;
        }),
        EditorView.editable.of(true),
        highlightActiveLineGutter(),
        EditorView.clipboardOutputFilter.of((text, _state) => {
          console.log(text);

          return "你是🐷吧";
        }),

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

    viewRef.current.dispatch({ effects: effectDefine.of("heiwahaha") });

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
