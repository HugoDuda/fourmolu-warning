"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const { after, before, test } = require("node:test");

const workspaceRoot = path.resolve(__dirname, "fixture-workspace");
const callbacks = {};
const commands = new Map();
const diagnosticsByUri = new Map();
const executions = [];
const settings = new Map();
let workspaceFolders;
let processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
let quickFixProvider;
let hoverProvider;

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = "file";
  }

  toString() {
    return `file://${this.fsPath}`;
  }
}

workspaceFolders = [makeWorkspaceFolder(workspaceRoot)];

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = typeof base === "string" ? new Uri(base) : base.uri;
    this.pattern = pattern;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
  }

  contains(position) {
    const startsBefore =
      position.line > this.startLine ||
      (position.line === this.startLine && position.character >= this.startCharacter);
    const endsAfter =
      position.line < this.endLine ||
      (position.line === this.endLine && position.character <= this.endCharacter);
    return startsBefore && endsAfter;
  }
}

class MarkdownString {
  constructor(value = "") {
    this.value = value;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

const diagnosticCollection = {
  clear: () => diagnosticsByUri.clear(),
  delete: (uri) => diagnosticsByUri.delete(uri.toString()),
  dispose: () => {},
  set: (uri, values) => diagnosticsByUri.set(uri.toString(), values),
};

const vscode = {
  CodeAction,
  CodeActionKind: { QuickFix: "quickfix" },
  Diagnostic,
  DiagnosticSeverity: { Warning: 1 },
  Hover,
  MarkdownString,
  Position,
  RelativePattern,
  Range,
  Uri,
  commands: {
    registerCommand(name, callback) {
      commands.set(name, callback);
      return { dispose() {} };
    },
  },
  languages: {
    createDiagnosticCollection: () => diagnosticCollection,
    match(selector, document) {
      const relativePath = path
        .relative(selector.pattern.baseUri.fsPath, document.uri.fsPath)
        .split(path.sep)
        .join("/");
      return matchesGlob(relativePath, selector.pattern.pattern) ? 10 : 0;
    },
    registerCodeActionsProvider(_selector, provider) {
      quickFixProvider = provider;
      return { dispose() {} };
    },
    registerHoverProvider(_selector, provider) {
      hoverProvider = provider;
      return { dispose() {} };
    },
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      appendLine() {},
      dispose() {},
      show() {},
    }),
    showWarningMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (name, fallback) =>
        settings.has(name) ? settings.get(name) : fallback,
    }),
    getWorkspaceFolder(uri) {
      return workspaceFolders.find((folder) => {
        const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
        return relativePath === "" || !relativePath.startsWith("..");
      });
    },
    onDidChangeConfiguration(callback) {
      callbacks.changeConfiguration = callback;
      return { dispose() {} };
    },
    onDidChangeTextDocument(callback) {
      callbacks.change = callback;
      return { dispose() {} };
    },
    onDidOpenTextDocument(callback) {
      callbacks.open = callback;
      return { dispose() {} };
    },
    onDidCloseTextDocument(callback) {
      callbacks.close = callback;
      return { dispose() {} };
    },
    onDidSaveTextDocument(callback) {
      callbacks.save = callback;
      return { dispose() {} };
    },
    openTextDocument: async (uri) => makeDocument(uri.fsPath),
    textDocuments: [],
  },
};

const originalLoad = Module._load;
const originalExecFile = childProcess.execFile;

before(async () => {
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  childProcess.execFile = (executable, args, options, callback) => {
    executions.push({ executable, args, options });
    const result = processBehavior(args);
    const error = result.exitCode === 0
      ? null
      : Object.assign(new Error("Fourmolu failed"), { code: result.exitCode });
    setImmediate(() => callback(error, result.stdout, result.stderr));
  };

  const startupDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "AlreadyOpen.hs"),
  );
  vscode.workspace.textDocuments = [startupDocument];
  const extension = require("../extension");
  extension.activate({ subscriptions: [] });
  await waitForCheck();

  assert.equal(executions.length, 1);
  reset();
  vscode.workspace.textDocuments = [];
});

after(() => {
  require("../extension").deactivate();
  Module._load = originalLoad;
  childProcess.execFile = originalExecFile;
});

