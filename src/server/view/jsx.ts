/**
 * Minimal server-side JSX runtime.
 *
 * The npm registry is unreachable in the build environment, so instead of
 * React/Next.js the UI is written as plain TSX function components rendered
 * to HTML strings on the server. Components written this way port to
 * Next.js React Server Components almost mechanically.
 */

declare global {
  namespace JSX {
    type Element = VNode;
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>;
    }
    interface ElementChildrenAttribute {
      children: unknown;
    }
  }
}

export type Child = string | number | boolean | null | undefined | VNode | Child[];

export interface VNode {
  __vnode: true;
  html: string;
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderChildren(children: Child): string {
  let out = "";
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      out += renderChildren(child);
    } else if (typeof child === "object" && "__vnode" in child) {
      out += child.html;
    } else {
      out += escapeHtml(child);
    }
  }
  return out;
}

function renderAttrs(props: Record<string, unknown> | null): string {
  if (!props) return "";
  let out = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || value === null || value === undefined || value === false) continue;
    const name = key === "className" ? "class" : key;
    if (value === true) {
      out += ` ${name}`;
    } else {
      out += ` ${name}="${escapeHtml(value)}"`;
    }
  }
  return out;
}

type Component = (props: Record<string, unknown>) => VNode;

export function h(
  tag: string | Component,
  props: Record<string, unknown> | null,
  ...children: Child[]
): VNode {
  if (typeof tag === "function") {
    return tag({ ...(props ?? {}), children });
  }
  const inner = renderChildren(children);
  if (VOID_ELEMENTS.has(tag)) {
    return { __vnode: true, html: `<${tag}${renderAttrs(props)}>` };
  }
  return { __vnode: true, html: `<${tag}${renderAttrs(props)}>${inner}</${tag}>` };
}

export function Fragment(props: { children?: Child }): VNode {
  return { __vnode: true, html: renderChildren(props.children ?? []) };
}

/** Escape hatch for trusted, pre-built HTML (e.g. inline SVG). */
export function raw(html: string): VNode {
  return { __vnode: true, html };
}

export function renderDocument(node: VNode): string {
  return "<!DOCTYPE html>" + node.html;
}
