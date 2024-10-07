import {findClusterBreak, countColumn, findColumn} from "@codemirror/state"
import ist from "ist"

describe("findClusterBreak", () => {
  function test(spec: string) {
    it(spec, () => {
      let breaks = [], next: number
      while ((next = spec.indexOf("|")) > -1) {
        breaks.push(next)
        spec = spec.slice(0, next) + spec.slice(next + 1)
      }
      const found = []
      for (let i = 0;;) {
        const next = findClusterBreak(spec, i)
        if (next == spec.length) break
        found.push(i = next)
      }
      ist(found.join(","), breaks.join(","))
    })
  }
  
  test("a|b|c|d")
  test("a|é̠|ő|x")
  test("😎|🙉")
  test("👨‍🎤|💪🏽|👩‍👩‍👧‍👦|❤")
  test("🇩🇪|🇫🇷|🇪🇸|x|🇮🇹")
})

describe("countColumn", () => {
  it("counts characters", () => ist(countColumn("abc", 4), 3))

  it("counts tabs correctly", () => ist(countColumn("a\t\tbc\tx", 4), 13))

  it("handles clusters", () => ist(countColumn("a😎🇫🇷", 4), 3))
})

describe("findColumn", () => {
  it("finds positions", () => ist(findColumn("abc", 3, 4), 3))

  it("counts tabs", () => ist(findColumn("a\tbc", 4, 4), 2))

  it("handles clusters", () => ist(findColumn("a😎🇫🇷bc", 4, 4), 8))
})
