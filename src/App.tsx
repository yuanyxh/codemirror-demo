import { basicSetup, EditorView } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { useEffect, useRef } from "react";
import styles from "./App.module.css";

function App() {
  const divRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();

  useEffect(() => {
    viewRef.current = new EditorView({
      doc: "Hello\n\n```javascript\nlet x = 'y'\n```",
      extensions: [basicSetup, markdown({ codeLanguages: languages })],
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
