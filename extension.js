"use strict";

const childProcess = require("child_process");
const path = require("path");
const vscode = require("vscode");

const SOURCE = "fourmolu-checker";
const CHECK_COMMAND = "fourmoluChecker.checkCurrentFile";
const FORMAT_COMMAND = "fourmoluChecker.formatCurrentFile";
const CHECK_DELAY_MS = 250;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024;
const OUTPUT_CHANNEL_NAME = "Fourmolu Checker";
const FORMATTING_MESSAGES = {
  importsReordered:
    "This import block must be reordered to match the configured Fourmolu import order.",
  moduleDocumentation:
    "This module documentation does not match the configured Fourmolu Haddock style.",
  generic: "This Haskell block does not match the configured Fourmolu format.",
};

let diagnostics;
let output;
let active = false;
const generations = new Map();
const pendingChecks = new Map();
const reportedToolFailures = new Map();
const formattingHovers = new Map();

function activate(context) {
  active = true;
  diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  context.subscriptions.push(
    diagnostics,
    output,
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (setting(document, "checkOnSave", true)) {
        scheduleCheck(document);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      scheduleSavedDocument(document);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      cancelScheduledCheck(document.uri);
      invalidate(document.uri);
      diagnostics.delete(document.uri);
      formattingHovers.delete(document.uri.toString());
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancelScheduledCheck(document.uri);
      invalidate(document.uri);
      generations.delete(document.uri.toString());
      diagnostics.delete(document.uri);
      formattingHovers.delete(document.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("fourmoluChecker")) {
        return;
      }

      diagnostics.clear();
      formattingHovers.clear();
      reportedToolFailures.clear();
      for (const document of vscode.workspace.textDocuments) {
        cancelScheduledCheck(document.uri);
        invalidate(document.uri);
        if (!document.isDirty) {
          scheduleSavedDocument(document);
        }
      }
    }),
    vscode.commands.registerCommand(CHECK_COMMAND, checkCurrentFile),
    vscode.commands.registerCommand(FORMAT_COMMAND, formatCurrentFile),
    vscode.languages.registerCodeActionsProvider(
      { language: "haskell" },
      new FourmoluQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.languages.registerHoverProvider(
      { language: "haskell" },
      new FourmoluHoverProvider(),
    ),
  );

  for (const document of vscode.workspace.textDocuments) {
    scheduleSavedDocument(document);
  }
}

function deactivate() {
  active = false;
  for (const timeout of pendingChecks.values()) {
    clearTimeout(timeout);
  }
  pendingChecks.clear();
  generations.clear();
  reportedToolFailures.clear();
  formattingHovers.clear();
  diagnostics?.clear();
}

class FourmoluQuickFixProvider {
  provideCodeActions(document, _range, context) {
    const fourmoluDiagnostic = context.diagnostics.find(
      (diagnostic) =>
        diagnostic.source === SOURCE && diagnostic.code === "unformatted",
    );
    if (!fourmoluDiagnostic) {
      return [];
    }

    const action = new vscode.CodeAction(
      "Format this file with Fourmolu",
      vscode.CodeActionKind.QuickFix,
    );
    action.command = {
      command: FORMAT_COMMAND,
      title: "Format this file with Fourmolu",
      arguments: [document.uri],
    };
    action.diagnostics = [fourmoluDiagnostic];
    action.isPreferred = true;
    return [action];
  }
}

class FourmoluHoverProvider {
  provideHover(document, position) {
    const block = formattingHovers
      .get(document.uri.toString())
      ?.find(({ range }) => range.contains(position));
    if (!block) {
      return undefined;
    }

    const contents = block.formattedText
      ? `${fencedCodeBlock(block.formattedText)}`
      : "Fourmolu removes this block.";
    return new vscode.Hover(new vscode.MarkdownString(contents), block.range);
  }
}

function setting(document, name, fallback) {
  return vscode.workspace
    .getConfiguration("fourmoluChecker", document.uri)
    .get(name, fallback);
}

function scheduleCheck(document) {
  cancelScheduledCheck(document.uri);
  const key = document.uri.toString();
  const timeout = setTimeout(() => {
    pendingChecks.delete(key);
    void checkDocument(document);
  }, CHECK_DELAY_MS);
  pendingChecks.set(key, timeout);
}

