import { EditorView } from "../editorview";
import { Command } from "./extension";
import { modifierCodes } from "../utils/input";
import { base, shift, keyName } from "w3c-keyname";
import { Facet, Prec, EditorState, codePointSize, codePointAt } from "@/state/index";
import browser from "../utils/browser";

/** 处理按键绑定的扩展 */

/**
 * 键绑定将键名称与 [command](#view.Command) 样式的函数相关联
 * 键名称可以是类似 “Shift-Ctrl-Enter” 的字符串——以零个或多个修饰符为前缀的键标识符
 *
 * 键标识符基于可以出现在 [`KeyEvent.key`] 中的字符串, 使用小写字母来表示字母键（如果您希望按住 Shift 键，则使用大写字母） 您可以使用 “Space” 作为 “”“ 名称的别名
 *
 * 修饰符可以按任何顺序给出 `Shift-`（或 `s-`）、`Alt-`（或 `a-`）、`Ctrl-` （或 `c-` 或 `Control-`）和 `Cmd-` （或 `m-` 或 `Meta-`) 被识别
 *
 * 当键绑定包含由空格分隔的多个键名称时，它表示多笔画绑定，当用户依次按下给定的键时将触发该绑定
 *
 * 您可以使用 “Mod-” 作为 Mac 上 “Cmd-” 和其他平台上 “Ctrl-” 的简写，因此，“Mod-b” 在 Linux 上是“Ctrl-b”，但在 macOS 上是 “Cmd-b”。
 */
export interface KeyBinding {
  /// The key name to use for this binding. If the platform-specific
  /// property (`mac`, `win`, or `linux`) for the current platform is
  /// used as well in the binding, that one takes precedence. If `key`
  /// isn't defined and the platform-specific binding isn't either,
  /// a binding is ignored.
  key?: string;
  /// Key to use specifically on macOS.
  mac?: string;
  /// Key to use specifically on Windows.
  win?: string;
  /// Key to use specifically on Linux.
  linux?: string;
  /// The command to execute when this binding is triggered. When the
  /// command function returns `false`, further bindings will be tried
  /// for the key.
  run?: Command;
  /// When given, this defines a second binding, using the (possibly
  /// platform-specific) key name prefixed with `Shift-` to activate
  /// this command.
  shift?: Command;
  /// When this property is present, the function is called for every
  /// key that is not a multi-stroke prefix.
  any?: (view: EditorView, event: KeyboardEvent) => boolean;
  /// By default, key bindings apply when focus is on the editor
  /// content (the `"editor"` scope). Some extensions, mostly those
  /// that define their own panels, might want to allow you to
  /// register bindings local to that panel. Such bindings should use
  /// a custom scope name. You may also assign multiple scope names to
  /// a binding, separating them by spaces.
  scope?: string;
  /// When set to true (the default is false), this will always
  /// prevent the further handling for the bound key, even if the
  /// command(s) return false. This can be useful for cases where the
  /// native behavior of the key is annoying or irrelevant but the
  /// command doesn't always apply (such as, Mod-u for undo selection,
  /// which would cause the browser to view source instead when no
  /// selection can be undone).
  preventDefault?: boolean;
  /// When set to true, `stopPropagation` will be called on keyboard
  /// events that have their `preventDefault` called in response to
  /// this key binding (see also
  /// [`preventDefault`](#view.KeyBinding.preventDefault)).
  stopPropagation?: boolean;
}

type PlatformName = "mac" | "win" | "linux" | "key";

const currentPlatform: PlatformName = browser.mac
  ? "mac"
  : browser.windows
  ? "win"
  : browser.linux
  ? "linux"
  : "key";

