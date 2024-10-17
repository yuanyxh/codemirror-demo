type ClipboardEvent = React.ClipboardEvent<HTMLDivElement>;

export function onBeforeInput(event: React.FormEvent<HTMLDivElement>) {
  event.preventDefault();

  console.log(event);
}

export function onCopy(event: ClipboardEvent) {
  event.preventDefault();

  console.log(event);
}

export function onCut(event: ClipboardEvent) {
  event.preventDefault();

  console.log(event);
}

export function onPaste(event: ClipboardEvent) {
  event.preventDefault();

  console.log(event);
}

export function onKeydown(event: React.KeyboardEvent<HTMLDivElement>) {
  event.preventDefault();

  console.log(event);
}

function onSelectionChange() {
  const selection = window.getSelection();

  console.log(selection);
}

window.document.addEventListener("selectionchange", onSelectionChange);