function scheduleSavedDocument(document) {
  if (!document.isDirty && setting(document, "checkOnSave", true)) {
    scheduleCheck(document);
  }
}

function cancelScheduledCheck(uri) {
  const key = uri.toString();
  const timeout = pendingChecks.get(key);
  if (timeout) {
    clearTimeout(timeout);
    pendingChecks.delete(key);
  }
}

function invalidate(uri) {
  const key = uri.toString();
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  return generation;
}

function isCurrent(uri, generation) {
  return active && generations.get(uri.toString()) === generation;
}

async function checkCurrentFile(uri) {
  const document = await targetDocument(uri);
  if (!document) {
    return;
  }
  if (document.isDirty && !(await document.save())) {
    void vscode.window.showWarningMessage(
      "Fourmolu check cancelled because the file could not be saved.",
    );
    return;
  }

  cancelScheduledCheck(document.uri);
  await checkDocument(document);
}

async function formatCurrentFile(uri) {
  const document = await targetDocument(uri);
  if (!document) {
    return;
  }
  if (document.isDirty && !(await document.save())) {
    void vscode.window.showWarningMessage(
      "Fourmolu formatting cancelled because the file could not be saved.",
    );
    return;
  }
  const context = workspaceContext(document);
  if (!context) {
    return;
  }

  cancelScheduledCheck(document.uri);
  const generation = invalidate(document.uri);
  diagnostics.delete(document.uri);
  formattingHovers.delete(document.uri.toString());

  const executable = selectExecutable(document, context.root);
  const extraArguments = setting(document, "extraArguments", []);
  const args = [...extraArguments, "-i", document.uri.fsPath];
  const result = await runFourmolu(
    executable,
    args,
    context.root,
  );

  if (!isCurrent(document.uri, generation)) {
    return;
  }
  if (!result.started) {
    reportExecutionFailure(document, context, executable, args, result);
    return;
  }
  reportedToolFailures.delete(context.root);
  if (result.exitCode !== 0) {
    reportFourmoluFailure(document, context, executable, args, result, "format");
    return;
  }

  scheduleCheck(document);
}