function normalizeKeyName(name: string, platform: PlatformName): string {
  const parts = name.split(/-(?!$)/);

  let result = parts[parts.length - 1];

  if (result == "Space") {
    result = " ";
  }

  let alt!: boolean;
  let ctrl!: boolean;
  let shift!: boolean;
  let meta!: boolean;

  for (let i = 0; i < parts.length - 1; ++i) {
    const mod = parts[i];

    if (/^(cmd|meta|m)$/i.test(mod)) {
      meta = true;
    } else if (/^a(lt)?$/i.test(mod)) {
      alt = true;
    } else if (/^(c|ctrl|control)$/i.test(mod)) {
      ctrl = true;
    } else if (/^s(hift)?$/i.test(mod)) {
      shift = true;
    } else if (/^mod$/i.test(mod)) {
      if (platform == "mac") {
        meta = true;
      } else {
        ctrl = true;
      }
    } else {
      throw new Error("Unrecognized modifier name: " + mod);
    }
  }

  if (alt) {
    result = "Alt-" + result;
  }

  if (ctrl) {
    result = "Ctrl-" + result;
  }

  if (meta) {
    result = "Meta-" + result;
  }

  if (shift) {
    result = "Shift-" + result;
  }

  return result;
}

function modifiers(name: string, event: KeyboardEvent, shift: boolean) {
  if (event.altKey) {
    name = "Alt-" + name;
  }

  if (event.ctrlKey) {
    name = "Ctrl-" + name;
  }

  if (event.metaKey) {
    name = "Meta-" + name;
  }

  if (shift !== false && event.shiftKey) {
    name = "Shift-" + name;
  }

  return name;
}

type Binding = {
  preventDefault: boolean;
  stopPropagation: boolean;
  run: ((view: EditorView) => boolean)[];
};

// In each scope, the `_any` property is used for bindings that apply
// to all keys.
type Keymap = { [scope: string]: { [key: string]: Binding } };

const handleKeyEvents = Prec.default(
  EditorView.domEventHandlers({
    keydown(event, view) {
      return runHandlers(getKeymap(view.state), event, view, "editor");
    },
  })
);

/// Facet used for registering keymaps.
///
/// You can add multiple keymaps to an editor. Their priorities
/// determine their precedence (the ones specified early or with high
/// priority get checked first). When a handler has returned `true`
/// for a given key, no further handlers are called.
export const keymap = Facet.define<readonly KeyBinding[]>({ enables: handleKeyEvents });

const Keymaps = new WeakMap<readonly (readonly KeyBinding[])[], Keymap>();

// This is hidden behind an indirection, rather than directly computed
// by the facet, to keep internal types out of the facet's type.
function getKeymap(state: EditorState) {
  const bindings = state.facet(keymap);

  let map = Keymaps.get(bindings);

  if (!map) {
    Keymaps.set(bindings, (map = buildKeymap(bindings.reduce((a, b) => a.concat(b), []))));
  }

  return map;
}

/// Run the key handlers registered for a given scope. The event
/// object should be a `"keydown"` event. Returns true if any of the
/// handlers handled it.
export function runScopeHandlers(view: EditorView, event: KeyboardEvent, scope: string) {
  return runHandlers(getKeymap(view.state), event, view, scope);
}

let storedPrefix: { view: EditorView; prefix: string; scope: string } | null = null;

const PrefixTimeout = 4000;

