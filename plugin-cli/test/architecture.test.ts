import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, "..", "src");
const MAX_SOURCE_LINES = 650;

interface ParsedModule {
  readonly absPath: string;
  readonly relPath: string;
  readonly layer: "root" | "domain" | "engine" | "tui" | "cli";
  readonly lineCount: number;
  readonly sourceFile: ts.SourceFile;
  readonly imports: readonly { readonly specifier: string; readonly typeOnly: boolean }[];
  readonly exportedNames: readonly string[];
}

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(abs)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out.sort();
}

function classifyLayer(relPath: string): ParsedModule["layer"] {
  if (relPath.startsWith("domain/")) {
    return "domain";
  }
  if (relPath.startsWith("engine/")) {
    return "engine";
  }
  if (relPath.startsWith("tui/")) {
    return "tui";
  }
  if (relPath.startsWith("cli/")) {
    return "cli";
  }
  return "root";
}

function parseModule(absPath: string, text: string): ParsedModule {
  const relPath = path.relative(SRC_ROOT, absPath).replace(/\\/g, "/");
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
  const imports: { specifier: string; typeOnly: boolean }[] = [];
  const exportedNames: string[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      const typeOnly = Boolean(
        clause?.isTypeOnly ||
          (clause?.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((el) => el.isTypeOnly)),
      );
      imports.push({ specifier: stmt.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      imports.push({ specifier: stmt.moduleSpecifier.text, typeOnly: stmt.isTypeOnly });
    }

    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    if (!isExported) {
      continue;
    }
    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      exportedNames.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exportedNames.push(decl.name.text);
        }
      }
    }
  }

  return {
    absPath,
    relPath,
    layer: classifyLayer(relPath),
    lineCount: text.split("\n").length,
    sourceFile,
    imports,
    exportedNames,
  };
}

async function loadAllSourceModules(): Promise<readonly ParsedModule[]> {
  const files = await listTsFiles(SRC_ROOT);
  const modules: ParsedModule[] = [];
  for (const absPath of files) {
    const text = await fs.readFile(absPath, "utf8");
    modules.push(parseModule(absPath, text));
  }
  return modules;
}