test("reports any unformatted .hs file and offers a quick fix", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : "module Example where\n\nvalue = 1\n",
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Unformatted.hs"),
    "module Example where\n\nvalue=1\n",
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 2);
  assert.deepEqual(executions[0].args, [
    "-m",
    "check",
    "-q",
    document.uri.fsPath,
  ]);
  assert.equal(executions[0].executable, "fourmolu");
  assert.equal(executions[0].options.cwd, workspaceRoot);
  assert.equal(
    executions.some(({ args }) => args.includes("-i")),
    false,
    "checking formatting must not modify the document",
  );
  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(diagnostic.code, "unformatted");
  assert.equal(
    diagnostic.message,
    "This Haskell block does not match the configured Fourmolu format.",
  );
  assert.deepEqual(rangeFields(diagnostic.range), {
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: "value=1".length,
  });

  const hover = hoverProvider.provideHover(document, new vscode.Position(2, 0));
  assert.equal(
    hover.contents[0].value,
    "```haskell\nvalue = 1\n```",
  );
  assert.equal(
    hoverProvider.provideHover(document, new vscode.Position(1, 0)),
    undefined,
  );

  const actions = quickFixProvider.provideCodeActions(document, undefined, {
    diagnostics: [diagnostic],
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].command.command, "fourmoluWarning.formatCurrentFile");

  callbacks.change({ document });
  assert.equal(
    hoverProvider.provideHover(document, new vscode.Position(2, 0)),
    undefined,
  );
});

test("reports one diagnostic for each separate Fourmolu formatting block", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check")
      ? ""
      : [
        "module Example where",
        "",
        "first = 1",
        "unchanged = True",
        "second = 2",
        "",
      ].join("\n"),
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "TwoBlocks.hs"),
    [
      "module Example where",
      "",
      "first=1",
      "unchanged = True",
      "second=2",
      "",
    ].join("\n"),
  );

  callbacks.save(document);
  await waitForCheck();

  const diagnostics = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((diagnostic) => rangeFields(diagnostic.range)),
    [
      {
        startLine: 2,
        startCharacter: 0,
        endLine: 2,
        endCharacter: "first=1".length,
      },
      {
        startLine: 4,
        startCharacter: 0,
        endLine: 4,
        endCharacter: "second=2".length,
      },
    ],
  );
});

test("reports one diagnostic spanning a multi-line Fourmolu formatting block", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check")
      ? ""
      : [
        "module Example where",
        "",
        "value = do",
        "  item <- pure 1",
        "  print item",
        "",
      ].join("\n"),
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "MultiLine.hs"),
    [
      "module Example where",
      "",
      "value=do",
      "  item<-pure 1",
      "  print item",
      "",
    ].join("\n"),
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.deepEqual(rangeFields(diagnostic.range), {
    startLine: 2,
    startCharacter: 0,
    endLine: 3,
    endCharacter: "  item<-pure 1".length,
  });
});

test("reports reordered imports as one block with their formatted output", async () => {
  reset();
  const source = [
    "import qualified Tokens as T",
    "import qualified Ast as A",
    "import qualified ParserHelper as H",
    "import qualified ParserBinOp2 as POP",
    "type SingleToken = (T.Token, (Int, Int))",
    "type Parser a = [SingleToken] -> Either String (a, [SingleToken])",
    "",
  ].join("\n");
  const formatted = [
    "import qualified Ast as A",
    "import qualified ParserBinOp2 as POP",
    "import qualified ParserHelper as H",
    "import qualified Tokens as T",
    "type SingleToken = (T.Token, (Int, Int))",
    "type Parser a = [SingleToken] -> Either String (a, [SingleToken])",
    "",
  ].join("\n");
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : formatted,
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Imports.hs"),
    source,
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnosticsByUri.get(document.uri.toString()).length, 1);
  assert.equal(
    diagnostic.message,
    "This import block must be reordered to match the configured Fourmolu import order.",
  );
  assert.deepEqual(rangeFields(diagnostic.range), {
    startLine: 0,
    startCharacter: 0,
    endLine: 3,
    endCharacter: "import qualified ParserBinOp2 as POP".length,
  });
  const hover = hoverProvider.provideHover(document, new vscode.Position(0, 0));
  assert.equal(
    hover.contents[0].value,
    `\`\`\`haskell\n${formatted.split("\n").slice(0, 4).join("\n")}\n\`\`\``,
  );
});

test("reports reformatted module documentation with its declaration as one block", async () => {
  reset();
  const source = [
    "-------------------------------------------------------------------------------",
    "-- |",
    "-- Module      : ParserBinaryExpr",
    "-- Description : Parses binary operation expressions with operator precedence.",
    "-- License     : MIT",
    "--",
    "-- Parsing of binary operation expressions",
    "-------------------------------------------------------------------------------",
    "module ParserBinaryExpr (",
    "    parseBinaryOpExpr,",
    ") where",
    "",
  ].join("\n");
  const formatted = [
    "{- |",
    "Module      : ParserBinaryExpr",
    "Description : Parses binary operation expressions with operator precedence.",
    "License     : MIT",
    "",
    "Parsing of binary operation expressions",
    "-}",
    "module ParserBinaryExpr (",
    "    parseBinaryOpExpr,",
    ") where",
    "",
  ].join("\n");
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : formatted,
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "ModuleDocumentation.hs"),
    source,
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnosticsByUri.get(document.uri.toString()).length, 1);
  assert.equal(
    diagnostic.message,
    "This module documentation does not match the configured Fourmolu Haddock style.",
  );
  assert.deepEqual(rangeFields(diagnostic.range), {
    startLine: 0,
    startCharacter: 0,
    endLine: 10,
    endCharacter: ") where".length,
  });
  const hover = hoverProvider.provideHover(document, new vscode.Position(8, 0));
  assert.equal(
    hover.contents[0].value,
    `\`\`\`haskell\n${formatted.trimEnd()}\n\`\`\``,
  );
});

