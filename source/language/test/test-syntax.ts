import ist from "ist"
import {getIndentUnit, indentString, indentUnit, ParseContext} from "@codemirror/language"
import {EditorState, ChangeSet, Text} from "@codemirror/state"
import {parser} from "@lezer/javascript"

let lines = `const {readFile} = require("fs");
readFile("package.json", "utf8", (err, data) => {
  console.log(data);
});
`.split("\n")
for (let l0 = lines.length, i = l0; i < 5000; i++) lines[i] = lines[i % l0]
let doc = Text.of(lines)

function pContext(doc: Text) {
  return ParseContext.create(parser, EditorState.create({doc}), {from: 0, to: doc.length})
}

describe("ParseContext", () => {
  it("can parse a document", () => {
    let cx = pContext(Text.of(["let x = 10"]))
    cx.work(1e8)
    ist(cx.tree.toString(), "Script(VariableDeclaration(let,VariableDefinition,Equals,Number))")
  })

  it("can parse incrementally", () => {
    let cx = pContext(doc), t0 = Date.now()
    if (cx.work(10)) {
      console.warn("Machine too fast for the incremental parsing test, skipping")
      return
    }
    ist(Date.now() - t0, 25, "<")
    ist(cx.work(1e8))
    ist(cx.tree.length, doc.length)
    let change = ChangeSet.of({from: 0, to: 5, insert: "let"}, doc.length)
    let newDoc = change.apply(doc)
    cx = cx.changes(change, EditorState.create({doc: newDoc}))
    ist(cx.work(50))
    ist(cx.tree.length, newDoc.length)
    ist(cx.tree.toString().slice(0, 31), "Script(VariableDeclaration(let,")
  })
})

describe("Indentation", () => {
  it("tracks indent units", () => {
    let s0 = EditorState.create({})
    ist(getIndentUnit(s0), 2)
    ist(indentString(s0, 4), "    ")
    let s1 = EditorState.create({extensions: indentUnit.of("   ")})
    ist(getIndentUnit(s1), 3)
    ist(indentString(s1, 4), "    ")
    let s2 = EditorState.create({extensions: [indentUnit.of("\t"), EditorState.tabSize.of(8)]})
    ist(getIndentUnit(s2), 8)
    ist(indentString(s2, 16), "\t\t")
    let s3 = EditorState.create({extensions: indentUnit.of("　")})
    ist(getIndentUnit(s3), 1)
    ist(indentString(s3, 2), "　　")
  })

  it("errors for bad indent units", () => {
    ist.throws(() => EditorState.create({extensions: indentUnit.of("")}), /Invalid indent unit/)
    ist.throws(() => EditorState.create({extensions: indentUnit.of("\t ")}), /Invalid indent unit/)
    ist.throws(() => EditorState.create({extensions: indentUnit.of("hello")}), /Invalid indent unit/)
  })
})
