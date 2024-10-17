import styles from "./App.module.css";
import { onBeforeInput, onCopy, onCut, onKeydown, onPaste } from "./markdown";

const App: React.FC = () => {
  return (
    <div
      className={styles.editor}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBeforeInput={onBeforeInput}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
      onKeyDown={onKeydown}
    >
      sdfsdafsdafsadfsdaf
    </div>
  );
};

export default App;
