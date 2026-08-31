pragma ComponentBehavior: Bound

import QtQuick
import "UiState.js" as UiState

FocusScope {
  id: root
  property var service: null
  property string route: "inbox"
  signal closeRequested()

  function prepareForOpen(payloadJson) {
    var requested = ""
    try { requested = String(JSON.parse(String(payloadJson || "{}")).route || "") }
    catch (error) {}
    route = UiState.routeForOpen(service ? service.authPhase : "signedOut", requested, service && service.thread !== null)
    Qt.callLater(function() { root.forceActiveFocus() })
  }

  Connections {
    target: root.service
    function onAuthCompleted() { root.route = "inbox" }
    function onNavigateThread(threadId) { root.route = "thread" }
    function onNavigateInbox() { root.route = UiState.routeAfterAuthentication(root.service ? root.service.authPhase : "signedOut") }
  }

  focus: true
  Keys.onEscapePressed: root.closeRequested()

  Loader {
    anchors.fill: parent
    // Omarchy can construct the bar widget just before its singleton service
    // is available. Required view properties must not be evaluated during
    // that short interval.
    active: root.service !== null
    sourceComponent: root.route === "thread"
      ? threadView
      : ((root.service && root.service.authPhase === "signedIn") || root.route === "inbox" ? inboxView : loginView)
  }

  Component { id: loginView; LoginView { service: root.service } }
  Component { id: inboxView; InboxView { service: root.service; onCloseRequested: root.closeRequested() } }
  Component { id: threadView; ThreadView { service: root.service; onBackRequested: { root.route = "inbox"; root.service.closeThread() } } }
}
