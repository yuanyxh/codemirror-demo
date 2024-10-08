export {
  language,
  Language,
  LRLanguage,
  sublanguageProp,
  defineLanguageFacet,
  syntaxTree,
  ensureSyntaxTree,
  languageDataProp,
  ParseContext,
  LanguageSupport,
  LanguageDescription,
  syntaxTreeAvailable,
  syntaxParserRunning,
  forceParsing,
  DocInput,
} from "./language";
export type { Sublanguage } from "./language";

export {
  IndentContext,
  getIndentUnit,
  indentString,
  indentOnInput,
  indentService,
  getIndentation,
  indentRange,
  indentUnit,
  TreeIndentContext,
  indentNodeProp,
  delimitedIndent,
  continuedIndent,
  flatIndent,
} from "./indent";

export {
  foldService,
  foldNodeProp,
  foldInside,
  foldable,
  foldCode,
  unfoldCode,
  toggleFold,
  foldAll,
  unfoldAll,
  foldKeymap,
  codeFolding,
  foldGutter,
  foldedRanges,
  foldEffect,
  unfoldEffect,
  foldState,
} from "./fold";

export {
  HighlightStyle,
  syntaxHighlighting,
  highlightingFor,
  defaultHighlightStyle,
} from "./highlight";
export type { TagStyle } from "./highlight";

export { bracketMatching, matchBrackets, bracketMatchingHandle } from "./matchbrackets";
export type { Config, MatchResult } from "./matchbrackets";

export { StreamLanguage } from "./stream-parser";
export type { StreamParser } from "./stream-parser";

export { StringStream } from "./stringstream";

export { bidiIsolates } from "./isolate";
