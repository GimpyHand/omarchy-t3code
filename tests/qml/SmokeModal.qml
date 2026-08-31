import QtQuick
import Quickshell

ShellRoot {
  id: root
  property bool failed: false
  property var modalWidget: null

  Component.onCompleted: {
    var component = Qt.createComponent(Qt.resolvedUrl("plugin-qml/BarWidget.qml"), Component.PreferSynchronous)
    modalWidget = component.createObject(modalHost, { bar: fakeBar, width: 26, height: 26 })
    if (!modalWidget) {
      failed = true
      console.error("T3_QML_ERROR modal instantiation: " + component.errorString())
    } else {
      modalWidget.open()
      if (!modalWidget.opened) {
        failed = true
        console.error("T3_QML_ERROR modal did not open through Ui.Panel")
      }
      modalWidget.close()
      if (modalWidget.opened) {
        failed = true
        console.error("T3_QML_ERROR modal did not close through Ui.Panel")
      }
    }
    if (!failed) console.info("T3_QML_SMOKE_OK")
    quitTimer.start()
  }

  PanelWindow {
    visible: true
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    implicitWidth: 26
    implicitHeight: 26
    mask: Region { width: 0; height: 0 }

    Item {
      id: modalHost
      anchors.fill: parent
    }
  }

  QtObject {
    id: fakeService
    property string authPhase: "signedOut"
    property string authDetail: ""
    property string connectionPhase: "disconnected"
    property int attentionCount: 0
    property var thread: null
    signal authCompleted()
    signal navigateThread(string threadId)
    signal navigateInbox()
    function startLogin() {}
    function refreshEnvironments() {}
  }

  QtObject {
    id: fakeShell
    function serviceFor(pluginId) { return fakeService }
  }

  QtObject {
    id: fakeBar
    property var shell: fakeShell
    property bool vertical: false
    property int barSize: 26
    property string position: "top"
    property string fontFamily: "monospace"
    property color foreground: "#f4f4f5"
    property color barForeground: foreground
    property color urgent: "#ef4444"
    property bool foregroundAnimationEnabled: false
    property var activePopout: null
    property var clickTargets: []
    function requestPopout(owner) { activePopout = owner }
    function releasePopout(owner) { if (activePopout === owner) activePopout = null }
    function registerClickTarget(target) { clickTargets.push(target) }
    function unregisterClickTarget(target) {}
    function showTooltip(target, text) {}
    function hideTooltip(target) {}
  }

  Timer {
    id: quitTimer
    interval: 50
    onTriggered: Qt.quit()
  }
}
