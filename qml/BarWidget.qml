pragma ComponentBehavior: Bound

import QtQuick
import qs.Commons
import qs.Ui as Ui
import "BarState.js" as BarState

Ui.Panel {
  id: root
  moduleName: "io.github.gimpyhand.omarchy-t3code"
  ipcTarget: "io.github.gimpyhand.omarchy-t3code"

  readonly property var t3: bar?.shell?.serviceFor("io.github.gimpyhand.omarchy-t3code")
  readonly property bool connected: t3 && t3.connectionPhase === "connected"
  readonly property bool hasAttention: t3 && t3.attentionCount > 0
  readonly property string stateText: BarState.stateLabel(t3)
  readonly property color stateColor: BarState.stateColor(t3)

  implicitWidth: icon.implicitWidth
  implicitHeight: icon.implicitHeight

  onOpenedChanged: {
    if (opened) panelContent.prepareForOpen(JSON.stringify({ route: "inbox" }))
  }

  Ui.WidgetButton {
    id: icon
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: vertical ? -1 : statusContent.implicitWidth + Style.space(16)
    fixedHeight: vertical ? statusContent.implicitWidth + Style.space(16) : -1
    active: root.hasAttention
    tooltipText: root.connected
      ? (root.hasAttention ? root.t3.attentionCount + " T3 threads need attention" : "T3 Command Center · " + root.stateText)
      : "T3 Command Center · " + root.stateText

    Row {
      id: statusContent
      anchors.centerIn: parent
      spacing: Style.space(6)
      rotation: icon.vertical ? 90 : 0

      Item {
        width: Style.space(16)
        height: width

        T3Mark {
          anchors.centerIn: parent
          width: Style.space(16)
          height: Style.space(11)
          markColor: icon.foreground
        }
      }

      Rectangle {
        width: Style.space(6)
        height: width
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        color: root.stateColor
      }
    }

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton && root.t3) root.t3.refreshEnvironments()
      else root.toggle()
    }
  }

  Ui.KeyboardPanel {
    id: modal
    anchorItem: icon
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panelContent
    contentWidth: modal.fittedContentWidth(Style.space(460))
    contentHeight: modal.cappedContentHeight(Style.space(720))

    Panel {
      id: panelContent
      anchors.fill: parent
      // serviceFor() can briefly yield undefined while Omarchy rebuilds the
      // bar before its service registry finishes loading. Normalize that
      // startup gap to null so Panel's guarded Loader stays inactive.
      service: root.t3 || null
      onCloseRequested: root.close()
    }
  }
}
