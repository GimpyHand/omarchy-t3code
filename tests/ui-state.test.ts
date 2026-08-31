import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("UI state transitions Login → Inbox → Thread and back", async () => {
  const source = (await readFile(join(root, "qml", "UiState.js"), "utf8"))
    .replace(".pragma library", "");
  const state = vm.runInNewContext(`${source}\n({ routeForOpen, routeAfterAuthentication })`) as {
    routeForOpen(auth: string, requested: string, hasThread: boolean): string;
    routeAfterAuthentication(auth: string): string;
  };
  assert.equal(state.routeForOpen("signedOut", "inbox", false), "login");
  assert.equal(state.routeForOpen("signingIn", "inbox", false), "login");
  assert.equal(state.routeAfterAuthentication("signedIn"), "inbox");
  assert.equal(state.routeForOpen("signedIn", "inbox", false), "inbox");
  assert.equal(state.routeForOpen("signedIn", "thread", true), "thread");
  assert.equal(state.routeAfterAuthentication("signedOut"), "login");
});

test("bar state summarizes server-projected thread and connection phases", async () => {
  const source = (await readFile(join(root, "qml", "BarState.js"), "utf8"))
    .replace(".pragma library", "");
  const state = vm.runInNewContext(`${source}\n({ threadPhase, stateLabel, stateColor })`) as {
    threadPhase(inbox: Record<string, unknown[]>): string;
    stateLabel(service: Record<string, unknown>): string;
    stateColor(service: Record<string, unknown>): string;
  };
  const connected = {
    ready: true,
    authPhase: "signedIn",
    connectionPhase: "connected",
    inbox: { pinned: [], active: [], snoozed: [], settled: [] },
  };

  assert.equal(state.stateLabel(connected), "Idle");
  assert.equal(state.stateColor(connected), "#22c55e");
  assert.equal(state.stateLabel({
    ...connected,
    inbox: { ...connected.inbox, active: [{ phase: "working" }] },
  }), "Working");
  assert.equal(state.stateColor({
    ...connected,
    inbox: { ...connected.inbox, active: [{ phase: "working" }] },
  }), "#3b82f6");
  assert.equal(state.stateColor({
    ...connected,
    inbox: { ...connected.inbox, active: [{ phase: "ready" }] },
  }), "#22c55e");
  assert.equal(state.stateColor({
    ...connected,
    inbox: { ...connected.inbox, active: [{ phase: "inputNeeded" }] },
  }), "#f59e0b");
  assert.equal(state.threadPhase({
    pinned: [{ phase: "approvalNeeded" }],
    active: [{ phase: "working" }],
    snoozed: [{ phase: "inputNeeded" }],
  }), "inputNeeded");
  assert.equal(state.stateLabel({ ...connected, connectionPhase: "reconnecting" }), "Reconnecting");
  assert.equal(state.stateColor({ ...connected, connectionPhase: "reconnecting" }), "#3b82f6");
  assert.equal(state.stateLabel({ ...connected, authPhase: "signedOut" }), "Signed out");
  assert.equal(state.stateColor({ ...connected, connectionPhase: "disconnected" }), "#ef4444");
});

test("bar widget shows a status color dot instead of phase text", async () => {
  const widget = await readFile(join(root, "qml", "BarWidget.qml"), "utf8");
  assert.match(widget, /readonly property color stateColor: BarState\.stateColor\(t3\)/u);
  assert.match(widget, /color: root\.stateColor/u);
  assert.doesNotMatch(widget, /text: root\.stateText/u);
  assert.match(widget, /tooltipText:[\s\S]*root\.stateText/u);
});