async function targetDocument(uri) {
  if (uri instanceof vscode.Uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  return vscode.window.activeTextEditor?.document;
}

async function checkDocument(document) {
  const generation = invalidate(document.uri);
  const context = workspaceContext(document);
  if (!context || document.isDirty) {
    diagnostics.delete(document.uri);
    formattingHovers.delete(document.uri.toString());
    return;
  }

  const executable = selectExecutable(document, context.root);
  const extraArguments = setting(document, "extraArguments", []);
  const checkArgs = [...extraArguments, "-m", "check", "-q", document.uri.fsPath];
  const check = await runFourmolu(
    executable,
    checkArgs,
    context.root,
  );

  if (!isCurrent(document.uri, generation)) {
    return;
  }
  if (!check.started) {
    reportExecutionFailure(document, context, executable, checkArgs, check);
    return;
  }
  reportedToolFailures.delete(context.root);
  if (check.exitCode === 0) {
    diagnostics.delete(document.uri);
    formattingHovers.delete(document.uri.toString());
    reportedToolFailures.delete(context.root);
    return;
  }

  // A check-mode failure can mean either bad formatting or a parser/tool
  // error. Formatting to stdout lets us distinguish those without touching
  // the file; this second process only runs when the CI-equivalent check fails.
  const probeArgs = [...extraArguments, document.uri.fsPath];
  const probe = await runFourmolu(executable, probeArgs, context.root);
  if (!isCurrent(document.uri, generation)) {
    return;
  }
  if (!probe.started) {
    reportExecutionFailure(document, context, executable, probeArgs, probe);
    return;
  }

  if (probe.exitCode === 0) {
    if (!hasFormattedOutput(document, probe.stdout)) {
      reportMalformedOutput(document, context, executable, probeArgs, probe);
      return;
    }
    setFormattingDiagnostics(document, probe.stdout);
    reportedToolFailures.delete(context.root);
    return;
  }

  reportFourmoluFailure(
    document,
    context,
    executable,
    probeArgs,
    probe,
    "check",
    check,
  );
}

function workspaceContext(document) {
  if (
    !setting(document, "enabled", true) ||
    !supportsExecutableFile(document) ||
    path.extname(document.uri.fsPath) !== ".hs"
  ) {
    return undefined;
  }

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const root = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
  const globBase = folder || standaloneGlobBase(document, root);

  const includes = setting(document, "include", ["**/*.hs"]);
  const excludes = setting(document, "exclude", [
    "**/dist-newstyle/**",
    "**/.stack-work/**",
  ]);
  const matches = (pattern) =>
    vscode.languages.match(
      {
        scheme: document.uri.scheme,
        pattern: new vscode.RelativePattern(globBase, pattern),
      },
      document,
    ) > 0;

  if (!includes.some(matches) || excludes.some(matches)) {
    return undefined;
  }

  return { root, workspaceFolder: folder?.uri.fsPath };
}

function supportsExecutableFile(document) {
  return document.uri.scheme === "file" || document.uri.scheme === "vscode-remote";
}

function standaloneGlobBase(document, root) {
  if (document.uri.scheme === "file") {
    return root;
  }
  return document.uri.with({ path: path.posix.dirname(document.uri.path) });
}

function selectExecutable(document, root) {
  const configured =
    String(setting(document, "executablePath", "fourmolu")).trim() ||
    "fourmolu";
  return resolveExecutable(configured, root);
}

function resolveExecutable(configured, root, pathApi = path) {
  const expanded = configured.replaceAll("${workspaceFolder}", root);
  if (pathApi.isAbsolute(expanded)) {
    return expanded;
  }
  return expanded.includes("/") || expanded.includes("\\")
    ? pathApi.resolve(root, expanded)
    : expanded;
}

function runFourmolu(executable, args, cwd) {
  return new Promise((resolve) => {
    childProcess.execFile(
      executable,
      args,
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const stdoutText = String(stdout || "");
        const stderrText = String(stderr || "");
        if (!error) {
          resolve({
            started: true,
            exitCode: 0,
            stdout: stdoutText,
            stderr: stderrText,
          });
          return;
        }

        if (typeof error.code === "number") {
          resolve({
            started: true,
            exitCode: error.code,
            stdout: stdoutText,
            stderr: stderrText,
            errorMessage: error.message,
          });
          return;
        }

        resolve({
          started: false,
          exitCode: undefined,
          stdout: stdoutText,
          stderr: stderrText,
          errorCode: error.code,
          errorMessage: error.message,
        });
      },
    );
  });
}

function setFormattingDiagnostics(document, formattedText) {
  const sourceText = document.getText();
  const formattedLines = splitLines(formattedText);
  let blocks = changedLineBlocks(sourceText, formattedText);

  // Fourmolu also considers LF versus CRLF a formatting difference. Line
  // comparisons intentionally normalize EOLs, so retain a whole-file warning
  // when the only change is the line-ending style.
  if (blocks.length === 0 && sourceText !== formattedText) {
    blocks = [{
      startLine: 0,
      endLine: document.lineCount - 1,
      formattedStartLine: 0,
      formattedEndLine: formattedLines.length - 1,
    }];
  }

  const entries = blocks.map((block) => {
    const formattedBlock = formattedBlockText(formattedLines, block);
    const kind = block.kind || (
      isCommentOutput(formattedBlock) ? "moduleDocumentation" : undefined
    );
    return {
      range: diagnosticRange(document, block),
      formattedText: formattedBlock,
      message: formattingMessage(kind),
    };
  });
  const severity = formattingDiagnosticSeverity(document);
  formattingHovers.set(document.uri.toString(), entries);
  diagnostics.set(
    document.uri,
    entries.map((entry) =>
      createDiagnostic(
        document,
        entry.range,
        entry.message,
        "unformatted",
        severity,
      ),
    ),
  );
}

function formattingMessage(kind) {
  return FORMATTING_MESSAGES[kind] || FORMATTING_MESSAGES.generic;
}

