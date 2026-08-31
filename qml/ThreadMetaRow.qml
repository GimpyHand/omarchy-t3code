import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root
  required property var threadData
  property bool showTime: false
  property bool showPhase: false
  property color textColor: Color.accent
  spacing: 0

  function value(key) {
    return String(root.threadData && root.threadData[key] != null ? root.threadData[key] : "").trim()
  }

  function timeLabel() {
    var elapsed = Math.max(0, Date.now() - Date.parse(String(root.threadData && root.threadData.latestActivityAt || "")))
    if (!isFinite(elapsed)) return ""
    if (elapsed < 60000) return "now"
    if (elapsed < 3600000) return Math.floor(elapsed / 60000) + "m"
    if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + "h"
    return Math.floor(elapsed / 86400000) + "d"
  }

  function joinParts(parts) {
    return parts.join("  ·  ")
  }

  function primaryLine() {
    var parts = []
    var environment = root.value("environmentLabel") || root.value("environmentId")
    if (environment !== "") parts.push("󰒋 " + environment)
    var project = root.value("project")
    if (project !== "") parts.push("󰉋 " + project)
    var branch = root.value("branch")
    if (branch !== "") parts.push("󰘬 " + branch)
    return root.joinParts(parts)
  }

  function secondaryLine() {
    var parts = []
    var model = root.value("model") || root.value("provider")
    if (model !== "") parts.push("󰆧 " + model)
    if (root.showTime) {
      var time = root.timeLabel()
      if (time !== "") parts.push("󰥔 " + time)
    }
    if (root.showPhase) {
      var phase = root.value("phase")
      if (phase !== "") parts.push(phase)
    }
    return root.joinParts(parts)
  }

  Text {
    width: parent.width
    visible: root.primaryLine() !== ""
    text: root.primaryLine()
    color: root.textColor
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    horizontalAlignment: Text.AlignHCenter
    elide: Text.ElideRight
  }

  Text {
    width: parent.width
    visible: root.secondaryLine() !== ""
    text: root.secondaryLine()
    color: root.textColor
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    horizontalAlignment: Text.AlignHCenter
    elide: Text.ElideRight
  }
}
