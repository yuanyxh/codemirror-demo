/** 处理 dom 相关的工具 */

export function getSelection(root: DocumentOrShadowRoot): Selection | null {
  let target: Document;

  // Browsers differ on whether shadow roots have a getSelection
  // method. If it exists, use that, otherwise, call it on the
  // document.
  if ((root as any).nodeType == 11) {
    // Shadow root
    target = (root as any).getSelection ? (root as Document) : (root as ShadowRoot).ownerDocument;
  } else {
    target = root as Document;
  }

  return target.getSelection();
}

export function contains(dom: Node, node: Node | null) {
  return node ? dom == node || dom.contains(node.nodeType != 1 ? node.parentNode : node) : false;
}

export function hasSelection(dom: HTMLElement, selection: SelectionRange): boolean {
  if (!selection.anchorNode) {
    return false;
  }

  try {
    // Firefox will raise 'permission denied' errors when accessing
    // properties of `sel.anchorNode` when it's in a generated CSS
    // element.
    return contains(dom, selection.anchorNode);
  } catch (_) {
    return false;
  }
}

export function clientRectsFor(dom: Node) {
  if (dom.nodeType == 3) {
    return textRange(dom as Text, 0, dom.nodeValue!.length).getClientRects();
  } else if (dom.nodeType == 1) {
    return (dom as HTMLElement).getClientRects();
  } else {
    return [] as any as DOMRectList;
  }
}

/**
 * 向前和向后扫描与给定位置等效的 DOM 位置，看看两者是否位于同一位置（即在文本节点之后与在该文本节点的末尾）
 */
export function isEquivalentPosition(
  node: Node,
  off: number,
  targetNode: Node | null,
  targetOff: number
): boolean {
  return targetNode
    ? scanFor(node, off, targetNode, targetOff, -1) || scanFor(node, off, targetNode, targetOff, 1)
    : false;
}

/** 获取 dom 在父 node 中的位置 */
export function domIndex(node: Node): number {
  for (let index = 0; ; index++) {
    node = node.previousSibling!;

    if (!node) {
      return index;
    }
  }
}

/** 是否是块级 dom 元素 */
export function isBlockElement(node: Node): boolean {
  return (
    node.nodeType == 1 && /^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(node.nodeName)
  );
}

function scanFor(
  node: Node,
  off: number,
  targetNode: Node,
  targetOff: number,
  dir: -1 | 1
): boolean {
  for (;;) {
    if (node == targetNode && off == targetOff) {
      return true;
    }
    if (off == (dir < 0 ? 0 : maxOffset(node))) {
      if (node.nodeName == "DIV") {
        return false;
      }

      const parent = node.parentNode;

      if (!parent || parent.nodeType != 1) {
        return false;
      }

      off = domIndex(node) + (dir < 0 ? 0 : 1);
      node = parent;
    } else if (node.nodeType == 1) {
      node = node.childNodes[off + (dir < 0 ? -1 : 0)];
      if (node.nodeType == 1 && (node as HTMLElement).contentEditable == "false") {
        return false;
      }

      off = dir < 0 ? maxOffset(node) : 0;
    } else {
      return false;
    }
  }
}

export function maxOffset(node: Node): number {
  return node.nodeType == 3 ? node.nodeValue!.length : node.childNodes.length;
}

/// Basic rectangle type.
export interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export function flattenRect(rect: Rect, left: boolean) {
  const x = left ? rect.left : rect.right;
  return { left: x, right: x, top: rect.top, bottom: rect.bottom };
}

function windowRect(win: Window): Rect {
  const vp = win.visualViewport;

  if (vp) {
    return {
      left: 0,
      right: vp.width,
      top: 0,
      bottom: vp.height,
    };
  }

  return { left: 0, right: win.innerWidth, top: 0, bottom: win.innerHeight };
}

export type ScrollStrategy = "nearest" | "start" | "end" | "center";

