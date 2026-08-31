import QtQuick
import Quickshell

ShellRoot {
  id: root
  property bool failed: false
  property var files: [
    "ApprovalCard.qml",
    "BarWidget.qml",
    "ChangedFilesCard.qml",
    "Composer.qml",
    "InboxSection.qml",
    "InboxView.qml",
    "InputCard.qml",
    "LoginView.qml",
    "MessageBubble.qml",
    "ModelOptionsPicker.qml",
    "Panel.qml",
    "Service.qml",
    "T3Mark.qml",
    "ThreadMetaRow.qml",
    "ThreadRow.qml",
    "ThreadView.qml"
  ]

  Component.onCompleted: {
    for (var i = 0; i < files.length; i++) {
      // Ui.KeyboardPanel needs Quickshell's Wayland PanelWindow backend.
      // qmllint checks BarWidget.qml headlessly; SmokeModal.qml exercises it
      // when a compositor is available.
      if (files[i] === "BarWidget.qml") continue
      var component = Qt.createComponent(Qt.resolvedUrl("plugin-qml/" + files[i]), Component.PreferSynchronous)
      if (component.status === Component.Error) {
        failed = true
        console.error("T3_QML_ERROR " + files[i] + ": " + component.errorString())
      }
    }
    if (!failed) console.info("T3_QML_SMOKE_OK")
    quitTimer.start()
  }

  Timer {
    id: quitTimer
    interval: 50
    onTriggered: Qt.quit()
  }
}