test("pending input options show their explanations inline", async () => {
  const input = await readFile(join(root, "qml", "InputCard.qml"), "utf8");
  assert.match(input, /readonly property string optionDescription/u);
  assert.match(input, /text: optionButton\.optionDescription/u);
  assert.match(input, /visible: optionButton\.optionDescription\.length > 0/u);
  assert.match(input, /readonly property color secondaryText: Util\.alpha\(Color\.foreground, 0\.70\)/u);
  assert.match(input, /id: selectionMark/u);
  assert.match(input, /bordered: false/u);
  assert.doesNotMatch(input, /tooltipText: String\(modelData\.description/u);
});

test("pending input owns the reply area until it is answered", async () => {
  const threadView = await readFile(join(root, "qml", "ThreadView.qml"), "utf8");
  assert.match(threadView, /readonly property bool hasPendingInput:[^\n]*threadData\.inputs/u);
  assert.match(threadView, /composer\.visible \? composer\.height \+ parent\.spacing : 0/u);
  assert.match(threadView, /visible: root\.threadData !== null && !root\.hasPendingInput/u);
});

test("input-required attention uses one orange state color", async () => {
  const source = (await readFile(join(root, "qml", "AttentionState.js"), "utf8"))
    .replace(".pragma library", "");
  const state = vm.runInNewContext(`${source}\n({ inputColor, attentionColor })`) as {
    inputColor(): string;
    attentionColor(phase: string, urgentColor: string): string;
  };
  assert.equal(state.inputColor(), "#f59e0b");
  assert.equal(state.attentionColor("inputNeeded", "red"), "#f59e0b");
  assert.equal(state.attentionColor("approvalNeeded", "red"), "red");

  const threadRow = await readFile(join(root, "qml", "ThreadRow.qml"), "utf8");
  assert.match(threadRow, /attentionColor: AttentionState\.attentionColor/u);
  assert.match(threadRow, /root\.inputNeeded \? Util\.alpha\(root\.attentionColor/u);
  assert.match(threadRow, /color: root\.threadData\.attention \? root\.attentionColor/u);
});

test("auth completion automatically summons the panel at Inbox", async () => {
  const service = await readFile(join(root, "qml", "Service.qml"), "utf8");
  assert.match(service, /case "auth\.completed"[\s\S]*shell\.summon\("io\.github\.gimpyhand\.omarchy-t3code", JSON\.stringify\(\{ route: "inbox" \}\)\)/u);
});

test("T3 mark preserves the upstream SVG winding fill", async () => {
  const mark = await readFile(join(root, "qml", "T3Mark.qml"), "utf8");
  assert.match(mark, /fillRule: ShapePath\.WindingFill/u);
});

test("Inbox header omits login identity and filters by project", async () => {
  const inbox = await readFile(join(root, "qml", "InboxView.qml"), "utf8");
  assert.doesNotMatch(inbox, /root\.service\.identity|T3 Connect/u);
  assert.doesNotMatch(inbox, /formattedInboxUpdatedAt|"Connected"/u);
  assert.match(inbox, /property string filterProjectKey: ""/u);
  assert.match(inbox, /function projectFilterOptions\(\)[\s\S]*All projects[\s\S]*seen\[key\]/u);
  assert.match(inbox, /filterProjectKey && String\(values\[i\]\.projectKey/u);
  assert.match(inbox, /value: root\.filterProjectKey/u);
});

test("bridge restart preserves and resubscribes the active thread", async () => {
  const service = await readFile(join(root, "qml", "Service.qml"), "utf8");
  assert.match(service, /property string openThreadId/u);
  assert.match(service, /case "inbox\.changed"[\s\S]*resumeOpenThread\(\)/u);
  assert.match(service, /onExited:[\s\S]*threadSubscriptionActive = false/u);
  assert.match(service, /request\("thread\.open", \{ environmentId: openEnvironmentId, threadId: openThreadId \}/u);
  assert.match(service, /function failPendingRequests\(\)[\s\S]*queuedWrites = \[\]/u);
  const openResponse = service.slice(service.indexOf("function resumeOpenThread"), service.indexOf("function handleResponse"));
  assert.doesNotMatch(openResponse, /threadSubscriptionActive = true/u);
  assert.match(service, /case "thread\.snapshot"[\s\S]*openingThread = false[\s\S]*threadSubscriptionActive = true/u);
});

test("assistant replies show changed files instead of raw tool activity", async () => {
  const threadView = await readFile(join(root, "qml", "ThreadView.qml"), "utf8");
  const changedFiles = await readFile(join(root, "qml", "ChangedFilesCard.qml"), "utf8");
  assert.match(threadView, /function diffForMessage\(messageId\)/u);
  assert.match(threadView, /function revealChangedFiles\(card\)[\s\S]*changedFilesRevealTimer\.restart\(\)/u);
  assert.match(threadView, /function positionChangedFiles\(\)[\s\S]*card\.mapToItem\(conversation\.contentItem\.contentItem[\s\S]*contentY/u);
  assert.match(threadView, /id: changedFilesRevealTimer[\s\S]*interval: 50[\s\S]*onTriggered: root\.positionChangedFiles\(\)/u);
  assert.match(threadView, /ChangedFilesCard\s*\{[\s\S]*summaryData: parent\.diffData[\s\S]*onRevealRequested: root\.revealChangedFiles\(changedFiles\)/u);
  assert.doesNotMatch(threadView, /threadData\.activities|ActivityRow|ActivityGroup/u);
  assert.match(changedFiles, /property bool expanded: false/u);
  assert.match(changedFiles, /readonly property var treeRows: buildTreeRows\(\)/u);
  assert.match(changedFiles, /if \(root\.expanded\) root\.revealRequested\(\)/u);
  assert.doesNotMatch(changedFiles, /Open diff|openDiffRequested/u);
  assert.doesNotMatch(threadView, /DiffView|selectedDiff/u);
});

test("thread view keeps only lifecycle actions and uses real pin glyphs", async () => {
  const threadView = await readFile(join(root, "qml", "ThreadView.qml"), "utf8");
  const threadRow = await readFile(join(root, "qml", "ThreadRow.qml"), "utf8");
  assert.doesNotMatch(threadView, /root\.service\.rename|root\.service\.regenerateTitle|titleField|\brenaming\b/u);
  assert.doesNotMatch(threadView, /tooltipText: "Rename"|Regenerate title/u);
  assert.match(threadView, /lifecycle === "pinned" \? "󰐃" : "󰤱"/u);
  assert.match(threadRow, /threadData\.pinned \? "󰐃" : "󰤱"/u);
  assert.doesNotMatch(threadView + threadRow, /󰐁/u);
});

test("thread metadata chips use T3-familiar icons for project system branch model", async () => {
  const meta = await readFile(join(root, "qml", "ThreadMetaRow.qml"), "utf8");
  const threadRow = await readFile(join(root, "qml", "ThreadRow.qml"), "utf8");
  const threadView = await readFile(join(root, "qml", "ThreadView.qml"), "utf8");
  assert.match(meta, /function primaryLine\(\)[\s\S]*"󰒋 " \+ environment[\s\S]*"󰉋 " \+ project[\s\S]*"󰘬 " \+ branch/u);
  assert.match(meta, /function secondaryLine\(\)[\s\S]*"󰆧 " \+ model[\s\S]*"󰥔 " \+ time/u);
  assert.match(meta, /parts\.join\("  ·  "\)/u);
  assert.match(threadRow, /ThreadMetaRow[\s\S]*showTime: true/u);
  assert.match(threadView, /ThreadMetaRow[\s\S]*showPhase: true/u);
});

test("working indicator follows pinned T3 elapsed-time formatting", async () => {
  const source = (await readFile(join(root, "qml", "WorkingState.js"), "utf8"))
    .replace(".pragma library", "");
  const state = vm.runInNewContext(`${source}\n({ durationLabel, statusLabel })`) as {
    durationLabel(startIso: string, nowMs: number): string;
    statusLabel(phase: string, startIso: string, nowMs: number): string;
  };
  const startedAt = "2026-08-23T10:00:00.000Z";
  const startMs = Date.parse(startedAt);
  assert.equal(state.statusLabel("working", startedAt, startMs + 32_000), "Working for 32s");
  assert.equal(state.durationLabel(startedAt, startMs + 65_000), "1m 5s");
  assert.equal(state.durationLabel(startedAt, startMs + 3_720_000), "1h 2m");
  assert.equal(state.statusLabel("starting", "", startMs), "Working...");
  assert.equal(state.statusLabel("idle", startedAt, startMs + 32_000), "");

  const threadView = await readFile(join(root, "qml", "ThreadView.qml"), "utf8");
  const indicator = await readFile(join(root, "qml", "WorkingIndicator.qml"), "utf8");
  assert.match(threadView, /WorkingIndicator\s*\{[\s\S]*phase: root\.threadData[\s\S]*activeWorkStartedAt/u);
  assert.match(indicator, /Timer\s*\{[\s\S]*interval: 1000[\s\S]*running: root\.visible/u);
});

test("composer actions fit one row with compact labels", async () => {
  const composer = await readFile(join(root, "qml", "Composer.qml"), "utf8");
  const modelDropdown = await readFile(join(root, "qml", "ModelDropdown.qml"), "utf8");
  const modelOptions = await readFile(join(root, "qml", "ModelOptionsPicker.qml"), "utf8");
  const compactLabelsSource = (await readFile(join(root, "qml", "CompactLabels.js"), "utf8"))
    .replace(".pragma library", "");
  const compactLabels = vm.runInNewContext(`${compactLabelsSource}\n({ modelName })`) as {
    modelName(modelLabel: string, providerLabel: string): string;
  };
  assert.equal(compactLabels.modelName("Claude Fable 5", "Claude"), "Fable 5");
  assert.equal(compactLabels.modelName("GPT-5.6", "Codex"), "GPT-5.6");
  assert.match(composer, /providerLabel: String\(values\[i\]\.providerLabel\)[\s\S]*modelLabel: String\(values\[i\]\.label \|\| values\[i\]\.model\)/u);
  assert.match(composer, /Row\s*\{\s*id: actionRow[\s\S]*readonly property real selectorWidth/u);
  assert.doesNotMatch(composer, /Flow\s*\{/u);
  assert.match(composer, /id: sendButton[\s\S]*iconText: "󰒊"[\s\S]*tooltipText: "Send"/u);
  assert.match(composer, /id: sendButton[\s\S]*width: Style\.space\(32\)[\s\S]*height: Style\.space\(24\)/u);
  assert.match(composer, /selectorCapacity: Math\.max\(0, width - sendButton\.width/u);
  assert.doesNotMatch(composer, /text: "Send"|text: "Stop"/u);
  assert.ok(composer.indexOf("ModelDropdown") < composer.indexOf("ModelOptionsPicker"));
  assert.ok(composer.indexOf("ModelOptionsPicker") < composer.indexOf("id: runtimeDropdown"));
  assert.doesNotMatch(composer, /setInteraction|interactionMode|label: "Plan"/u);
  assert.match(composer, /selectorWidth: Math\.min\(selectorCapacity, Style\.space\(315\)\)/u);
  assert.match(composer, /id: modelDropdown[\s\S]*triggerFontSize: Style\.font\.caption[\s\S]*id: modelOptionsPicker[\s\S]*triggerFontSize: Style\.font\.caption[\s\S]*id: runtimeDropdown[\s\S]*triggerFontSize: Style\.font\.caption[\s\S]*showProviderColumn: false/u);
  assert.match(modelOptions, /descriptors[\s\S]*descriptorData\.label[\s\S]*descriptorData\.choices/u);
  assert.doesNotMatch(modelOptions, /labels\.join|" · "/u);
  assert.match(modelOptions, /text: "Default"/u);
  assert.match(modelDropdown, /function currentModelLabel\(\)[\s\S]*CompactLabels\.modelName\(optionModel\(options\[i\]\), optionProvider\(options\[i\]\)\)/u);
  assert.match(modelDropdown, /root\.showProviderColumn \? Style\.space\(420\) : Style\.space\(225\)/u);
  assert.match(modelDropdown, /text: root\.optionProvider\(optionRow\.modelData\)[\s\S]*text: root\.optionModel\(optionRow\.modelData\)/u);
  assert.match(modelOptions, /property real triggerFontSize: Style\.font\.body[\s\S]*font\.pixelSize: root\.triggerFontSize/u);
  assert.doesNotMatch(modelDropdown, /root\.value =/u);
  assert.match(composer, /readonly property string selectedModel/u);
  assert.doesNotMatch(composer, /root\.selectedModel =/u);
  assert.match(composer, /service\.send\(String\(threadData\.id\), String\(threadData\.environmentId \|\| ""\), value, attachmentIds/u);
});

test("assistant Markdown cannot request resources or open unsafe URL schemes", async () => {
  const source = (await readFile(join(root, "qml", "MarkdownSafety.js"), "utf8"))
    .replace(".pragma library", "");
  const safety = vm.runInNewContext(`${source}\n({ safeMarkdown, isAllowedExternalUrl })`) as {
    safeMarkdown(value: string): string;
    isAllowedExternalUrl(value: string): boolean;
  };
  const rendered = safety.safeMarkdown([
    "![inline](https://tracker.example/image.png)",
    "![reference][remote]",
    "![collapsed][]",
    "![shortcut]",
    "<img src=https://tracker.example/pixel>",
    "<object data=https://tracker.example/file>",
    "<span style=\"background-image:url(https://tracker.example/bg)\">x</span>",
  ].join("\n"));
  assert.doesNotMatch(rendered, /!\[/u);
  assert.doesNotMatch(rendered, /</u);
  assert.match(rendered, /\[image: reference\]\[remote\]/u);
  assert.equal(safety.isAllowedExternalUrl("https://example.test/path"), true);
  assert.equal(safety.isAllowedExternalUrl(" HTTP://example.test/path"), true);
  assert.equal(safety.isAllowedExternalUrl("mailto:security@example.test"), true);
  for (const value of ["file:///etc/passwd", "data:text/html,test", "javascript:alert(1)", "t3code://app/"]) {
    assert.equal(safety.isAllowedExternalUrl(value), false);
  }
});

test("thread composer pastes, previews, removes, and sends clipboard screenshots", async () => {
  const composer = await readFile(join(root, "qml", "Composer.qml"), "utf8");
  const service = await readFile(join(root, "qml", "Service.qml"), "utf8");
  const message = await readFile(join(root, "qml", "MessageBubble.qml"), "utf8");
  assert.match(composer, /function handlePasteShortcut\(event\)[\s\S]*StandardKey\.Paste[\s\S]*Quickshell\.clipboardText/u);
  assert.match(composer, /function pasteScreenshot\(\)[\s\S]*service\.pasteScreenshot/u);
  assert.match(composer, /Image\s*\{[\s\S]*modelData\.previewUrl/u);
  assert.match(composer, /function removeAttachment\(index\)[\s\S]*service\.discardAttachment/u);
  assert.match(composer, /service\.send\([\s\S]*environmentId[\s\S]*attachmentIds, function\(ok, result\)/u);
  assert.match(composer, /prompt\.text\.trim\(\)\.length > 0 \|\| root\.attachments\.length > 0/u);
  assert.match(
    composer,
    /function modelOptions\(\)[\s\S]*threadData\.environmentId[\s\S]*values\[i\]\.environmentId/u,
  );
  assert.match(service, /request\("attachment\.clipboard\.read"/u);
  assert.match(service, /payload\.attachmentIds = attachmentIds/u);
  assert.match(service, /environmentId: environmentId/u);
  assert.match(message, /function attachmentSummary\(\)[\s\S]*\[image:/u);
});

test("new-thread composer mirrors model options and access controls from replies", async () => {
  const inbox = await readFile(join(root, "qml", "InboxView.qml"), "utf8");
  const service = await readFile(join(root, "qml", "Service.qml"), "utf8");
  assert.match(inbox, /function descriptorsForModel\(value\)[\s\S]*models\[i\]\.modelOptions/u);
  assert.match(inbox, /function selectedOptionValues\(\)[\s\S]*id:[\s\S]*value:/u);
  assert.match(inbox, /Row\s*\{\s*id: createActionRow[\s\S]*readonly property real selectorWidth/u);
  assert.match(inbox, /ModelDropdown\s*\{\s*id: createModelDropdown/u);
  assert.ok(inbox.indexOf("id: createModelDropdown") < inbox.indexOf("id: createModelOptionsPicker"));
  assert.ok(inbox.indexOf("id: createModelOptionsPicker") < inbox.indexOf("id: createRuntimeDropdown"));
  assert.match(inbox, /id: createModelOptionsPicker[\s\S]*descriptors: root\.selectedModelOptions/u);
  assert.match(inbox, /id: createRuntimeDropdown[\s\S]*triggerFontSize: Style\.font\.caption[\s\S]*showProviderColumn: false[\s\S]*value: root\.selectedRuntimeMode/u);
  assert.match(inbox, /selectedOptionValues\(\),[\s\S]*selectedRuntimeMode\)/u);
  assert.match(service, /function createThread\(environmentId, projectId, prompt[\s\S]*environmentId: environmentId[\s\S]*payload\.modelOptions = modelOptions[\s\S]*payload\.runtimeMode = runtimeMode/u);
});

test("new tasks pick a system before project", async () => {
  const inbox = await readFile(join(root, "qml", "InboxView.qml"), "utf8");
  assert.match(inbox, /property string filterEnvironmentId: ""/u);
  assert.match(inbox, /property string createEnvironmentId: ""/u);
  assert.match(inbox, /text: "System"[\s\S]*color: Color\.accent[\s\S]*showLabel: false[\s\S]*foreground: Color\.foreground/u);
  assert.match(inbox, /text: "Project"[\s\S]*color: Color\.accent[\s\S]*showLabel: false[\s\S]*foreground: Color\.foreground/u);
  assert.match(inbox, /All systems/u);
  assert.match(inbox, /root\.createEnvironmentId = value/u);
  assert.match(inbox, /root\.filterEnvironmentId = value/u);
  assert.doesNotMatch(inbox, /selectEnvironment\(value\)/u);
  assert.match(inbox, /createThread\(\s*createEnvironmentId/u);
});

test("new tasks require an explicit confirmation before broader access", async () => {
  const inbox = await readFile(join(root, "qml", "InboxView.qml"), "utf8");
  assert.match(inbox, /property string selectedRuntimeMode: "approval-required"/u);
  assert.match(inbox, /function resetNewTaskAccess\(\)[\s\S]*selectedRuntimeMode = "approval-required"[\s\S]*pendingRuntimeMode = ""/u);
  assert.match(inbox, /function requestRuntimeMode\(value\)[\s\S]*if \(value === "approval-required"\)[\s\S]*pendingRuntimeMode = value/u);
  assert.match(inbox, /function confirmBroaderRuntimeMode\(\)[\s\S]*selectedRuntimeMode = pendingRuntimeMode[\s\S]*pendingRuntimeMode = ""/u);
  assert.match(inbox, /if \(!prompt \|\| !selectedProject \|\| !createEnvironmentId \|\| pendingRuntimeMode\) return/u);
  assert.match(inbox, /text: "Enable " \+ root\.runtimeModeLabel\(root\.pendingRuntimeMode\)/u);
  assert.match(inbox, /text: "Keep Ask first"/u);
  assert.match(inbox, /onClicked: root\.confirmBroaderRuntimeMode\(\)/u);
  assert.match(inbox, /root\.creating = !root\.creating[\s\S]*root\.resetNewTaskAccess\(\)/u);
  assert.match(inbox, /newPrompt\.text = ""[\s\S]*creating = false[\s\S]*resetNewTaskAccess\(\)/u);
});

test("live plugin startup uses a QProcess-safe launcher and waits for service injection", async () => {
  const service = await readFile(join(root, "qml", "Service.qml"), "utf8");
  const panel = await readFile(join(root, "qml", "Panel.qml"), "utf8");
  assert.match(service, /command: \["\/bin\/sh", root\.bridgePath\]/u);
  assert.match(panel, /active: root\.service !== null/u);
});

test("the mini client opens in the bar-owned Omarchy modal", async () => {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
    kinds: string[];
    entryPoints: Record<string, string>;
  };
  const widget = await readFile(join(root, "qml", "BarWidget.qml"), "utf8");
  const panel = await readFile(join(root, "qml", "Panel.qml"), "utf8");

  assert.deepEqual(manifest.kinds, ["service", "bar-widget"]);
  assert.equal(manifest.entryPoints.panel, undefined);
  assert.match(widget, /Ui\.Panel\s*\{/u);
  assert.match(widget, /Ui\.WidgetButton\s*\{/u);
  assert.match(widget, /readonly property color stateColor: BarState\.stateColor\(t3\)/u);
  assert.match(widget, /color: root\.stateColor/u);
  assert.doesNotMatch(widget, /text: root\.stateText/u);
  assert.doesNotMatch(widget, /attentionCount > 9/u);
  assert.doesNotMatch(widget, /root\.connected \? "#61c98b"/u);
  assert.match(widget, /Ui\.KeyboardPanel\s*\{/u);
  assert.match(widget, /anchorItem: icon/u);
  assert.match(widget, /open: root\.opened/u);
  assert.match(widget, /service: root\.t3 \|\| null/u);
  assert.match(panel, /FocusScope\s*\{/u);
  assert.doesNotMatch(panel, /FloatingWindow/u);
});

test("packaging uses an ephemeral callback handler that forwards URI arguments", async () => {
  const launcher = await readFile(join(root, "bin", "t3-mini-bridge"), "utf8");
  const callback = await readFile(join(root, "bridge", "src", "auth", "protocolHandler.ts"), "utf8");
  const installer = await readFile(join(root, "scripts", "install-package"), "utf8");
  const sourceInstaller = await readFile(join(root, "scripts", "install-plugin.mjs"), "utf8");
  const uninstaller = await readFile(join(root, "scripts", "uninstall-package"), "utf8");
  assert.match(launcher, /exec "\$plugin_root\/lib\/t3-mini-bridge" "\$@"/u);
  assert.match(callback, /NoDisplay=true/u);
  assert.match(callback, /--oauth-callback %u/u);
  assert.match(callback, /await removeDesktop\(\)/u);
  assert.doesNotMatch(installer, /callback\.desktop/u);
  assert.match(installer, /bar put "\$plugin_id" --section right --index 0/u);
  assert.match(sourceInstaller, /join\(root, "dist", "install"\)/u);
  assert.match(uninstaller, /--keep-secrets/u);
  assert.match(uninstaller, /relay-dpop-proof-key/u);
  assert.match(installer, /find "\$backup_root"[\s\S]*! -path "\$backup" -exec rm -r/u);
  assert.doesNotMatch(installer + sourceInstaller, /plugin[", ]+enable[", ]+["$]*\{?plugin_id|plugin[", ]+enable[", ]+id/u);
});

test("CI proves marketplace runtime provenance before trusting tracked bytes", async () => {
  const packageScript = await readFile(join(root, "scripts", "package.mjs"), "utf8");
  const repositoryValidator = await readFile(join(root, "scripts", "validate-repository.mjs"), "utf8");
  const provenanceVerifier = await readFile(join(root, "scripts", "verify-marketplace-runtime.mjs"), "utf8");
  const workflow = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(packageScript, /reproducibleMainPath = "bridge\/dist\/t3-mini-bridge\.cjs"/u);
  assert.match(packageScript, /const selfTest = run\(executablePath, \["--self-test"\]/u);
  assert.match(packageScript, /copyFile\(join\(root, "LICENSE"\), join\(packagedPlugin, "LICENSE"\)\)/u);
  assert.match(packageScript, /\["README\.md", "ARCHITECTURE\.md", "SECURITY\.md", "UPSTREAM\.md", "CHANGELOG\.md", "CONTRIBUTING\.md"\]/u);
  assert.doesNotMatch(packageScript, /AGENTS\.md|RELEASING\.md/u);
  assert.doesNotMatch(repositoryValidator, /bin["', /]+t3-mini-bridge[^\n]*--self-test/u);
  assert.match(repositoryValidator, /uncompressedSha256[\s\S]*createGunzip/u);
  assert.match(provenanceVerifier, /createGunzip\(\)[\s\S]*spawnSync\("cmp"/u);
  assert.match(provenanceVerifier, /process\.version !== `v\$\{expectedNodeVersion\}`/u);
  assert.match(workflow, /node-version-file: \.node-version[\s\S]*pnpm package[\s\S]*pnpm verify:marketplace-runtime/u);
});

test("blocked Relay connection hides and disables task creation", async () => {
  const service = await readFile(join(root, "qml", "Service.qml"), "utf8");
  const inbox = await readFile(join(root, "qml", "InboxView.qml"), "utf8");
  assert.match(
    inbox,
    /id: newButton[\s\S]*visible: root\.service\.connectionPhase === "connected"[\s\S]*enabled: root\.service\.connectionPhase === "connected"/u,
  );
  assert.match(
    inbox,
    /visible: root\.creating && root\.service\.connectionPhase === "connected"/u,
  );
  assert.match(
    inbox,
    /onConnectionPhaseChanged\(\)[\s\S]*root\.creating = false/u,
  );
  assert.match(service, /function refreshConnection\(\)[\s\S]*connectionPhase === "connected"[\s\S]*refreshInbox\(\)[\s\S]*refreshEnvironments\(\)/u);
  assert.match(
    inbox,
    /tooltipText: root\.service\.connectionPhase === "connected" \? "Refresh T3 Command Center" : "Retry connection"[\s\S]*onClicked: root\.service\.refreshConnection\(\)/u,
  );
});
