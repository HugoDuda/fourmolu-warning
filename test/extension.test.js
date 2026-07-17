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
const resourceSettings = new Map();
const outputLines = [];
const warningMessages = [];
const deferredExecutions = [];
let workspaceFolders;
let processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
let quickFixProvider;
let hoverProvider;
let outputChannelName;

class Uri {
  constructor(fsPath, scheme = "file") {
    this.fsPath = fsPath;
    this.scheme = scheme;
    this.path = fsPath.split(path.sep).join("/");
  }

  toString() {
    return `${this.scheme}://${this.fsPath}`;
  }

  with(changes) {
    return new Uri(changes.path ?? this.fsPath, changes.scheme ?? this.scheme);
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
    this.baseUri = typeof base === "string" ? new Uri(base) : base.uri || base;
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
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
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
      if (selector.scheme && selector.scheme !== document.uri.scheme) {
        return 0;
      }
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
    createOutputChannel: (name) => {
      outputChannelName = name;
      return {
        appendLine(line) {
          outputLines.push(line);
        },
        dispose() {},
        show() {},
      };
    },
    showWarningMessage(message, ...items) {
      warningMessages.push({ message, items });
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration: (_section, resource) => ({
      get: (name, fallback) =>
        resourceSettings.has(resourceSettingKey(resource, name))
          ? resourceSettings.get(resourceSettingKey(resource, name))
          : settings.has(name)
            ? settings.get(name)
            : fallback,
    }),
    getWorkspaceFolder(uri) {
      return workspaceFolders.find((folder) => {
        if (folder.uri.scheme !== uri.scheme) {
          return false;
        }
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
    openTextDocument: async (uri) => makeDocument(uri.fsPath, undefined, uri.scheme),
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
    const result = processBehavior(args, executable, options);
    if (result.defer) {
      deferredExecutions.push({ callback });
      return { kill() {} };
    }
    setImmediate(() => completeProcess(callback, result));
    return { kill() {} };
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
  assert.equal(actions[0].command.command, "fourmoluChecker.formatCurrentFile");

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

test("labels blocks where Fourmolu removes only extra spaces", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check")
      ? ""
      : "module Example where\n\nvalue = 1\n",
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "ExtraSpaces.hs"),
    "module Example where\n\nvalue  =  1\n",
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(
    diagnostic.message,
    "This block contains extra spaces that Fourmolu removes.",
  );
});

test("labels blocks where Fourmolu removes only extra blank lines", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check")
      ? ""
      : "module Example where\n\nfirst = 1\n\nsecond = 2\n",
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "ExtraBlankLines.hs"),
    "module Example where\n\nfirst = 1\n\n\nsecond = 2\n",
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(
    diagnostic.message,
    "This block contains extra blank lines that Fourmolu removes.",
  );
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
  const document = makeDocument("/tmp/fourmolu-checker-fixture/Standalone.hs");

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(
    executions[0].options.cwd,
    "/tmp/fourmolu-checker-fixture",
  );
});

test("resolves a standalone relative executable from the file directory", async () => {
  reset();
  workspaceFolders = [];
  settings.set("executablePath", "${workspaceFolder}/tools/fourmolu");
  const document = makeDocument(
    "/tmp/fourmolu-checker-fixture/Standalone With Spaces.hs",
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(
    executions[0].executable,
    "/tmp/fourmolu-checker-fixture/tools/fourmolu",
  );
  assert.equal(executions[0].options.cwd, "/tmp/fourmolu-checker-fixture");
});

test("resolves Windows executable paths without shell interpolation", () => {
  const { resolveExecutable } = require("../extension");
  const root = "C:\\workspace with spaces";

  assert.equal(
    resolveExecutable("tools\\fourmolu.exe", root, path.win32),
    "C:\\workspace with spaces\\tools\\fourmolu.exe",
  );
  assert.equal(
    resolveExecutable("${workspaceFolder}\\bin\\fourmolu.exe", root, path.win32),
    "C:\\workspace with spaces\\bin\\fourmolu.exe",
  );
  assert.equal(
    resolveExecutable("C:\\Tools\\fourmolu.exe", root, path.win32),
    "C:\\Tools\\fourmolu.exe",
  );
});

test("uses absolute executable paths and file paths containing spaces", async () => {
  reset();
  const root = path.join("/tmp", "Fourmolu Workspace");
  const executable = path.join("/opt", "Fourmolu Tools", "fourmolu");
  workspaceFolders = [makeWorkspaceFolder(root)];
  settings.set("executablePath", executable);
  const document = makeDocument(
    path.join(root, "src", "File With Spaces.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(executions[0].executable, executable);
  assert.equal(executions[0].options.cwd, root);
  assert.equal(executions[0].args.at(-1), document.uri.fsPath);
});

test("resolves relative executables and workspaceFolder per workspace folder", async () => {
  reset();
  const firstRoot = path.join("/tmp", "first Fourmolu workspace");
  const secondRoot = path.join("/tmp", "second Fourmolu workspace");
  workspaceFolders = [
    makeWorkspaceFolder(firstRoot),
    makeWorkspaceFolder(secondRoot),
  ];
  const firstDocument = makeDocument(path.join(firstRoot, "src", "First.hs"));
  const secondDocument = makeDocument(path.join(secondRoot, "src", "Second.hs"));
  setResourceSetting(
    firstDocument,
    "executablePath",
    "${workspaceFolder}/tools/first-fourmolu",
  );
  setResourceSetting(secondDocument, "executablePath", "tools/second-fourmolu");

  callbacks.save(firstDocument);
  await waitForCheck();
  callbacks.save(secondDocument);
  await waitForCheck();

  assert.equal(executions.length, 2);
  assert.equal(
    executions[0].executable,
    path.join(firstRoot, "tools", "first-fourmolu"),
  );
  assert.equal(
    executions[1].executable,
    path.join(secondRoot, "tools", "second-fourmolu"),
  );
  assert.equal(executions[0].options.cwd, firstRoot);
  assert.equal(executions[1].options.cwd, secondRoot);
});

test("checks vscode-remote files in their remote workspace folder", async () => {
  reset();
  const remoteRoot = "/home/dev/fourmolu-project";
  workspaceFolders = [makeWorkspaceFolder(remoteRoot, "vscode-remote")];
  const document = makeDocument(
    `${remoteRoot}/src/Remote.hs`,
    "module Remote where\n",
    "vscode-remote",
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(executions[0].executable, "fourmolu");
  assert.equal(executions[0].options.cwd, remoteRoot);
});

test("reports a missing executable once with an execution diagnostic and output context", async () => {
  reset();
  settings.set("executablePath", "tools/missing-fourmolu");
  processBehavior = () => ({
    errorCode: "ENOENT",
    errorMessage: "spawn tools/missing-fourmolu ENOENT",
    stdout: "module Secret where",
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "MissingExecutable.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnostic.code, "execution-failed");
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  assert.match(diagnostic.message, /executable was not found/);
  assert.match(diagnostic.message, /Remote SSH, WSL, or devcontainer/);
  assert.match(
    diagnostic.message,
    new RegExp(path.join(workspaceRoot, "tools", "missing-fourmolu")),
  );
  assert.equal(warningMessages.length, 1);
  assert.match(warningMessages[0].message, /executable was not found/);
  assert.equal(outputChannelName, "Fourmolu Checker");
  assert.match(outputLines.join("\n"), new RegExp(`file: ${document.uri.fsPath}`));
  assert.match(outputLines.join("\n"), /workspace folder:/);
  assert.match(outputLines.join("\n"), /arguments:/);
  assert.match(outputLines.join("\n"), /error code: ENOENT/);
  assert.equal(outputLines.join("\n").includes("module Secret where"), false);

  const firstLogLength = outputLines.length;
  callbacks.save(document);
  await waitForCheck();
  assert.equal(warningMessages.length, 1);
  assert.equal(outputLines.length, firstLogLength);
});

test("classifies permission and Fourmolu parser failures as errors", async () => {
  reset();
  processBehavior = () => ({
    errorCode: "EACCES",
    errorMessage: "spawn fourmolu EACCES",
    stdout: "",
    stderr: "",
  });
  const permissionDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Permission.hs"),
  );

  callbacks.save(permissionDocument);
  await waitForCheck();

  let [diagnostic] = diagnosticsByUri.get(permissionDocument.uri.toString());
  assert.equal(diagnostic.code, "execution-failed");
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  assert.match(diagnostic.message, /not executable/);

  reset();
  processBehavior = (args) => ({
    exitCode: 1,
    stdout: "",
    stderr: args.includes("check") ? "Parser error in input" : "",
  });
  const parserDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "ParserFailure.hs"),
  );

  callbacks.save(parserDocument);
  await waitForCheck();

  [diagnostic] = diagnosticsByUri.get(parserDocument.uri.toString());
  assert.equal(diagnostic.code, "check-failed");
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  assert.match(diagnostic.message, /Parser error in input/);
  assert.match(outputLines.join("\n"), /stderr: Parser error in input/);
});

test("reports malformed formatted output instead of a formatting diagnostic", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: "",
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "MalformedOutput.hs"),
    "module Example where\nvalue = 1\n",
  );

  callbacks.save(document);
  await waitForCheck();

  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnostic.code, "invalid-output");
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);

  reset();
  const source = "module Example where\nvalue = 1\n";
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : source,
    stderr: "",
  });
  const unchangedDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "UnchangedOutput.hs"),
    source,
  );

  callbacks.save(unchangedDocument);
  await waitForCheck();

  assert.equal(
    diagnosticsByUri.get(unchangedDocument.uri.toString())[0].code,
    "invalid-output",
  );
});