function formattingDiagnosticSeverity(document) {
  return String(setting(document, "diagnosticSeverity", "warning")).toLowerCase() ===
    "information"
    ? vscode.DiagnosticSeverity.Information
    : vscode.DiagnosticSeverity.Warning;
}

function isCommentOutput(value) {
  return /^\s*(?:--|\{-(?!#))/.test(value);
}

function setDiagnostic(
  document,
  message,
  code,
  severity = vscode.DiagnosticSeverity.Error,
) {
  formattingHovers.delete(document.uri.toString());
  const range = new vscode.Range(
    0,
    0,
    0,
    Math.min(document.lineAt(0).text.length, 1),
  );
  diagnostics.set(
    document.uri,
    [createDiagnostic(document, range, message, code, severity)],
  );
}

function createDiagnostic(
  document,
  rangeOrBlock,
  message,
  code,
  severity = vscode.DiagnosticSeverity.Warning,
) {
  const range = rangeOrBlock instanceof vscode.Range
    ? rangeOrBlock
    : diagnosticRange(document, rangeOrBlock);
  const diagnostic = new vscode.Diagnostic(
    range,
    message,
    severity,
  );
  diagnostic.source = SOURCE;
  diagnostic.code = code;
  return diagnostic;
}

function diagnosticRange(document, block) {
  const lastLine = document.lineCount - 1;
  const startLine = Math.min(block.startLine, lastLine);
  const endLine = Math.min(Math.max(block.endLine, startLine), lastLine);
  return new vscode.Range(
    startLine,
    0,
    endLine,
    document.lineAt(endLine).text.length,
  );
}

function changedLineBlocks(sourceText, formattedText) {
  const sourceLines = splitLines(sourceText);
  const formattedLines = splitLines(formattedText);
  const operations = lineDiff(sourceLines, formattedLines);
  const blocks = [];
  let sourceLine = 0;
  let formattedLine = 0;
  let activeBlock;

  const finishBlock = () => {
    if (!activeBlock) {
      return;
    }
    if (activeBlock.endLine < activeBlock.startLine) {
      activeBlock.endLine = activeBlock.startLine;
    }
    blocks.push(activeBlock);
    activeBlock = undefined;
  };

  for (const operation of operations) {
    if (operation === "equal") {
      finishBlock();
      sourceLine += 1;
      formattedLine += 1;
      continue;
    }

    if (!activeBlock) {
      activeBlock = {
        startLine: sourceLine,
        endLine: sourceLine - 1,
        formattedStartLine: formattedLine,
        formattedEndLine: formattedLine - 1,
      };
    }
    if (operation === "delete") {
      activeBlock.endLine = sourceLine;
      sourceLine += 1;
    } else {
      activeBlock.formattedEndLine = formattedLine;
      formattedLine += 1;
    }
  }
  finishBlock();
  return mergeModuleHeaderBlocks(
    mergeImportBlocks(blocks, sourceLines, formattedLines),
    sourceLines,
    formattedLines,
  );
}

function formattedBlockText(formattedLines, block) {
  if (block.formattedEndLine < block.formattedStartLine) {
    return "";
  }
  return formattedLines
    .slice(block.formattedStartLine, block.formattedEndLine + 1)
    .join("\n");
}

function mergeImportBlocks(blocks, sourceLines, formattedLines) {
  const sourceGroups = importGroups(sourceLines);
  const formattedGroups = importGroups(formattedLines);
  const consumed = new Set();
  const merged = [];

  for (const sourceGroup of sourceGroups) {
    const formattedGroup = matchingImportGroup(sourceGroup, formattedGroups);
    if (
      !formattedGroup ||
      importGroupText(sourceGroup, sourceLines) ===
        importGroupText(formattedGroup, formattedLines)
    ) {
      continue;
    }

    const touched = blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) =>
        rangesOverlap(block.startLine, block.endLine, sourceGroup.startLine, sourceGroup.endLine) ||
        rangesOverlap(
          block.formattedStartLine,
          block.formattedEndLine,
          formattedGroup.startLine,
          formattedGroup.endLine,
        ),
      );
    if (touched.length === 0) {
      continue;
    }

    for (const { index } of touched) {
      consumed.add(index);
    }
    merged.push({
      startLine: sourceGroup.startLine,
      endLine: sourceGroup.endLine,
      formattedStartLine: formattedGroup.startLine,
      formattedEndLine: formattedGroup.endLine,
      kind: importsAreReordered(
        sourceGroup,
        sourceLines,
        formattedGroup,
        formattedLines,
      )
        ? "importsReordered"
        : undefined,
    });
  }

  return blocks
    .filter((_block, index) => !consumed.has(index))
    .concat(merged)
    .sort((left, right) => left.startLine - right.startLine);
}

function importsAreReordered(sourceGroup, sourceLines, formattedGroup, formattedLines) {
  const sourceImports = importDeclarations(sourceGroup, sourceLines);
  const formattedImports = importDeclarations(formattedGroup, formattedLines);
  if (
    sourceImports.length !== formattedImports.length ||
    sourceImports.join("\n") === formattedImports.join("\n")
  ) {
    return false;
  }
  return (
    sourceImports.slice().sort().join("\n") ===
    formattedImports.slice().sort().join("\n")
  );
}

function importDeclarations(group, lines) {
  return lines.slice(group.startLine, group.endLine + 1);
}

function mergeModuleHeaderBlocks(blocks, sourceLines, formattedLines) {
  const sourceHeader = moduleHeader(sourceLines);
  const formattedHeader = moduleHeader(formattedLines);
  if (
    !sourceHeader ||
    !formattedHeader ||
    sourceHeader.name !== formattedHeader.name ||
    sourceHeader.documentationText === formattedHeader.documentationText
  ) {
    return blocks;
  }

  const touched = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) =>
      rangesOverlap(
        block.startLine,
        block.endLine,
        sourceHeader.startLine,
        sourceHeader.endLine,
      ) ||
      rangesOverlap(
        block.formattedStartLine,
        block.formattedEndLine,
        formattedHeader.startLine,
        formattedHeader.endLine,
      ),
    );
  if (touched.length === 0) {
    return blocks;
  }

  const consumed = new Set(touched.map(({ index }) => index));
  return blocks
    .filter((_block, index) => !consumed.has(index))
    .concat({
      startLine: sourceHeader.startLine,
      endLine: sourceHeader.endLine,
      formattedStartLine: formattedHeader.startLine,
      formattedEndLine: formattedHeader.endLine,
      kind: "moduleDocumentation",
    })
    .sort((left, right) => left.startLine - right.startLine);
}

