import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function pageFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

const pages = [
  ...pageFiles("src/app/dashboard"),
  ...pageFiles("src/app/platform"),
];

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

type RootElement = ts.JsxElement | ts.JsxSelfClosingElement;

function tagName(element: RootElement): string {
  const tag = ts.isJsxElement(element)
    ? element.openingElement.tagName
    : element.tagName;
  return tag.getText();
}

function staticClassName(element: RootElement): string | null {
  const attributes = ts.isJsxElement(element)
    ? element.openingElement.attributes.properties
    : element.attributes.properties;
  const attribute = attributes.find(
    (item): item is ts.JsxAttribute =>
      ts.isJsxAttribute(item) && item.name.getText() === "className",
  );
  if (!attribute?.initializer || !ts.isStringLiteral(attribute.initializer)) return null;
  return attribute.initializer.text;
}

function collectRenderedRoots(node: ts.Node, output: RootElement[]): void {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    output.push(node);
    return;
  }
  ts.forEachChild(node, (child) => collectRenderedRoots(child, output));
}

function layoutRoots(path: string): Array<{ tag: string; className: string | null }> {
  const source = read(path);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const roots: RootElement[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node)) {
      const layout = node.openingElement.tagName.getText();
      if (layout === "DashboardLayout" || layout === "PlatformLayout") {
        for (const child of node.children) collectRenderedRoots(child, roots);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return roots.map((element) => ({
    tag: tagName(element),
    className: staticClassName(element),
  }));
}

test("dashboard and platform pages leave outer horizontal gutters to their shells", () => {
  const padding = /^(?:sm:|md:|lg:|xl:|2xl:)?(?:p|px|pl|pr)-(?!0$).+/;
  const negativeHorizontalMargin = /^(?:sm:|md:|lg:|xl:|2xl:)?-?m[lrx]-\[-/;
  const surface = /^(?:bg-|border(?:-|$)|rounded(?:-|$)|shadow(?:-|$)|ring(?:-|$))/;

  for (const path of pages) {
    for (const root of layoutRoots(path)) {
      if (!root.className) continue;
      const tokens = root.className.split(/\s+/);
      const isSurface = tokens.some((token) => surface.test(token));
      const addsTransparentGutter = !isSurface && tokens.some((token) => padding.test(token));
      const escapesSharedEdge = tokens.some((token) => negativeHorizontalMargin.test(token));

      assert.ok(
        !addsTransparentGutter,
        `${path}: <${root.tag}> adds a second transparent page gutter (${root.className})`,
      );
      assert.ok(
        !escapesSharedEdge,
        `${path}: <${root.tag}> escapes the shared page edge (${root.className})`,
      );
    }
  }
});

test("dashboard and platform shells use the same responsive content gutter", () => {
  for (const path of [
    "src/components/layout/DashboardShell.tsx",
    "src/components/platform/PlatformShell.tsx",
  ]) {
    assert.ok(
      read(path).includes("px-3 py-3 lg:px-0 lg:py-0"),
      `${path} must own the shared mobile gutter and remove it on desktop`,
    );
  }
});
