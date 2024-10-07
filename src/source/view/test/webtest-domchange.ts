import {tempView} from "./tempview.js"
import {EditorState, StateField} from "@codemirror/state"
import {Decoration, DecorationSet, EditorView, WidgetType} from "@codemirror/view"
import ist from "ist"

function flush(cm: EditorView) {
  cm.observer.flush()
}

describe("DOM changes", () => {
  it("notices text changes", () => {
    const cm = tempView("foo\nbar")
    cm.domAtPos(1).node.nodeValue = "froo"
    flush(cm)
    ist(cm.state.doc.toString(), "froo\nbar")
  })

  it("handles browser enter behavior", () => {
    const cm = tempView("foo\nbar"), line0 = cm.contentDOM.firstChild!
    line0.appendChild(document.createElement("br"))
    line0.appendChild(document.createElement("br"))
    flush(cm)
    ist(cm.state.doc.toString(), "foo\n\nbar")
  })

  it("supports deleting lines", () => {
    const cm = tempView("1\n2\n3\n4\n5\n6")
    for (let i = 0, lineDOM = cm.contentDOM; i < 4; i++) lineDOM.childNodes[1].remove()
    flush(cm)
    ist(cm.state.doc.toString(), "1\n6")
  })

  it("can deal with large insertions", () => {
    const cm = tempView("okay")
    const node = document.createElement("div")
    node.textContent = "ayayayayayay"
    for (let i = 0, lineDOM = cm.domAtPos(0).node.parentNode!; i < 100; i++) lineDOM.appendChild(node.cloneNode(true))
    flush(cm)
    ist(cm.state.doc.toString(), "okay" + "\nayayayayayay".repeat(100))
  })

  it("properly handles selection for ambiguous backspace", () => {
    const cm = tempView("foo")
    cm.dispatch({selection: {anchor: 2}})
    cm.domAtPos(1).node.nodeValue = "fo"
    cm.inputState.lastKeyCode = 8
    cm.inputState.lastKeyTime = Date.now()
    flush(cm)
    ist(cm.state.selection.main.anchor, 1)
  })

  it("notices text changes at the end of a long document", () => {
    const cm = tempView("foo\nbar\n".repeat(15))
    cm.domAtPos(8*15).node.textContent = "a"
    flush(cm)
    ist(cm.state.doc.toString(), "foo\nbar\n".repeat(15) + "a")
  })

  it("handles replacing a selection with a prefix of itself", () => {
    const cm = tempView("foo\nbar")
    cm.dispatch({selection: {anchor: 0, head: 7}})
    cm.contentDOM.textContent = "f"
    flush(cm)
    ist(cm.state.doc.toString(), "f")
  })

  it("handles replacing a selection with a suffix of itself", () => {
    const cm = tempView("foo\nbar")
    cm.dispatch({selection: {anchor: 0, head: 7}})
    cm.contentDOM.textContent = "r"
    flush(cm)
    ist(cm.state.doc.toString(), "r")
  })

  it("handles replacing a selection with a prefix of itself and something else", () => {
    const cm = tempView("foo\nbar")
    cm.dispatch({selection: {anchor: 0, head: 7}})
    cm.contentDOM.textContent = "fa"
    flush(cm)
    ist(cm.state.doc.toString(), "fa")
  })

  it("handles replacing a selection with a suffix of itself and something else", () => {
    const cm = tempView("foo\nbar")
    cm.dispatch({selection: {anchor: 0, head: 7}})
    cm.contentDOM.textContent = "br"
    flush(cm)
    ist(cm.state.doc.toString(), "br")
  })

  it("handles replacing a selection with new content that shares a prefix and a suffix", () => {
    const cm = tempView("foo\nbar")
    cm.dispatch({selection: {anchor: 1, head: 6}})
    cm.contentDOM.textContent = "fo--ar"
    flush(cm)
    ist(cm.state.doc.toString(), "fo--ar")
  })

  it("handles appending", () => {
    const cm = tempView("foo\nbar")
    cm.dispatch({selection: {anchor: 7}})
    cm.contentDOM.appendChild(document.createElement("div"))
    flush(cm)
    ist(cm.state.doc.toString(), "foo\nbar\n")
  })

  it("handles deleting the first line and the newline after it", () => {
    const cm = tempView("foo\nbar\n\nbaz")
    cm.contentDOM.innerHTML = "bar<div><br></div><div>baz</div>"
    flush(cm)
    ist(cm.state.doc.toString(), "bar\n\nbaz")
  })

  it("handles deleting a line with an empty line after it", () => {
    const cm = tempView("foo\nbar\n\nbaz")
    cm.contentDOM.innerHTML = "<div>foo</div><br><div>baz</div>"
    flush(cm)
    ist(cm.state.doc.toString(), "foo\n\nbaz")
  })

  it("doesn't drop collapsed text", () => {
    const field = StateField.define<DecorationSet>({
      create() { return Decoration.set(Decoration.replace({}).range(1, 3)) },
      update() { return Decoration.none },
      provide: f => EditorView.decorations.from(f)
    })
    const cm = tempView("abcd", [field])
    cm.domAtPos(0).node.textContent = "x"
    flush(cm)
    ist(cm.state.doc.toString(), "xbcd")
  })

  it("preserves text nodes when edited in the middle", () => {
    const cm = tempView("abcd"), text = cm.domAtPos(1).node
    text.textContent = "axxd"
    flush(cm)
    ist(cm.domAtPos(1).node, text)
  })

  it("preserves text nodes when edited at the start", () => {
    const cm = tempView("abcd"), text = cm.domAtPos(1).node
    text.textContent = "xxcd"
    flush(cm)
    ist(cm.domAtPos(1).node, text)
  })

  it("preserves text nodes when edited at the end", () => {
    const cm = tempView("abcd"), text = cm.domAtPos(1).node
    text.textContent = "abxx"
    flush(cm)
    ist(cm.domAtPos(1).node, text)
  })

  it("doesn't insert newlines for block widgets", () => {
    class Widget extends WidgetType {
      toDOM() { return document.createElement("div") }
    }
    const field = StateField.define<DecorationSet>({
      create() { return Decoration.set(Decoration.widget({widget: new Widget }).range(4)) },
      update(v) { return v },
      provide: f => EditorView.decorations.from(f)
    })
    const cm = tempView("abcd", [field])
    cm.contentDOM.firstChild!.appendChild(document.createTextNode("x"))
    flush(cm)
    ist(cm.state.doc.toString(), "abcdx")
  })

  it("correctly handles changes ending on a widget", () => {
    const widget = new class extends WidgetType {
      toDOM() { return document.createElement("strong") }
    }
    const field = StateField.define<DecorationSet>({
      create() { return Decoration.set([Decoration.widget({widget}).range(2),
                                        Decoration.widget({widget}).range(7)]) },
      update(v, tr) { return v.map(tr.changes) },
      provide: f => EditorView.decorations.from(f)
    })
    const cm = tempView("one two thr", [field])
    const wDOM = cm.contentDOM.querySelectorAll("strong")[1]
    cm.domAtPos(6).node.nodeValue = "e"
    wDOM.remove()
    flush(cm)
    ist(cm.state.doc.toString(), "one thr")
  })

  it("calls input handlers", () => {
    const cm = tempView("abc", [EditorView.inputHandler.of((_v, from, to, insert) => {
      cm.dispatch({changes: {from, to, insert: insert.toUpperCase()}})
      return true
    })])
    cm.contentDOM.firstChild!.appendChild(document.createTextNode("d"))
    flush(cm)
    ist(cm.state.doc.toString(), "abcD")
  })

  it("ignores dom-changes in read-only mode", () => {
    const cm = tempView("abc", [EditorState.readOnly.of(true)])
    cm.domAtPos(0).node.nodeValue = "abx"
    flush(cm)
    ist(cm.state.doc.toString(), "abc")
    ist(cm.contentDOM.textContent, "abc")
  })

  it("can handle crlf insertion", () => {
    const cm = tempView("abc")
    const text = cm.domAtPos(1).node
    text.nodeValue = "ab\r\nc"
    getSelection()!.collapse(text, 4)
    flush(cm)
    ist(cm.state.doc.toString(), "ab\nc")
    ist(cm.state.selection.main.head, 3)
  })

  it("works when line breaks are multiple characters", () => {
    const cm = tempView("abc", [EditorState.lineSeparator.of("\r\n")])
    const text = cm.domAtPos(1).node
    text.nodeValue = "ab\r\nc"
    getSelection()!.collapse(text, 4)
    flush(cm)
    ist(cm.state.sliceDoc(), "ab\r\nc")
    ist(cm.state.selection.main.head, 3)
  })

  it("doesn't insert a newline after a block widget", () => {
    const widget = new class extends WidgetType {
      toDOM() { return document.createElement("div") }
    }
    const cm = tempView("\n\n", [EditorView.decorations.of(Decoration.set(Decoration.widget({widget, block: true}).range(0)))])
    const newLine = document.createElement("div")
    newLine.innerHTML = "<br>"
    cm.contentDOM.insertBefore(newLine, cm.contentDOM.childNodes[1])
    flush(cm)
    ist(cm.state.sliceDoc(), "\n\n\n")
  })
})
