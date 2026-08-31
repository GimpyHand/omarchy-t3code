import QtQuick
import qs.Commons
import qs.Ui
import "MarkdownSafety.js" as MarkdownSafety

Item {
  id: root
  required property var messageData

  function attachmentSummary() {
    var attachments = root.messageData.attachments || []
    var lines = []
    for (var i = 0; i < attachments.length; i++)
      lines.push("[image: " + String(attachments[i].name || "screenshot") + "]")
    return lines.join("\n")
  }

  function displayedText() {
    var value = root.messageData.role === "assistant"
      ? MarkdownSafety.safeMarkdown(root.messageData.text)
      : String(root.messageData.text || "")
    var summary = root.attachmentSummary()
    return value + (value && summary ? "\n" : "") + summary
  }

  width: parent ? parent.width : implicitWidth
  height: bubble.height

  BorderSurface {
    id: bubble
    width: root.messageData.role === "user" ? Math.min(parent.width * 0.88, body.implicitWidth + Style.spacing.rowPaddingX * 2) : parent.width
    height: body.implicitHeight + Style.spacing.rowPaddingX * 2
    anchors.right: root.messageData.role === "user" ? parent.right : undefined
    anchors.left: root.messageData.role === "user" ? undefined : parent.left
    radius: Style.cornerRadius
    color: root.messageData.role === "user" ? Style.selectedFillFor(Color.foreground, Color.accent) : "transparent"
    borderSpec: root.messageData.role === "user" ? Border.controlSpec("normal", Color.foreground, Color.accent) : Border.none()

    Text {
      id: body
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.spacing.rowPaddingX
      text: root.displayedText() + (root.messageData.streaming ? "  ▍" : "")
      textFormat: root.messageData.role === "assistant" ? Text.MarkdownText : Text.PlainText
      color: Color.foreground
      linkColor: Color.accent
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      onLinkActivated: function(link) {
        if (MarkdownSafety.isAllowedExternalUrl(link)) Qt.openUrlExternally(String(link))
      }
    }
  }
}