export function getScale(elt: HTMLElement, rect: DOMRect) {
  let scaleX = rect.width / elt.offsetWidth;
  let scaleY = rect.height / elt.offsetHeight;

  if (
    (scaleX > 0.995 && scaleX < 1.005) ||
    !isFinite(scaleX) ||
    Math.abs(rect.width - elt.offsetWidth) < 1
  ) {
    scaleX = 1;
  }

  if (
    (scaleY > 0.995 && scaleY < 1.005) ||
    !isFinite(scaleY) ||
    Math.abs(rect.height - elt.offsetHeight) < 1
  ) {
    scaleY = 1;
  }

  return { scaleX, scaleY };
}

export function scrollRectIntoView(
  dom: HTMLElement,
  rect: Rect,
  side: -1 | 1,
  x: ScrollStrategy,
  y: ScrollStrategy,
  xMargin: number,
  yMargin: number,
  ltr: boolean
) {
  const doc = dom.ownerDocument!;
  const win = doc.defaultView || window;

  for (let cur: any = dom, stop = false; cur && !stop; ) {
    if (cur.nodeType == 1) {
      // Element
      let bounding: Rect;
      const top = cur == doc.body;

      let scaleX = 1;
      let scaleY = 1;

      if (top) {
        bounding = windowRect(win);
      } else {
        if (/^(fixed|sticky)$/.test(getComputedStyle(cur).position)) {
          stop = true;
        }
        if (cur.scrollHeight <= cur.clientHeight && cur.scrollWidth <= cur.clientWidth) {
          cur = cur.assignedSlot || cur.parentNode;

          continue;
        }

        const rect = cur.getBoundingClientRect();

        ({ scaleX, scaleY } = getScale(cur, rect));

        // Make sure scrollbar width isn't included in the rectangle
        bounding = {
          left: rect.left,
          right: rect.left + cur.clientWidth * scaleX,
          top: rect.top,
          bottom: rect.top + cur.clientHeight * scaleY,
        };
      }

      let moveX = 0;
      let moveY = 0;

      if (y == "nearest") {
        if (rect.top < bounding.top) {
          moveY = -(bounding.top - rect.top + yMargin);

          if (side > 0 && rect.bottom > bounding.bottom + moveY) {
            moveY = rect.bottom - bounding.bottom + moveY + yMargin;
          }
        } else if (rect.bottom > bounding.bottom) {
          moveY = rect.bottom - bounding.bottom + yMargin;

          if (side < 0 && rect.top - moveY < bounding.top) {
            moveY = -(bounding.top + moveY - rect.top + yMargin);
          }
        }
      } else {
        const rectHeight = rect.bottom - rect.top;
        const boundingHeight = bounding.bottom - bounding.top;
        const targetTop =
          y == "center" && rectHeight <= boundingHeight
            ? rect.top + rectHeight / 2 - boundingHeight / 2
            : y == "start" || (y == "center" && side < 0)
            ? rect.top - yMargin
            : rect.bottom - boundingHeight + yMargin;

        moveY = targetTop - bounding.top;
      }
      if (x == "nearest") {
        if (rect.left < bounding.left) {
          moveX = -(bounding.left - rect.left + xMargin);

          if (side > 0 && rect.right > bounding.right + moveX) {
            moveX = rect.right - bounding.right + moveX + xMargin;
          }
        } else if (rect.right > bounding.right) {
          moveX = rect.right - bounding.right + xMargin;

          if (side < 0 && rect.left < bounding.left + moveX) {
            moveX = -(bounding.left + moveX - rect.left + xMargin);
          }
        }
      } else {
        const targetLeft =
          x == "center"
            ? rect.left + (rect.right - rect.left) / 2 - (bounding.right - bounding.left) / 2
            : (x == "start") == ltr
            ? rect.left - xMargin
            : rect.right - (bounding.right - bounding.left) + xMargin;

        moveX = targetLeft - bounding.left;
      }

      if (moveX || moveY) {
        if (top) {
          win.scrollBy(moveX, moveY);
        } else {
          let movedX = 0;
          let movedY = 0;

          if (moveY) {
            const start = cur.scrollTop;
            cur.scrollTop += moveY / scaleY;
            movedY = (cur.scrollTop - start) * scaleY;
          }

          if (moveX) {
            const start = cur.scrollLeft;
            cur.scrollLeft += moveX / scaleX;
            movedX = (cur.scrollLeft - start) * scaleX;
          }

          rect = {
            left: rect.left - movedX,
            top: rect.top - movedY,
            right: rect.right - movedX,
            bottom: rect.bottom - movedY,
          } as ClientRect;

          if (movedX && Math.abs(movedX - moveX) < 1) {
            x = "nearest";
          }

          if (movedY && Math.abs(movedY - moveY) < 1) {
            y = "nearest";
          }
        }
      }
      if (top) {
        break;
      }

      cur = cur.assignedSlot || cur.parentNode;
    } else if (cur.nodeType == 11) {
      // A shadow root
      cur = cur.host;
    } else {
      break;
    }
  }
}

