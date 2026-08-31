import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool ready: false
  property bool stopping: false
  property string authPhase: "signedOut"
  property string identity: ""
  property string remoteAccess: "unknown"
  property string authDetail: ""
  property string connectionPhase: "disconnected"
  property string connectionDetail: ""
  property var environments: []
  property string selectedEnvironmentId: ""
  property var inbox: ({ pinned: [], active: [], snoozed: [], settled: [], projects: [], models: [] })
  property var thread: null
  property var models: []
  property string lastError: ""
  property string openThreadId: ""
  property string openEnvironmentId: ""
  property bool openingThread: false
  property bool threadSubscriptionActive: false
  property int requestSerial: 0
  property var callbacks: ({})
  property var queuedWrites: []

  signal authCompleted()
  signal navigateThread(string threadId)
  signal navigateInbox()

  readonly property string pluginDir: manifest && manifest.__sourceDir ? String(manifest.__sourceDir) : ""
  readonly property string bridgePath: pluginDir + "/bin/t3-mini-bridge"
  readonly property int attentionCount: countAttention()

  function countAttention() {
    var count = 0
    var groups = [inbox.pinned || [], inbox.active || [], inbox.snoozed || []]
    for (var g = 0; g < groups.length; g++)
      for (var i = 0; i < groups[g].length; i++) if (groups[g][i].attention) count++
    return count
  }

  function nextRequestId() {
    requestSerial += 1
    return "qml-" + Date.now() + "-" + requestSerial
  }

  function request(type, payload, callback) {
    var requestId = nextRequestId()
    if (callback) {
      var next = {}
      for (var key in callbacks) next[key] = callbacks[key]
      next[requestId] = callback
      callbacks = next
    }
    var line = JSON.stringify({ protocolVersion: 1, requestId: requestId, type: type, payload: payload || {} }) + "\n"
    if (bridge.running && ready) bridge.write(line)
    else queuedWrites = queuedWrites.concat([line])
    return requestId
  }

  function flushWrites() {
    var writes = queuedWrites
    queuedWrites = []
    for (var i = 0; i < writes.length; i++) bridge.write(writes[i])
  }

  function failPendingRequests() {
    var pending = callbacks
    callbacks = ({})
    queuedWrites = []
    for (var key in pending)
      pending[key](false, { code: "BRIDGE_RESTARTED", message: "The T3 bridge restarted; live state will be restored automatically.", retryable: true })
  }

  function resumeOpenThread() {
    if (!openThreadId || !openEnvironmentId || openingThread || threadSubscriptionActive || connectionPhase !== "connected") return
    openingThread = true
    request("thread.open", { environmentId: openEnvironmentId, threadId: openThreadId }, function(ok, result) {
      if (ok) return
      openingThread = false
      lastError = String(result && result.message ? result.message : "The thread could not be opened.")
      openThreadId = ""
      openEnvironmentId = ""
      threadSubscriptionActive = false
      thread = null
      navigateInbox()
    })
  }

  function handleResponse(message) {
    var callback = callbacks[message.requestId]
    if (callback) {
      var next = {}
      for (var key in callbacks) if (key !== message.requestId) next[key] = callbacks[key]
      callbacks = next
      callback(message.ok === true, message.ok === true ? message.payload : message.error)
    }
    if (message.ok !== true && message.error) lastError = String(message.error.message || "T3 request failed")
  }

  function handleEvent(message) {
    var payload = message.payload || {}
    switch (message.event) {
      case "bridge.ready":
        ready = true
        flushWrites()
        break
      case "auth.changed":
        authPhase = String(payload.phase || "signedOut")
        identity = String(payload.identity || "")
        remoteAccess = String(payload.remoteAccess || "unknown")
        authDetail = String(payload.detail || "")
        if (authPhase === "signedOut") {
          openThreadId = ""
          openEnvironmentId = ""
          openingThread = false
          threadSubscriptionActive = false
          thread = null
        }
        break
      case "auth.completed":
        authPhase = String(payload.phase || "signedIn")
        identity = String(payload.identity || "")
        remoteAccess = String(payload.remoteAccess || "unknown")
        authDetail = String(payload.detail || "")
        authCompleted()
        if (shell && typeof shell.summon === "function")
          shell.summon("bralyx.t3code", JSON.stringify({ route: "inbox" }))
        break
      case "connection.changed":
        connectionPhase = String(payload.phase || "disconnected")
        connectionDetail = String(payload.detail || "")
        selectedEnvironmentId = String(payload.environmentId || selectedEnvironmentId)
        if (connectionPhase !== "connected") {
          openingThread = false
          threadSubscriptionActive = false
        }
        break
      case "environment.changed":
        environments = payload.environments || []
        selectedEnvironmentId = String(payload.selected || "")
        break
      case "inbox.changed":
        inbox = payload
        models = payload.models || []
        resumeOpenThread()
        break
      case "thread.snapshot":
        thread = payload
        if (payload.id && String(payload.id) === openThreadId) {
          openingThread = false
          threadSubscriptionActive = true
        }
        break
      case "error":
        lastError = String(payload.message || "T3 bridge error")
        break
    }
  }

  function handleLine(line) {
    var message
    try { message = JSON.parse(String(line)) }
    catch (error) { lastError = "The T3 bridge returned malformed data."; return }
    if (!message || message.protocolVersion !== 1) return
    if (message.type === "response") handleResponse(message)
    else if (message.type === "event") handleEvent(message)
  }

  function startLogin() { request("auth.login", {}) }
  function logout() { request("auth.logout", {}, function() { navigateInbox() }) }
  function refreshEnvironments() { request("environment.list", {}) }
  function preferEnvironment(environmentId) { request("environment.select", { environmentId: environmentId }) }
  function refreshInbox() { request("inbox.get", {}, function(ok, payload) { if (ok) { inbox = payload; models = payload.models || [] } }) }
  function refreshConnection() {
    if (connectionPhase === "connected") {
      refreshInbox()
      return
    }
    refreshEnvironments()
  }
  function openThread(threadId, environmentId) {
    thread = null
    openThreadId = String(threadId)
    openEnvironmentId = String(environmentId || "")
    openingThread = false
    threadSubscriptionActive = false
    navigateThread(threadId)
    resumeOpenThread()
  }
  function closeThread() {
    openThreadId = ""
    openEnvironmentId = ""
    openingThread = false
    threadSubscriptionActive = false
    request("thread.close", {})
    thread = null
    navigateInbox()
  }
  function createThread(environmentId, projectId, prompt, title, providerInstanceId, model, modelOptions, runtimeMode) {
    var payload = { environmentId: environmentId, projectId: projectId, prompt: prompt }
    if (title) payload.title = title
    if (providerInstanceId && model) { payload.providerInstanceId = providerInstanceId; payload.model = model }
    if (modelOptions && modelOptions.length > 0) payload.modelOptions = modelOptions
    if (runtimeMode) payload.runtimeMode = runtimeMode
    request("thread.create", payload, function(ok, result) {
      if (ok && result && result.threadId) openThread(String(result.threadId), environmentId)
    })
  }
  function pasteScreenshot(threadId, environmentId, callback) {
    request("attachment.clipboard.read", { environmentId: environmentId, threadId: threadId }, callback)
  }
  function discardAttachment(threadId, environmentId, attachmentId) {
    request("attachment.discard", { environmentId: environmentId, threadId: threadId, attachmentId: attachmentId })
  }
  function send(threadId, environmentId, text, attachmentIds, callback) {
    var payload = { environmentId: environmentId, threadId: threadId, text: text }
    if (attachmentIds && attachmentIds.length > 0) payload.attachmentIds = attachmentIds
    request("thread.send", payload, callback)
  }
  function interrupt(threadId, environmentId) { request("thread.interrupt", { environmentId: environmentId, threadId: threadId }) }
  function settle(threadId, environmentId) { request("thread.settle", { environmentId: environmentId, threadId: threadId }) }
  function unsettle(threadId, environmentId) { request("thread.unsettle", { environmentId: environmentId, threadId: threadId }) }
  function snooze(threadId, environmentId, until) { request("thread.snooze", { environmentId: environmentId, threadId: threadId, until: until }) }
  function unsnooze(threadId, environmentId) { request("thread.unsnooze", { environmentId: environmentId, threadId: threadId }) }
  function pin(threadId, environmentId) { request("thread.pin", { environmentId: environmentId, threadId: threadId }) }
  function unpin(threadId, environmentId) { request("thread.unpin", { environmentId: environmentId, threadId: threadId }) }
  function setModel(threadId, environmentId, providerInstanceId, model) {
    request("thread.model.set", { environmentId: environmentId, threadId: threadId, providerInstanceId: providerInstanceId, model: model })
  }
  function setModelOption(threadId, environmentId, optionId, value) {
    request("thread.model.option.set", { environmentId: environmentId, threadId: threadId, optionId: optionId, value: value })
  }
  function rename(threadId, environmentId, title) { request("thread.rename", { environmentId: environmentId, threadId: threadId, title: title }) }
  function regenerateTitle(threadId, environmentId) { request("thread.title.regenerate", { environmentId: environmentId, threadId: threadId }) }
  function setRuntime(threadId, environmentId, runtimeMode) {
    request("thread.runtime.set", { environmentId: environmentId, threadId: threadId, runtimeMode: runtimeMode })
  }
  function setInteraction(threadId, environmentId, interactionMode) {
    request("thread.interaction.set", { environmentId: environmentId, threadId: threadId, interactionMode: interactionMode })
  }
  function respondApproval(threadId, environmentId, requestId, decision) {
    request("approval.respond", { environmentId: environmentId, threadId: threadId, requestId: requestId, decision: decision })
  }
  function respondInput(threadId, environmentId, requestId, answers) {
    request("input.respond", { environmentId: environmentId, threadId: threadId, requestId: requestId, answers: answers })
  }

  Process {
    id: bridge
    // QProcess can report a packaged shell wrapper as missing when launched
    // directly during a plugin hot reload. Use the known interpreter while
    // keeping the wrapper responsible for selecting the standalone binary.
    command: ["/bin/sh", root.bridgePath]
    workingDirectory: root.pluginDir
    stdinEnabled: true
    onStarted: root.ready = false
    onExited: {
      root.ready = false
      root.connectionPhase = "disconnected"
      root.openingThread = false
      root.threadSubscriptionActive = false
      root.failPendingRequests()
      if (!root.stopping) restartTimer.restart()
    }
    stdout: SplitParser { onRead: function(line) { root.handleLine(line) } }
    stderr: SplitParser { onRead: function(line) { root.lastError = "The T3 bridge reported an internal error." } }
  }

  Timer {
    id: restartTimer
    interval: 1500
    onTriggered: if (!root.stopping && !bridge.running) bridge.running = true
  }

  Component.onCompleted: bridge.running = true
  Component.onDestruction: {
    stopping = true
    if (bridge.running) bridge.signal(15)
  }
}
