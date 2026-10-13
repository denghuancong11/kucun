import type { HTMLAttributes, MouseEvent } from "react";

function hasSelectedText(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && selection.containsNode(element, true);
}

export function expandableRowProps(expanded: boolean, toggle: () => void): Pick<HTMLAttributes<HTMLTableRowElement>, "onClick" | "onKeyDown" | "tabIndex" | "aria-expanded"> {
  return {
    tabIndex: 0,
    "aria-expanded": expanded,
    onClick: event => {
      const control = event.target instanceof Element
        ? event.target.closest('button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [tabindex], [contenteditable]:not([contenteditable="false"])')
        : null;
      if (control && control !== event.currentTarget && event.currentTarget.contains(control)) return;
      if (!hasSelectedText(event.currentTarget)) toggle();
    },
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    },
  };
}

export function preserveSummarySelection(event: MouseEvent<HTMLElement>) {
  if (event.detail > 0 && hasSelectedText(event.currentTarget)) event.preventDefault();
}
