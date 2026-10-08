import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

test("compiles every browser DTO and exhaustive event variant with DOM/ES only and no Node types", () => {
  const program = ts.createProgram([resolve("tests/fixtures/browser-contract.ts")], { strict: true, noEmit: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [] });
  expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
});

test("contains no Node imports/globals or value imports from server modules", () => {
  const source = readFileSync(resolve("src/web/contracts.ts"), "utf8");
  const tree = ts.createSourceFile("contracts.ts", source, ts.ScriptTarget.ES2022, true);
  const forbidden: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly || (ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("node:"))) forbidden.push(node.getText(tree));
    }
    if (ts.isIdentifier(node) && ["Buffer", "process", "require", "__dirname", "__filename", "NodeJS"].includes(node.text)) forbidden.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(forbidden).toEqual([]);
});
