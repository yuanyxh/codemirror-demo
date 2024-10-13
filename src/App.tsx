import { minimalSetup, EditorView } from "@/basic-setup/codemirror";
import { useEffect, useRef } from "react";
import {
  placeholder,
  crosshairCursor,
  rectangularSelection,
  // highlightSpecialChars,
  // keymap,
} from "@/view/index";
// import { indentWithTab } from "@/commands/commands";
import styles from "./App.module.css";

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
        rectangularSelection({
          // eventFilter(event) {
          //   return true;
          // },
        }),
        // keymap.of([indentWithTab]),
        // highlightSpecialChars({ addSpecialChars: /\t/ }),
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
