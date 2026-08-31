import QtQuick
import qs.Commons
import qs.Ui

BorderSurface {
  id: root
  required property var approvalData
  required property string threadId
  required property var service
  readonly property string environmentId: service && service.thread ? String(service.thread.environmentId || "") : ""

  width: parent ? parent.width : implicitWidth
  height: content.implicitHeight + Style.spacing.rowPaddingX * 2
  radius: Style.cornerRadius
  color: Util.alpha(Color.urgent, 0.10)
  borderSpec: Border.controlSpec("selected", Color.foreground, Color.urgent)

  Column {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.margins: Style.spacing.rowPaddingX
    spacing: Style.spacing.md

    Text {
      text: "Approval required · " + String(root.approvalData.requestKind || "request")
      color: Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.subtitle
      font.bold: true
    }
    Text {
      visible: root.approvalData.detail !== null
      width: parent.width
      text: String(root.approvalData.detail || "")
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      wrapMode: Text.WrapAnywhere
    }
    Flow {
      width: parent.width
      spacing: Style.spacing.md
      Button { text: "Decline"; foreground: Color.urgent; onClicked: root.service.respondApproval(root.threadId, root.environmentId, String(root.approvalData.requestId), "decline") }
      Button { text: "Allow session"; onClicked: root.service.respondApproval(root.threadId, root.environmentId, String(root.approvalData.requestId), "acceptForSession") }
      Button { text: "Approve"; active: true; onClicked: root.service.respondApproval(root.threadId, root.environmentId, String(root.approvalData.requestId), "accept") }
    }
  }
}