test("uses configured formatting severity and falls back to warning", async () => {
  reset();
  settings.set("diagnosticSeverity", "information");
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : "module Example where\nvalue = 1\n",
    stderr: "",
  });
  const informationDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Information.hs"),
    "module Example where\nvalue=1\n",
  );

  callbacks.save(informationDocument);
  await waitForCheck();

  assert.equal(
    diagnosticsByUri.get(informationDocument.uri.toString())[0].severity,
    vscode.DiagnosticSeverity.Information,
  );

  reset();
  settings.set("diagnosticSeverity", "invalid-value");
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: args.includes("check") ? "" : "module Example where\nvalue = 1\n",
    stderr: "",
  });
  const fallbackDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "SeverityFallback.hs"),
    "module Example where\nvalue=1\n",
  );

  callbacks.save(fallbackDocument);
  await waitForCheck();

  assert.equal(
    diagnosticsByUri.get(fallbackDocument.uri.toString())[0].severity,
    vscode.DiagnosticSeverity.Warning,
  );
});

test("clears stale diagnostics when checking is disabled or a file becomes excluded", async () => {
  reset();
  const disabledDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Disabled.hs"),
  );
  diagnosticsByUri.set(disabledDocument.uri.toString(), [{ code: "unformatted" }]);
  settings.set("enabled", false);

  callbacks.save(disabledDocument);
  await waitForCheck();

  assert.equal(executions.length, 0);
  assert.equal(diagnosticsByUri.has(disabledDocument.uri.toString()), false);

  reset();
  const excludedDocument = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Excluded.hs"),
  );
  diagnosticsByUri.set(excludedDocument.uri.toString(), [{ code: "unformatted" }]);
  settings.set("exclude", ["**/*.hs"]);

  callbacks.save(excludedDocument);
  await waitForCheck();

  assert.equal(executions.length, 0);
  assert.equal(diagnosticsByUri.has(excludedDocument.uri.toString()), false);
});

