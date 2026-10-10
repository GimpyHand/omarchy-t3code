import QtQuick
import QtQuick.Window
import Quickshell
import "plugin-qml" as Plugin
ShellRoot {
  id: root
  property real beforeY: 0
  function findMessage(item, messageId) {
    if (item.modelData && String(item.modelData.id) === messageId) return item
    var children = item.children || []
    for (var i = 0; i < children.length; i++) {
      var result = findMessage(children[i], messageId)
      if (result) return result
    }
    return null
  }
  function findConversation(item) {
    if (item.objectName === "conversation") return item
    var children = item.children || []
    for (var i = 0; i < children.length; i++) { var result = findConversation(children[i]); if (result) return result }
    return null
  }
  function messages(prefix, count) {
    var result = []
    for (var i = 0; i < count; i++) result.push({ id: prefix + i, role: "assistant", text: prefix + " " + i + "\nA message in the conversation.", attachments: [], streaming: false })
    return result
  }
  Window {
    width: 460; height: 720; visible: true; color: "#171717"
    Plugin.ThreadView { id: view; x: 16; y: 16; width: 428; height: 688; service: fake }
  }
  QtObject {
    id: fake
    property var thread: ({ id: "thread", environmentId: "env", project: "Project", environmentLabel: "Desktop", title: "History pagination", provider: "codex", model: "model", phase: "idle", lifecycle: "active", sessionError: null, runtimeMode: "approval-required", interactionMode: "default", modelOptions: [], capabilities: { pinning: false, snooze: false, settlement: false }, queue: { total: 0, held: false, messages: [] }, history: { hasMore: true, browsing: false, loading: false, error: null }, messages: root.messages("Recent", 20), inputs: [], approvals: [], diffs: [] })
    property var models: []
    property var callback: null
    function loadEarlier(threadId, environmentId, done) { callback = done; loadTimer.start() }
    function showLatest(threadId, environmentId, done) { var next = JSON.parse(JSON.stringify(thread)); next.messages = root.messages("Recent", 20); next.history.browsing = false; thread = next; done(true, {}) }
    function closeThread() {}
  }
  Timer {
    interval: 400; running: true
    onTriggered: {
      var conversation = root.findConversation(view)
      if (!conversation) throw new Error("No conversation")
      conversation.contentItem.contentY = 160
      root.beforeY = conversation.contentItem.contentY
      view.loadEarlier()
      if (!view.historyAnchorId) throw new Error("No history anchor captured")
    }
  }
  Timer {
    id: loadTimer; interval: 100
    onTriggered: {
      var next = JSON.parse(JSON.stringify(fake.thread))
      next.messages = root.messages("Older", 5).concat(next.messages)
      next.history.browsing = true
      fake.thread = next
      fake.callback(true, { loaded: true })
      verify.start()
    }
  }
  Timer {
    id: verify; interval: 200
    onTriggered: {
      var conversation = root.findConversation(view)
      var row = root.findMessage(view, view.historyAnchorId)
      if (!row) throw new Error("Original message disappeared")
      var offset = row.mapToItem(conversation.contentItem.contentItem, 0, 0).y - conversation.contentItem.contentY
      if (Math.abs(offset - view.historyAnchorOffset) > 1 || view.loadingHistory || conversation.contentItem.contentY <= root.beforeY)
        throw new Error("Scroll anchor was not preserved")
      console.info("T3_HISTORY_QML_OK")
      Qt.quit()
    }
  }
}