function buildKeymap(bindings: readonly KeyBinding[], platform = currentPlatform) {
  const bound: Keymap = Object.create(null);
  const isPrefix: { [prefix: string]: boolean } = Object.create(null);

  const checkPrefix = (name: string, is: boolean) => {
    const current = isPrefix[name];

    if (current == null) {
      isPrefix[name] = is;
    } else if (current != is) {
      throw new Error(
        "Key binding " + name + " is used both as a regular binding and as a multi-stroke prefix"
      );
    }
  };

  const add = (
    scope: string,
    key: string,
    command: Command | undefined,
    preventDefault?: boolean,
    stopPropagation?: boolean
  ) => {
    const scopeObj = bound[scope] || (bound[scope] = Object.create(null));
    const parts = key.split(/ (?!$)/).map((k) => normalizeKeyName(k, platform));

    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(" ");

      checkPrefix(prefix, true);

      if (!scopeObj[prefix]) {
        scopeObj[prefix] = {
          preventDefault: true,
          stopPropagation: false,
          run: [
            (view: EditorView) => {
              const ourObj = (storedPrefix = { view, prefix, scope });

              setTimeout(() => {
                if (storedPrefix == ourObj) {
                  storedPrefix = null;
                }
              }, PrefixTimeout);

              return true;
            },
          ],
        };
      }
    }

    const full = parts.join(" ");

    checkPrefix(full, false);

    const binding =
      scopeObj[full] ||
      (scopeObj[full] = {
        preventDefault: false,
        stopPropagation: false,
        run: scopeObj._any?.run?.slice() || [],
      });

    if (command) {
      binding.run.push(command);
    }

    if (preventDefault) {
      binding.preventDefault = true;
    }
    if (stopPropagation) {
      binding.stopPropagation = true;
    }
  };

  for (const b of bindings) {
    const scopes = b.scope ? b.scope.split(" ") : ["editor"];

    if (b.any) {
      for (const scope of scopes) {
        const scopeObj = bound[scope] || (bound[scope] = Object.create(null));

        if (!scopeObj._any) {
          scopeObj._any = { preventDefault: false, stopPropagation: false, run: [] };
        }

        const { any } = b;

        for (const key in scopeObj) {
          scopeObj[key].run.push((view) => any(view, currentKeyEvent!));
        }
      }
    }

    const name = b[platform] || b.key;

    if (!name) {
      continue;
    }

    for (const scope of scopes) {
      add(scope, name, b.run, b.preventDefault, b.stopPropagation);

      if (b.shift) {
        add(scope, "Shift-" + name, b.shift, b.preventDefault, b.stopPropagation);
      }
    }
  }

  return bound;
}

let currentKeyEvent: KeyboardEvent | null = null;

/** 运行事件处理程序 */
function runHandlers(map: Keymap, event: KeyboardEvent, view: EditorView, scope: string): boolean {
  currentKeyEvent = event;

  // 获取当前按下的键名
  const name = keyName(event);
  // 获取字符码点
  const charCode = codePointAt(name, 0);
  // 是否是单字符
  const isChar = codePointSize(charCode) == name.length && name != " ";

  let prefix = "";
  let handled = false;
  let prevented = false;
  let stopPropagation = false;

  if (storedPrefix && storedPrefix.view == view && storedPrefix.scope == scope) {
    prefix = storedPrefix.prefix + " ";

    if (modifierCodes.indexOf(event.keyCode) < 0) {
      prevented = true;
      storedPrefix = null;
    }
  }

  const ran: Set<(view: EditorView, event: KeyboardEvent) => boolean> = new Set();

  const runFor = (binding: Binding | undefined) => {
    if (binding) {
      /** 运行事件处理程序 */
      for (const cmd of binding.run) {
        if (!ran.has(cmd)) {
          ran.add(cmd);

          if (cmd(view)) {
            if (binding.stopPropagation) {
              stopPropagation = true;
            }

            return true;
          }
        }
      }

      if (binding.preventDefault) {
        if (binding.stopPropagation) {
          stopPropagation = true;
        }

        prevented = true;
      }
    }

    return false;
  };

  /** 获取作用域内的所有键绑定 */
  const scopeObj = map[scope];

  let baseName: string;
  let shiftName: string;

  if (scopeObj) {
    /** 找到事件并运行 */
    if (runFor(scopeObj[prefix + modifiers(name, event, !isChar)])) {
      handled = true;
    } else if (
      isChar &&
      (event.altKey || event.metaKey || event.ctrlKey) &&
      // Ctrl-Alt may be used for AltGr on Windows
      !(browser.windows && event.ctrlKey && event.altKey) &&
      (baseName = base[event.keyCode]) &&
      baseName != name
    ) {
      if (runFor(scopeObj[prefix + modifiers(baseName, event, true)])) {
        handled = true;
      } else if (
        event.shiftKey &&
        (shiftName = shift[event.keyCode]) != name &&
        shiftName != baseName &&
        runFor(scopeObj[prefix + modifiers(shiftName, event, false)])
      ) {
        handled = true;
      }
    } else if (
      isChar &&
      event.shiftKey &&
      runFor(scopeObj[prefix + modifiers(name, event, true)])
    ) {
      handled = true;
    }

    if (!handled && runFor(scopeObj._any)) {
      handled = true;
    }
  }

  if (prevented) {
    handled = true;
  }

  if (handled && stopPropagation) {
    event.stopPropagation();
  }

  currentKeyEvent = null;

  return handled;
}
