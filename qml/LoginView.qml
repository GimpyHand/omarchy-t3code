import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: root
  required property var service

  Column {
    anchors.centerIn: parent
    width: Math.min(parent.width, Style.space(360))
    spacing: Style.space(18)

    T3Mark {
      width: Style.space(72)
      height: Style.space(44)
      anchors.horizontalCenter: parent.horizontalCenter
      markColor: Color.foreground
    }

    Text {
      width: parent.width
      text: "T3 Command Center"
      color: Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.display
      font.bold: true
      horizontalAlignment: Text.AlignHCenter
    }

    Text {
      width: parent.width
      text: root.service && root.service.authPhase === "signingIn"
        ? "Complete sign-in in your browser with your T3 Connect email and password."
        : "Monitor, manage and steer T3 Command Center without opening the full application."
      color: Qt.darker(Color.foreground, 1.45)
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
    }

    Button {
      anchors.horizontalCenter: parent.horizontalCenter
      text: root.service && root.service.authPhase === "signingIn" ? "Waiting for T3 Connect…" : "Sign in with T3 Connect"
      iconText: root.service && root.service.authPhase === "signingIn" ? "󰔟" : "󰈹"
      foreground: Color.foreground
      active: true
      enabled: root.service && root.service.authPhase !== "signingIn"
      onClicked: root.service.startLogin()
    }

    Text {
      visible: root.service && root.service.authDetail !== ""
      width: parent.width
      text: root.service ? root.service.authDetail : ""
      color: Color.urgent
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
    }
  }
}