describe("Structural architecture invariants", () => {
  it("keeps every source module under the 650-line readability budget", async () => {
    const modules = await loadAllSourceModules();
    const oversized = modules
      .filter((m) => m.lineCount > MAX_SOURCE_LINES)
      .map((m) => `${m.relPath} (${m.lineCount} lines)`);
    assert.deepEqual(oversized, [], `Files exceeding ${MAX_SOURCE_LINES} lines: ${oversized.join(", ")}`);
  });

  it("enforces strict layer DAG and engine/internal isolation", async () => {
    const modules = await loadAllSourceModules();
    const allowedDeps: Record<ParsedModule["layer"], ReadonlySet<ParsedModule["layer"]>> = {
      domain: new Set(["domain"]),
      engine: new Set(["domain", "engine"]),
      tui: new Set(["domain", "engine", "tui"]),
      cli: new Set(["domain", "engine", "tui", "cli"]),
      root: new Set(["domain", "engine", "tui", "cli", "root"]),
    };

    const violations: string[] = [];
    for (const mod of modules) {
      for (const imp of mod.imports) {
        if (!imp.specifier.startsWith(".")) {
          continue;
        }
        const targetAbs = path.resolve(path.dirname(mod.absPath), imp.specifier);
        const targetRel = path.relative(SRC_ROOT, targetAbs).replace(/\\/g, "/");
        const targetLayer = classifyLayer(targetRel);

        if (!allowedDeps[mod.layer].has(targetLayer)) {
          violations.push(`${mod.relPath} (${mod.layer}) -> ${targetRel} (${targetLayer})`);
        }
        if (mod.layer !== "engine" && targetRel.startsWith("engine/internal/")) {
          violations.push(`${mod.relPath} imports private engine internal ${targetRel}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Layer/boundary violations:\n${violations.join("\n")}`);
  });

  it("forbids runtime circular imports across src/", async () => {
    const modules = await loadAllSourceModules();
    const byRel = new Map(modules.map((m) => [m.relPath, m]));
    const graph = new Map<string, string[]>();

    for (const mod of modules) {
      const deps: string[] = [];
      for (const imp of mod.imports) {
        if (imp.typeOnly || !imp.specifier.startsWith(".")) {
          continue;
        }
        const targetRel = path
          .relative(SRC_ROOT, path.resolve(path.dirname(mod.absPath), imp.specifier))
          .replace(/\\/g, "/");
        if (byRel.has(targetRel)) {
          deps.push(targetRel);
        }
      }
      graph.set(mod.relPath, deps);
    }

    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const cycles: string[] = [];

    function dfs(node: string): void {
      state.set(node, "visiting");
      stack.push(node);
      for (const next of graph.get(node) ?? []) {
        const nextState = state.get(next);
        if (nextState === "visiting") {
          const idx = stack.indexOf(next);
          cycles.push([...stack.slice(idx), next].join(" -> "));
        } else if (nextState === undefined) {
          dfs(next);
        }
      }
      stack.pop();
      state.set(node, "done");
    }

    for (const mod of modules) {
      if (!state.has(mod.relPath)) {
        dfs(mod.relPath);
      }
    }
    assert.deepEqual(cycles, [], `Runtime import cycles detected:\n${cycles.join("\n")}`);
  });

  it("forbids any, enum, and unsafe type assertions across src/", async () => {
    const modules = await loadAllSourceModules();
    const violations: string[] = [];

    for (const mod of modules) {
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const pos = mod.sourceFile.getLineAndCharacterOfPosition(node.getStart(mod.sourceFile));
          violations.push(`${mod.relPath}:${pos.line + 1} uses 'any'`);
        } else if (ts.isEnumDeclaration(node)) {
          const pos = mod.sourceFile.getLineAndCharacterOfPosition(node.getStart(mod.sourceFile));
          violations.push(`${mod.relPath}:${pos.line + 1} declares enum '${node.name.text}'`);
        } else if (ts.isAsExpression(node)) {
          const isConstAssertion =
            ts.isTypeReferenceNode(node.type) &&
            ts.isIdentifier(node.type.typeName) &&
            node.type.typeName.text === "const";
          if (!isConstAssertion) {
            const pos = mod.sourceFile.getLineAndCharacterOfPosition(node.getStart(mod.sourceFile));
            violations.push(`${mod.relPath}:${pos.line + 1} uses unsafe 'as' assertion`);
          }
        } else if (ts.isTypeAssertionExpression(node)) {
          const pos = mod.sourceFile.getLineAndCharacterOfPosition(node.getStart(mod.sourceFile));
          violations.push(`${mod.relPath}:${pos.line + 1} uses angle-bracket type assertion`);
        }
        ts.forEachChild(node, visit);
      };
      visit(mod.sourceFile);
    }

    assert.deepEqual(violations, [], `Type discipline violations:\n${violations.join("\n")}`);
  });

  it("forbids unused exports inside src/engine/internal/", async () => {
    const modules = await loadAllSourceModules();
    const engineModules = modules.filter((m) => m.layer === "engine");
    const internalModules = engineModules.filter((m) => m.relPath.startsWith("engine/internal/"));
    const unused: string[] = [];

    for (const mod of internalModules) {
      for (const name of mod.exportedNames) {
        const pattern = new RegExp(`\\b${name}\\b`);
        const referencedElsewhere = engineModules.some(
          (other) => other.relPath !== mod.relPath && pattern.test(other.sourceFile.text),
        );
        if (!referencedElsewhere) {
          unused.push(`${mod.relPath}::${name}`);
        }
      }
    }
    assert.deepEqual(unused, [], `Unused internal exports:\n${unused.join("\n")}`);
  });
});
