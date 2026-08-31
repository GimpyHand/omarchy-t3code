import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui

BorderSurface {
  id: root
  required property var service
  required property var threadData
  readonly property string selectedModel: String(threadData.provider || "") + "\u001f" + String(threadData.model || "")
  property var attachments: []
  property bool pastingImage: false
  property bool sending: false
  property string attachmentError: ""
  readonly property int attachmentLimit: 8

  function modelOptions() {
    var result = []
    var values = service.models || []
    var environmentId = String(threadData.environmentId || "")
    for (var i = 0; i < values.length; i++) {
      if (!values[i].available) continue
      if (environmentId && String(values[i].environmentId || "") !== environmentId) continue
      result.push({
        value: String(values[i].instanceId) + "\u001f" + String(values[i].model),
        label: String(values[i].providerLabel) + " · " + String(values[i].label || values[i].model),
        providerLabel: String(values[i].providerLabel),
        modelLabel: String(values[i].label || values[i].model)
      })
    }
    return result
  }

  function sendMessage() {
    var value = prompt.text.trim()
    if (sending || (!value && attachments.length === 0)) return
    var sentAttachments = attachments
    var attachmentIds = []
    for (var i = 0; i < sentAttachments.length; i++) attachmentIds.push(String(sentAttachments[i].id))
    prompt.text = ""
    attachments = []
    attachmentError = ""
    sending = true
    service.send(String(threadData.id), String(threadData.environmentId || ""), value, attachmentIds, function(ok, result) {
      root.sending = false
      if (ok) return
      root.attachments = sentAttachments.concat(root.attachments)
      prompt.text = prompt.text.length > 0 ? value + "\n" + prompt.text : value
      root.attachmentError = String(result && result.message ? result.message : "The message could not be sent.")
    })
  }

  function pasteScreenshot() {
    if (pastingImage || sending) return
    if (attachments.length >= attachmentLimit) {
      attachmentError = "You can attach up to " + attachmentLimit + " screenshots per message."
      return
    }
    pastingImage = true
    attachmentError = ""
    service.pasteScreenshot(String(threadData.id), String(threadData.environmentId || ""), function(ok, result) {
      root.pastingImage = false
      if (!ok) {
        root.attachmentError = String(result && result.message ? result.message : "The screenshot could not be pasted.")
        return
      }
      root.attachments = root.attachments.concat([result])
    })
  }

  function removeAttachment(index) {
    if (index < 0 || index >= attachments.length) return
    var attachment = attachments[index]
    var next = attachments.slice(0)
    next.splice(index, 1)
    attachments = next
    attachmentError = ""
    service.discardAttachment(String(threadData.id), String(threadData.environmentId || ""), String(attachment.id))
  }

  function handlePasteShortcut(event) {
    if (!event.matches(StandardKey.Paste) || String(Quickshell.clipboardText || "").length > 0) return false
    pasteScreenshot()
    event.accepted = true
    return true
  }

  function discardAttachments() {
    for (var i = 0; i < attachments.length; i++)
      service.discardAttachment(String(threadData.id), String(threadData.environmentId || ""), String(attachments[i].id))
  }

  width: parent ? parent.width : implicitWidth
  height: controls.implicitHeight + Style.spacing.md * 2
  radius: Style.cornerRadius
  color: Util.alpha(Color.foreground, 0.035)
  borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)

  Column {
    id: controls
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.margins: Style.spacing.md
    spacing: Style.spacing.sm

    TextArea {
      id: prompt
      width: parent.width
      height: Math.max(Style.space(54), Math.min(Style.space(110), contentHeight + Style.spacing.controlPaddingX * 2))
      placeholderText: root.threadData.phase === "working" ? "Queue or steer with a follow-up…" : "Send a follow-up…"
      color: Color.foreground
      placeholderTextColor: Color.muted
      selectionColor: Util.alpha(Color.accent, 0.4)
      selectedTextColor: Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      wrapMode: TextEdit.Wrap
      padding: Style.spacing.controlPaddingX
      background: Rectangle { color: "transparent" }
      Keys.onPressed: function(event) {
        if (root.handlePasteShortcut(event)) return
        if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
          root.sendMessage()
          event.accepted = true
        }
      }
    }

    Flickable {
      width: parent.width
      height: visible ? Style.space(58) : 0
      visible: root.attachments.length > 0
      clip: true
      contentWidth: attachmentStrip.implicitWidth
      contentHeight: height
      boundsBehavior: Flickable.StopAtBounds
      interactive: contentWidth > width

      Row {
        id: attachmentStrip
        height: parent.height
        spacing: Style.spacing.sm

        Repeater {
          model: root.attachments

          BorderSurface {
            required property var modelData
            required property int index
            width: Style.space(58)
            height: Style.space(58)
            radius: Style.cornerRadius
            color: Util.alpha(Color.foreground, 0.06)
            borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)
            clip: true

            Image {
              anchors.fill: parent
              anchors.margins: Style.space(2)
              source: String(parent.modelData.previewUrl || "")
              fillMode: Image.PreserveAspectCrop
              asynchronous: true
            }

            Button {
              width: Style.space(18)
              height: Style.space(18)
              anchors.top: parent.top
              anchors.right: parent.right
              iconText: "󰅖"
              tooltipText: "Remove screenshot"
              background: Util.alpha(Color.background, 0.86)
              horizontalPadding: Style.space(2)
              verticalPadding: Style.space(2)
              enabled: !root.sending
              onClicked: root.removeAttachment(parent.index)
            }
          }
        }
      }
    }

    Text {
      width: parent.width
      visible: root.pastingImage || root.attachmentError.length > 0
      text: root.pastingImage ? "Reading screenshot from the clipboard…" : root.attachmentError
      color: root.pastingImage ? Color.muted : Color.urgent
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Row {
      id: actionRow
      width: parent.width
      spacing: Style.spacing.sm
      readonly property int gapCount: stopButton.visible ? 6 : 5
      readonly property real selectorCapacity: Math.max(0, width - sendButton.width
        - pasteButton.width - (stopButton.visible ? stopButton.width : 0) - spacing * gapCount)
      readonly property real selectorWidth: Math.min(selectorCapacity, Style.space(315))

      ModelDropdown {
        id: modelDropdown
        width: actionRow.selectorWidth * 0.36
        rowHeight: Style.space(24)
        triggerFontSize: Style.font.caption
        options: root.modelOptions()
        value: root.selectedModel
        onChanged: function(value) {
          var split = value.split("\u001f")
          root.service.setModel(String(root.threadData.id), String(root.threadData.environmentId || ""), split[0], split[1])
        }
      }
      ModelOptionsPicker {
        id: modelOptionsPicker
        width: actionRow.selectorWidth * 0.30
        rowHeight: Style.space(24)
        triggerFontSize: Style.font.caption
        descriptors: root.threadData.modelOptions || []
        onChanged: function(optionId, value) {
          root.service.setModelOption(String(root.threadData.id), String(root.threadData.environmentId || ""), optionId, value)
        }
      }
      ModelDropdown {
        id: runtimeDropdown
        width: actionRow.selectorWidth - modelDropdown.width - modelOptionsPicker.width
        rowHeight: Style.space(24)
        triggerFontSize: Style.font.caption
        showProviderColumn: false
        options: [
          { value: "approval-required", label: "Ask first" },
          { value: "auto-accept-edits", label: "Auto edits" },
          { value: "auto", label: "Auto" },
          { value: "full-access", label: "Full access" }
        ]
        value: String(root.threadData.runtimeMode)
        onChanged: function(value) { root.service.setRuntime(String(root.threadData.id), String(root.threadData.environmentId || ""), value) }
      }
      Item {
        width: Math.max(0, actionRow.selectorCapacity - actionRow.selectorWidth)
        height: 1
      }
      Button {
        id: pasteButton
        width: Style.space(32)
        height: Style.space(24)
        iconText: "󰉢"
        tooltipText: "Paste screenshot (Ctrl+V)"
        enabled: !root.pastingImage && !root.sending && root.attachments.length < root.attachmentLimit
        horizontalPadding: Style.spacing.sm
        verticalPadding: Style.spacing.sm
        onClicked: root.pasteScreenshot()
      }
      Button {
        id: stopButton
        width: Style.space(32)
        height: Style.space(24)
        visible: root.threadData.phase === "working" || root.threadData.phase === "starting"
        iconText: "󰓛"
        tooltipText: "Stop"
        foreground: Color.urgent
        horizontalPadding: Style.spacing.sm
        verticalPadding: Style.spacing.sm
        onClicked: root.service.interrupt(String(root.threadData.id), String(root.threadData.environmentId || ""))
      }
      Button {
        id: sendButton
        width: Style.space(32)
        height: Style.space(24)
        iconText: "󰒊"
        tooltipText: "Send"
        active: true
        enabled: !root.sending && (prompt.text.trim().length > 0 || root.attachments.length > 0)
        horizontalPadding: Style.spacing.sm
        verticalPadding: Style.spacing.sm
        onClicked: root.sendMessage()
      }
    }
  }

  Component.onDestruction: discardAttachments()
}