test("invalidates an in-flight check after a relevant configuration change", async () => {
  reset();
  processBehavior = () => ({ defer: true });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "ConfigurationRace.hs"),
    "module Example where\nvalue=1\n",
  );
  vscode.workspace.textDocuments = [document];

  callbacks.save(document);
  await waitForCheck();
  assert.equal(executions.length, 1);

  settings.set("enabled", false);
  callbacks.changeConfiguration({
    affectsConfiguration: (name) => name === "fourmoluChecker",
  });
  completeDeferredExecution(0, { exitCode: 1, stdout: "", stderr: "" });
  await flushProcess();
  await waitForCheck();

  assert.equal(diagnosticsByUri.has(document.uri.toString()), false);
  assert.equal(executions.length, 1);
});

test("keeps a newer diagnostic when an older execution finishes later", async () => {
  reset();
  processBehavior = () => ({ defer: true });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "StaleExecution.hs"),
    "module Example where\nvalue=1\n",
  );

  callbacks.save(document);
  await waitForCheck();
  assert.equal(executions.length, 1);

  callbacks.change({ document });
  callbacks.save(document);
  await waitForCheck();
  assert.equal(executions.length, 2);

  completeDeferredExecution(1, { exitCode: 1, stdout: "", stderr: "" });
  await flushProcess();
  assert.equal(executions.length, 3);
  completeDeferredExecution(2, {
    exitCode: 0,
    stdout: "module Example where\nvalue = 1\n",
    stderr: "",
  });
  await flushProcess();
  assert.equal(
    diagnosticsByUri.get(document.uri.toString())[0].code,
    "unformatted",
  );

  completeDeferredExecution(0, { exitCode: 0, stdout: "", stderr: "" });
  await flushProcess();
  assert.equal(
    diagnosticsByUri.get(document.uri.toString())[0].code,
    "unformatted",
  );
});