export function scrollableParents(dom: HTMLElement) {
  const doc = dom.ownerDocument;

  let x: HTMLElement | undefined;
  let y: HTMLElement | undefined;

  for (let cur = dom.parentNode as HTMLElement | null; cur; ) {
    if (cur == doc.body || (x && y)) {
      break;
    } else if (cur.nodeType == 1) {
      if (!y && cur.scrollHeight > cur.clientHeight) {
        y = cur;
      }

      if (!x && cur.scrollWidth > cur.clientWidth) {
        x = cur;
      }

      cur = cur.assignedSlot || (cur.parentNode as HTMLElement | null);
    } else if (cur.nodeType == 11) {
      cur = (cur as any).host;
    } else {
      break;
    }
  }

  return { x, y };
}

export interface SelectionRange {
  focusNode: Node | null;
  focusOffset: number;
  anchorNode: Node | null;
  anchorOffset: number;
}

export class DOMSelectionState implements SelectionRange {
  anchorNode: Node | null = null;
  anchorOffset: number = 0;
  focusNode: Node | null = null;
  focusOffset: number = 0;

  eq(domSel: SelectionRange): boolean {
    return (
      this.anchorNode == domSel.anchorNode &&
      this.anchorOffset == domSel.anchorOffset &&
      this.focusNode == domSel.focusNode &&
      this.focusOffset == domSel.focusOffset
    );
  }

  /** 缓存 range */
  setRange(range: SelectionRange) {
    const { anchorNode, focusNode } = range;
    // Clip offsets to node size to avoid crashes when Safari reports bogus offsets (#1152)
    /** 将偏移量裁剪为节点大小，以避免 Safari 报告虚假偏移量时发生崩溃 (#1152) */
    this.set(
      anchorNode,
      Math.min(range.anchorOffset, anchorNode ? maxOffset(anchorNode) : 0),
      focusNode,
      Math.min(range.focusOffset, focusNode ? maxOffset(focusNode) : 0)
    );
  }

  /** 缓存 range */
  set(anchorNode: Node | null, anchorOffset: number, focusNode: Node | null, focusOffset: number) {
    this.anchorNode = anchorNode;
    this.anchorOffset = anchorOffset;
    this.focusNode = focusNode;
    this.focusOffset = focusOffset;
  }
}

let preventScrollSupported: null | false | { preventScroll: boolean } = null;
// Feature-detects support for .focus({preventScroll: true}), and uses
// a fallback kludge when not supported.
export function focusPreventScroll(dom: HTMLElement) {
  if ((dom as any).setActive) return (dom as any).setActive(); // in IE
  if (preventScrollSupported) return dom.focus(preventScrollSupported);

  const stack = [];
  for (let cur: Node | null = dom; cur; cur = cur.parentNode) {
    stack.push(cur, (cur as any).scrollTop, (cur as any).scrollLeft);
    if (cur == cur.ownerDocument) break;
  }
  dom.focus(
    preventScrollSupported == null
      ? {
          get preventScroll() {
            preventScrollSupported = { preventScroll: true };
            return true;
          },
        }
      : undefined
  );
  if (!preventScrollSupported) {
    preventScrollSupported = false;
    for (let i = 0; i < stack.length; ) {
      const elt = stack[i++] as HTMLElement,
        top = stack[i++] as number,
        left = stack[i++] as number;
      if (elt.scrollTop != top) elt.scrollTop = top;
      if (elt.scrollLeft != left) elt.scrollLeft = left;
    }
  }
}

