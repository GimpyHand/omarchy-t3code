import QtQuick
import qs.Commons
import "WorkingState.js" as WorkingState

Item {
  id: root

  property string phase: "idle"
  property string startedAt: ""
  property double nowMs: Date.now()

  visible: phase === "working" || phase === "starting"
  width: parent ? parent.width : implicitWidth
  height: statusText.implicitHeight + Style.spacing.md * 2

  Timer {
    interval: 1000
    repeat: true
    running: root.visible
    triggeredOnStart: true
    onTriggered: root.nowMs = Date.now()
  }

  Text {
    id: statusText
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.spacing.sm
    anchors.rightMargin: Style.spacing.sm
    text: WorkingState.statusLabel(root.phase, root.startedAt, root.nowMs)
    color: Color.muted
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
  }

  Rectangle {
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: Style.spacing.hairline
    color: Util.alpha(Color.foreground, 0.14)
  }
}