function moduleHeader(lines) {
  const declarationLine = lines.findIndex((line) =>
    /^\s*module\s+([A-Z][\w.]*)\b/.test(line),
  );
  if (declarationLine === -1) {
    return undefined;
  }

  const documentation = moduleDocumentation(lines, declarationLine);
  if (!documentation) {
    return undefined;
  }
  const declaration = /^\s*module\s+([A-Z][\w.]*)\b/.exec(lines[declarationLine]);
  const endLine = moduleDeclarationEnd(lines, declarationLine);
  return {
    name: declaration[1],
    startLine: documentation.startLine,
    endLine,
    documentationText: lines
      .slice(documentation.startLine, documentation.endLine + 1)
      .join("\n"),
  };
}

function moduleDocumentation(lines, declarationLine) {
  const endLine = declarationLine - 1;
  if (endLine < 0) {
    return undefined;
  }
  const lastLine = lines[endLine].trim();

  if (lastLine === "-}") {
    for (let line = endLine - 1; line >= 0; line -= 1) {
      if (lines[line].trim().startsWith("{-")) {
        return { startLine: line, endLine };
      }
    }
    return undefined;
  }

  if (!lastLine.startsWith("--")) {
    return undefined;
  }
  let startLine = endLine;
  while (startLine > 0 && lines[startLine - 1].trim().startsWith("--")) {
    startLine -= 1;
  }
  return { startLine, endLine };
}

function moduleDeclarationEnd(lines, declarationLine) {
  for (let line = declarationLine; line < lines.length; line += 1) {
    if (/\bwhere\b/.test(lines[line])) {
      return line;
    }
  }
  return declarationLine;
}