let scratchRange: Range | null;

export function textRange(node: Text, from: number, to = from) {
  const range = scratchRange || (scratchRange = document.createRange());
  range.setEnd(node, to);
  range.setStart(node, from);
  return range;
}

export function dispatchKey(
  elt: HTMLElement,
  name: string,
  code: number,
  mods?: KeyboardEvent
): boolean {
  const options: KeyboardEventInit = {
    key: name,
    code: name,
    keyCode: code,
    which: code,
    cancelable: true,
  };
  if (mods)
    ({
      altKey: options.altKey,
      ctrlKey: options.ctrlKey,
      shiftKey: options.shiftKey,
      metaKey: options.metaKey,
    } = mods);
  const down = new KeyboardEvent("keydown", options);
  (down as any).synthetic = true;
  elt.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", options);
  (up as any).synthetic = true;
  elt.dispatchEvent(up);
  return down.defaultPrevented || up.defaultPrevented;
}

/** 获取根元素 */
export function getRoot(node: Node | null | undefined): DocumentOrShadowRoot | null {
  while (node) {
    if (node && (node.nodeType == 9 || (node.nodeType == 11 && (node as ShadowRoot).host))) {
      return node as unknown as DocumentOrShadowRoot;
    }

    node = (node as HTMLElement).assignedSlot || node.parentNode;
  }

  return null;
}

/** 删除所有 dom 属性 */
export function clearAttributes(node: HTMLElement) {
  while (node.attributes.length) {
    node.removeAttributeNode(node.attributes[0]);
  }
}

export function atElementStart(doc: HTMLElement, selection: SelectionRange) {
  let node = selection.focusNode,
    offset = selection.focusOffset;
  if (!node || selection.anchorNode != node || selection.anchorOffset != offset) return false;
  // Safari can report bogus offsets (#1152)
  offset = Math.min(offset, maxOffset(node));
  for (;;) {
    if (offset) {
      if (node.nodeType != 1) return false;
      const prev: Node = node.childNodes[offset - 1];
      if ((prev as HTMLElement).contentEditable == "false") offset--;
      else {
        node = prev;
        offset = maxOffset(node);
      }
    } else if (node == doc) {
      return true;
    } else {
      offset = domIndex(node);
      node = node.parentNode!;
    }
  }
}

export function isScrolledToBottom(elt: HTMLElement) {
  return elt.scrollTop > Math.max(1, elt.scrollHeight - elt.clientHeight - 4);
}

export function textNodeBefore(
  startNode: Node,
  startOffset: number
): { node: Text; offset: number } | null {
  for (let node = startNode, offset = startOffset; ; ) {
    if (node.nodeType == 3 && offset > 0) {
      return { node: node as Text, offset: offset };
    } else if (node.nodeType == 1 && offset > 0) {
      if ((node as HTMLElement).contentEditable == "false") return null;
      node = node.childNodes[offset - 1];
      offset = maxOffset(node);
    } else if (node.parentNode && !isBlockElement(node)) {
      offset = domIndex(node);
      node = node.parentNode;
    } else {
      return null;
    }
  }
}

export function textNodeAfter(
  startNode: Node,
  startOffset: number
): { node: Text; offset: number } | null {
  for (let node = startNode, offset = startOffset; ; ) {
    if (node.nodeType == 3 && offset < node.nodeValue!.length) {
      return { node: node as Text, offset: offset };
    } else if (node.nodeType == 1 && offset < node.childNodes.length) {
      if ((node as HTMLElement).contentEditable == "false") return null;
      node = node.childNodes[offset];
      offset = 0;
    } else if (node.parentNode && !isBlockElement(node)) {
      offset = domIndex(node) + 1;
      node = node.parentNode;
    } else {
      return null;
    }
  }
}