test("clears diagnostics and ignores checks after closing a document", async () => {
  reset();
  processBehavior = () => ({ defer: true });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Closed.hs"),
  );

  callbacks.save(document);
  await waitForCheck();
  diagnosticsByUri.set(document.uri.toString(), [{ code: "unformatted" }]);
  callbacks.close(document);
  completeDeferredExecution(0, { exitCode: 0, stdout: "", stderr: "" });
  await flushProcess();

  assert.equal(diagnosticsByUri.has(document.uri.toString()), false);
});

test("does not run automatic checks when checkOnSave is disabled", async () => {
  reset();
  settings.set("checkOnSave", false);
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "CheckOnSaveDisabled.hs"),
  );

  callbacks.open(document);
  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 0);
});

function makeDocument(filePath, text = "module Example where\n", scheme = "file") {
  const lines = text.split("\n");
  return {
    isDirty: false,
    getText: () => text,
    lineAt: (line) => ({ text: lines[line] }),
    lineCount: lines.length,
    save: async () => true,
    uri: new Uri(filePath, scheme),
  };
}

function reset() {
  executions.length = 0;
  diagnosticsByUri.clear();
  settings.clear();
  resourceSettings.clear();
  outputLines.length = 0;
  warningMessages.length = 0;
  deferredExecutions.length = 0;
  processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
  workspaceFolders = [makeWorkspaceFolder(workspaceRoot)];
  vscode.workspace.textDocuments = [];
  vscode.window.activeTextEditor = undefined;
}

function waitForCheck() {
  return new Promise((resolve) => setTimeout(resolve, 325));
}

function makeWorkspaceFolder(root, scheme = "file") {
  return { uri: new Uri(root, scheme) };
}

function setResourceSetting(document, name, value) {
  resourceSettings.set(resourceSettingKey(document.uri, name), value);
}

function resourceSettingKey(resource, name) {
  return `${resource?.toString() || "global"}\u0000${name}`;
}

function completeProcess(callback, result) {
  const failed = result.errorCode || result.exitCode !== 0;
  const error = failed
    ? Object.assign(
      new Error(result.errorMessage || "Fourmolu failed"),
      { code: result.errorCode ?? result.exitCode },
    )
    : null;
  callback(error, result.stdout || "", result.stderr || "");
}

function completeDeferredExecution(index, result) {
  const execution = deferredExecutions[index];
  assert.ok(execution, `missing deferred execution ${index}`);
  completeProcess(execution.callback, result);
}

function flushProcess() {
  return new Promise((resolve) => setImmediate(resolve));
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