function importGroups(lines) {
  const groups = [];
  let startLine;

  for (let line = 0; line <= lines.length; line += 1) {
    if (line < lines.length && importModuleName(lines[line])) {
      if (startLine === undefined) {
        startLine = line;
      }
      continue;
    }
    if (startLine !== undefined) {
      groups.push({
        startLine,
        endLine: line - 1,
        modules: lines.slice(startLine, line).map(importModuleName),
      });
      startLine = undefined;
    }
  }
  return groups;
}

function matchingImportGroup(sourceGroup, formattedGroups) {
  const sourceModules = new Set(sourceGroup.modules);
  let bestGroup;
  let bestScore = 0;

  for (const formattedGroup of formattedGroups) {
    const score = formattedGroup.modules.filter((module) =>
      sourceModules.has(module),
    ).length;
    if (score > bestScore) {
      bestGroup = formattedGroup;
      bestScore = score;
    }
  }
  return bestGroup;
}

function importGroupText(group, lines) {
  return lines.slice(group.startLine, group.endLine + 1).join("\n");
}

function importModuleName(line) {
  const match = /^\s*import\s+(?:qualified\s+)?([A-Z][\w.]*)\b/.exec(line);
  return match?.[1];
}

function rangesOverlap(start, end, otherStart, otherEnd) {
  return (
    end >= start &&
    otherEnd >= otherStart &&
    start <= otherEnd &&
    otherStart <= end
  );
}

function fencedCodeBlock(value) {
  const runs = String(value).match(/`+/g) || [];
  const fenceLength = Math.max(3, ...runs.map((run) => run.length + 1));
  const fence = "`".repeat(fenceLength);
  return `${fence}haskell\n${value}\n${fence}`;
}

function splitLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

function lineDiff(before, after) {
  const lengthBefore = before.length;
  const lengthAfter = after.length;
  const maximumDistance = lengthBefore + lengthAfter;
  let furthest = new Map([[1, 0]]);
  const trace = [];

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(furthest));
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = furthest.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = furthest.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let sourceIndex;

      if (diagonal === -distance || (diagonal !== distance && right < down)) {
        sourceIndex = down;
      } else {
        sourceIndex = right + 1;
      }
      let formattedIndex = sourceIndex - diagonal;
      while (
        sourceIndex < lengthBefore &&
        formattedIndex < lengthAfter &&
        before[sourceIndex] === after[formattedIndex]
      ) {
        sourceIndex += 1;
        formattedIndex += 1;
      }
      next.set(diagonal, sourceIndex);

      if (sourceIndex >= lengthBefore && formattedIndex >= lengthAfter) {
        return backtrackLineDiff(trace, before, after, distance);
      }
    }
    furthest = next;
  }

  return [];
}

function backtrackLineDiff(trace, before, after, distance) {
  const operations = [];
  let sourceIndex = before.length;
  let formattedIndex = after.length;

  for (let currentDistance = distance; currentDistance > 0; currentDistance -= 1) {
    const previous = trace[currentDistance];
    const diagonal = sourceIndex - formattedIndex;
    const down = previous.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = previous.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal =
      diagonal === -currentDistance ||
      (diagonal !== currentDistance && right < down)
        ? diagonal + 1
        : diagonal - 1;
    const previousSource = previous.get(previousDiagonal);
    const previousFormatted = previousSource - previousDiagonal;

    while (
      sourceIndex > previousSource &&
      formattedIndex > previousFormatted
    ) {
      operations.push("equal");
      sourceIndex -= 1;
      formattedIndex -= 1;
    }

    if (sourceIndex === previousSource) {
      operations.push("insert");
      formattedIndex -= 1;
    } else {
      operations.push("delete");
      sourceIndex -= 1;
    }
  }

  while (sourceIndex > 0 && formattedIndex > 0) {
    operations.push("equal");
    sourceIndex -= 1;
    formattedIndex -= 1;
  }
  while (sourceIndex > 0) {
    operations.push("delete");
    sourceIndex -= 1;
  }
  while (formattedIndex > 0) {
    operations.push("insert");
    formattedIndex -= 1;
  }

  return operations.reverse();
}

