pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

BorderSurface {
  id: root
  required property var service
  required property var threadData
  readonly property var queue: threadData.queue || ({ held: false, canManage: false, total: 0, messages: [] })
  property string editingRunId: ""
  property string editText: ""
  property bool busy: false
  property string actionError: ""

  function finishAction(ok, result) {
    busy = false
    actionError = ok ? "" : String(result && result.message ? result.message : "The queue could not be updated.")
    if (ok) editingRunId = ""
  }

  function cancelMessage(runId) {
    busy = true
    actionError = ""
    service.cancelQueuedMessage(String(threadData.id), String(threadData.environmentId), runId, finishAction)
  }

  function startEditing(message) {
    editingRunId = String(message.runId)
    editText = String(message.text)
    actionError = ""
    Qt.callLater(function() { editor.forceActiveFocus() })
  }

  onQueueChanged: {
    if (!editingRunId) return
    var messages = queue.messages || []
    for (var i = 0; i < messages.length; i++)
      if (String(messages[i].runId) === editingRunId) return
    editingRunId = ""
  }

  width: parent ? parent.width : implicitWidth
  height: content.implicitHeight + Style.spacing.md * 2
  radius: Style.cornerRadius
  color: Util.alpha(Color.foreground, 0.035)
  borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)

  Column {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.margins: Style.spacing.md
    spacing: Style.spacing.sm

    Row {
      width: parent.width
      spacing: Style.spacing.sm
      Text {
        width: parent.width - (resume.visible ? resume.implicitWidth + parent.spacing : 0)
        text: (root.queue.held ? "Queue paused" : "Queued messages") + " · " + root.queue.total
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
        elide: Text.ElideRight
      }
      Button {
        id: resume
        visible: root.queue.held && root.queue.canManage
        text: "Resume"
        enabled: !root.busy
        onClicked: {
          root.busy = true
          root.actionError = ""
          root.service.resumeQueue(String(root.threadData.id), String(root.threadData.environmentId), root.finishAction)
        }
      }
    }

    Repeater {
      model: root.queue.messages || []
      Column {
        id: queueRow
        required property var modelData
        required property int index
        width: content.width
        spacing: Style.spacing.xs
        Text {
          width: parent.width
          text: (queueRow.index + 1) + ". " + String(queueRow.modelData.text || "Screenshot")
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
          maximumLineCount: 3
          elide: Text.ElideRight
        }
        Text {
          visible: queueRow.modelData.attachmentCount > 0
          text: queueRow.modelData.attachmentCount + " attached image(s)"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
        Row {
          visible: root.queue.canManage
          spacing: Style.spacing.sm
          Button {
            text: "Edit"
            enabled: !root.busy && queueRow.modelData.editable
            tooltipText: queueRow.modelData.editable ? "Edit message text; keep attachments" : "This message is too long to edit here"
            onClicked: root.startEditing(queueRow.modelData)
          }
          Button {
            text: "Cancel message"
            enabled: !root.busy
            onClicked: root.cancelMessage(String(queueRow.modelData.runId))
          }
        }
      }
    }

    Text {
      visible: root.queue.total > (root.queue.messages || []).length
      text: "More messages are queued. Earlier entries appear first."
      width: parent.width
      wrapMode: Text.Wrap
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }

    TextArea {
      id: editor
      visible: root.editingRunId.length > 0
      width: parent.width
      height: Math.max(Style.space(54), Math.min(Style.space(110), contentHeight + Style.spacing.md))
      text: root.editText
      onTextChanged: root.editText = text
      enabled: !root.busy
      color: Color.foreground
      selectionColor: Util.alpha(Color.accent, 0.4)
      selectedTextColor: Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      wrapMode: TextEdit.Wrap
      background: Rectangle {
        color: Util.alpha(Color.foreground, 0.06)
        radius: Style.cornerRadius
      }
    }

    Row {
      visible: root.editingRunId.length > 0
      spacing: Style.spacing.sm
      Button {
        text: "Save"
        enabled: !root.busy && root.editText.trim().length > 0
        onClicked: {
          root.busy = true
          root.actionError = ""
          root.service.editQueuedMessage(String(root.threadData.id), String(root.threadData.environmentId), root.editingRunId, root.editText, root.finishAction)
        }
      }
      Button { text: "Keep original"; enabled: !root.busy; onClicked: root.editingRunId = "" }
    }

    Text {
      visible: root.actionError.length > 0
      width: parent.width
      text: root.actionError
      color: Color.urgent
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
    }
  }
}