test("labels a formatted comment as documentation", async () => {
  reset();
  const source = [
    "module Example where",
    "",
    "--A documented value.",
    "value = 1",
    "",
  ].join("\n");
  const formatted = [
    "module Example where",
    "",
    "-- A documented value.",
    "value = 1",
    "",
  ].join("\n");
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : formatted,
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Comment.hs"),
    source,
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(
    diagnostic.message,
    "This module documentation does not match the configured Fourmolu Haddock style.",
  );
  assert.deepEqual(rangeFields(diagnostic.range), {
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: "--A documented value.".length,
  });
});

test("clears the diagnostic when the Fourmolu check passes", async () => {
  reset();
  processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
  const document = makeDocument(
    path.join(workspaceRoot, "test", "ExampleSpec.hs"),
  );
  diagnosticsByUri.set(document.uri.toString(), [{ code: "unformatted" }]);

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(diagnosticsByUri.has(document.uri.toString()), false);
});

test("checks a saved Haskell file when it is opened", async () => {
  reset();
  processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Opened.hs"),
  );

  callbacks.open(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].args, [
    "-m",
    "check",
    "-q",
    document.uri.fsPath,
  ]);
});

test("ignores files matched by the default build-directory exclusions", async () => {
  reset();
  const document = makeDocument(
    path.join(workspaceRoot, ".stack-work", "generated", "Ignored.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 0);
  assert.equal(diagnosticsByUri.size, 0);
});

test("supports custom globs, arguments and a workspace-relative executable", async () => {
  reset();
  settings.set("include", ["services/**/*.hs"]);
  settings.set("exclude", ["**/Generated/**"]);
  settings.set("extraArguments", ["-o", "-XImportQualifiedPost"]);
  settings.set("executablePath", "tools/fourmolu");
  const document = makeDocument(
    path.join(workspaceRoot, "services", "api", "Handler.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(
    executions[0].executable,
    path.join(workspaceRoot, "tools", "fourmolu"),
  );
  assert.deepEqual(executions[0].args, [
    "-o",
    "-XImportQualifiedPost",
    "-m",
    "check",
    "-q",
    document.uri.fsPath,
  ]);
});

test("uses the workspace folder containing the file in a multi-root workspace", async () => {
  reset();
  const secondRoot = path.resolve(__dirname, "second-workspace");
  workspaceFolders = [
    makeWorkspaceFolder(workspaceRoot),
    makeWorkspaceFolder(secondRoot),
  ];
  const document = makeDocument(path.join(secondRoot, "src", "Second.hs"));

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(executions[0].options.cwd, secondRoot);
});

test("uses the saved file's directory outside a workspace", async () => {
  reset();
  workspaceFolders = [];
  const document = makeDocument("/tmp/fourmolu-warning-fixture/Standalone.hs");

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(
    executions[0].options.cwd,
    "/tmp/fourmolu-warning-fixture",
  );
});

function makeDocument(filePath, text = "module Example where\n") {
  const lines = text.split("\n");
  return {
    isDirty: false,
    getText: () => text,
    lineAt: (line) => ({ text: lines[line] }),
    lineCount: lines.length,
    save: async () => true,
    uri: new Uri(filePath),
  };
}

function reset() {
  executions.length = 0;
  diagnosticsByUri.clear();
  settings.clear();
  workspaceFolders = [makeWorkspaceFolder(workspaceRoot)];
}

function waitForCheck() {
  return new Promise((resolve) => setTimeout(resolve, 325));
}

function makeWorkspaceFolder(root) {
  return { uri: new Uri(root) };
}

function rangeFields(range) {
  return {
    startLine: range.startLine,
    startCharacter: range.startCharacter,
    endLine: range.endLine,
    endCharacter: range.endCharacter,
  };
}

function matchesGlob(relativePath, glob) {
  const expression = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", "(?:.*/)?")
    .replaceAll("\u0001", ".*");
  return new RegExp(`^${expression}$`).test(relativePath);
}