function hasFormattedOutput(document, stdout) {
  const sourceText = document.getText();
  const formattedText = String(stdout);
  return (
    formattedText !== sourceText &&
    (sourceText.trim() === "" || formattedText.trim() !== "")
  );
}

function reportExecutionFailure(document, context, executable, args, result) {
  const message = executionFailureMessage(executable, result);
  setDiagnostic(document, message, "execution-failed");

  if (reportedToolFailures.get(context.root) === message) {
    return;
  }
  reportedToolFailures.set(context.root, message);
  writeFailure(document, context, executable, args, result, "execution");

  const notification = isMissingExecutable(result)
    ? `Fourmolu executable was not found: ${executable}. Install Fourmolu in the environment where VS Code is running, or verify workspace access.`
    : `Fourmolu Checker could not start ${executable}. Open its output for details.`;
  void vscode.window.showWarningMessage(notification, "Show Output").then((choice) => {
    if (active && choice === "Show Output") {
      output.show(true);
    }
  });
}

function executionFailureMessage(executable, result) {
  if (isMissingExecutable(result)) {
    return `Fourmolu executable was not found: ${executable}. Install Fourmolu in the environment where VS Code is running (local, Remote SSH, WSL, or devcontainer), or configure fourmoluChecker.executablePath. If it is already installed, verify that the workspace directory is available to the extension host.`;
  }
  if (result.errorCode === "EACCES") {
    return `Fourmolu executable is not executable: ${executable}. Check its permissions and fourmoluChecker.executablePath.`;
  }

  const detail = summarizeOutput(result.stderr || result.errorMessage);
  return detail
    ? `Could not start Fourmolu (${executable}): ${detail}`
    : `Could not start Fourmolu (${executable}). See the Fourmolu Checker output.`;
}

function isMissingExecutable(result) {
  return result.errorCode === "ENOENT" || /\bENOENT\b/.test(result.errorMessage || "");
}

function reportFourmoluFailure(
  document,
  context,
  executable,
  args,
  result,
  operation,
  fallbackResult,
) {
  const resultWithDetail = result.stderr
    ? result
    : {
      ...result,
      stderr: fallbackResult?.stderr || "",
      errorMessage: result.errorMessage || fallbackResult?.errorMessage,
    };
  const detail = summarizeOutput(
    resultWithDetail.stderr || resultWithDetail.errorMessage,
  );
  setDiagnostic(
    document,
    detail
      ? `Fourmolu ${operation} failed: ${detail}`
      : `Fourmolu ${operation} failed. See the Fourmolu Checker output.`,
    "check-failed",
  );
  writeFailure(document, context, executable, args, resultWithDetail, operation);
}

function reportMalformedOutput(document, context, executable, args, result) {
  setDiagnostic(
    document,
    "Fourmolu returned unexpected formatted output. See the Fourmolu Checker output.",
    "invalid-output",
  );
  writeFailure(
    document,
    context,
    executable,
    args,
    { ...result, errorMessage: "No formatted output was returned." },
    "output validation",
  );
}

function writeFailure(document, context, executable, args, result, operation) {
  output.appendLine(`[${new Date().toISOString()}] Fourmolu ${operation} failed`);
  output.appendLine(`file: ${document.uri.fsPath}`);
  output.appendLine(`workspace folder: ${context.workspaceFolder || "(standalone file)"}`);
  output.appendLine(`cwd: ${context.root}`);
  output.appendLine(`executable: ${executable}`);
  output.appendLine(`arguments: ${JSON.stringify(args)}`);
  output.appendLine(`exit code: ${result.exitCode ?? "not started"}`);
  if (result.errorCode) {
    output.appendLine(`error code: ${result.errorCode}`);
  }
  const stderr = truncateLog(result.stderr);
  if (stderr) {
    output.appendLine(`stderr: ${stderr}`);
  } else if (result.errorMessage) {
    output.appendLine(`error: ${truncateLog(result.errorMessage)}`);
  }
  output.appendLine("");
}

function truncateLog(value) {
  const text = String(value || "").trim();
  return text.length > MAX_LOG_BYTES
    ? `${text.slice(0, MAX_LOG_BYTES)}…`
    : text;
}

function summarizeOutput(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

module.exports = { activate, deactivate, resolveExecutable };
