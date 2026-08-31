pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

Item {
  id: root
  required property var service
  signal backRequested()

  readonly property var threadData: service.thread
  readonly property bool hasPendingInput: threadData !== null && (threadData.inputs || []).length > 0
  property var changedFilesToReveal: null

  function diffForMessage(messageId) {
    var diffs = threadData ? (threadData.diffs || []) : []
    for (var i = diffs.length - 1; i >= 0; i--)
      if (String(diffs[i].assistantMessageId || "") === String(messageId)) return diffs[i]
    return null
  }

  function revealChangedFiles(card) {
    changedFilesToReveal = card
    changedFilesRevealTimer.restart()
  }

  function positionChangedFiles() {
    var card = changedFilesToReveal
    changedFilesToReveal = null
    if (!conversation.contentItem || !conversation.contentItem.contentItem || !card || !card.expanded) return
    var cardPosition = card.mapToItem(conversation.contentItem.contentItem, 0, 0)
    var maximumY = Math.max(0, conversation.contentItem.contentHeight - conversation.height)
    conversation.contentItem.contentY = Math.max(0, Math.min(cardPosition.y - Style.spacing.sm, maximumY))
  }

  function snoozeUntilTomorrow() {
    service.snooze(String(threadData.id), String(threadData.environmentId || ""), new Date(Date.now() + 86400000).toISOString())
  }

  Connections {
    target: root.service
    function onThreadChanged() {
      if (!conversation.contentItem) return
      var nearBottom = conversation.contentItem.contentY + conversation.height >= conversation.contentItem.contentHeight - Style.space(100)
      if (nearBottom) Qt.callLater(function() { conversation.contentItem.contentY = Math.max(0, conversation.contentItem.contentHeight - conversation.height) })
    }
  }

  Timer {
    id: changedFilesRevealTimer
    interval: 50
    onTriggered: root.positionChangedFiles()
  }

  Column {
    anchors.fill: parent
    spacing: Style.spacing.md

    Row {
      width: parent.width
      spacing: Style.spacing.md
      Button { iconText: "󰁍"; tooltipText: "Back to T3 Command Center"; onClicked: root.backRequested() }
      Column {
        width: parent.width - lifecycleActions.implicitWidth - Style.space(40) - parent.spacing * 2
        Text {
          width: parent.width
          text: root.threadData ? String(root.threadData.title || "Untitled thread") : "Opening thread…"
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.subtitle
          font.bold: true
          elide: Text.ElideRight
        }
        ThreadMetaRow {
          width: parent.width
          visible: root.threadData !== null
          threadData: root.threadData
          showPhase: true
          textColor: Color.muted
        }
        Text {
          width: parent.width
          visible: root.threadData === null
          text: "Synchronizing with T3"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
      Row {
        id: lifecycleActions
        visible: root.threadData !== null
        spacing: Style.spacing.xs
        Button {
          visible: root.threadData && root.threadData.capabilities.pinning
          iconText: root.threadData && root.threadData.lifecycle === "pinned" ? "󰐃" : "󰤱"
          tooltipText: root.threadData && root.threadData.lifecycle === "pinned" ? "Unpin" : "Pin"
          onClicked: root.threadData.lifecycle === "pinned" ? root.service.unpin(String(root.threadData.id), String(root.threadData.environmentId || "")) : root.service.pin(String(root.threadData.id), String(root.threadData.environmentId || ""))
        }
        Button {
          visible: root.threadData && root.threadData.capabilities.snooze
          iconText: root.threadData && root.threadData.lifecycle === "snoozed" ? "󰒱" : "󰒲"
          tooltipText: root.threadData && root.threadData.lifecycle === "snoozed" ? "Wake" : "Snooze for one day"
          onClicked: root.threadData.lifecycle === "snoozed" ? root.service.unsnooze(String(root.threadData.id), String(root.threadData.environmentId || "")) : root.snoozeUntilTomorrow()
        }
        Button {
          visible: root.threadData && root.threadData.capabilities.settlement
          iconText: root.threadData && root.threadData.lifecycle === "settled" ? "󰅖" : "󰄬"
          tooltipText: root.threadData && root.threadData.lifecycle === "settled" ? "Unsettle" : "Settle"
          onClicked: root.threadData.lifecycle === "settled" ? root.service.unsettle(String(root.threadData.id), String(root.threadData.environmentId || "")) : root.service.settle(String(root.threadData.id), String(root.threadData.environmentId || ""))
        }
      }
    }

    BorderSurface {
      visible: root.threadData && root.threadData.sessionError !== null
      width: parent.width
      height: sessionError.implicitHeight + Style.spacing.md * 2
      radius: Style.cornerRadius
      color: Util.alpha(Color.urgent, 0.10)
      borderSpec: Border.controlSpec("normal", Color.urgent, Color.urgent)
      Text {
        id: sessionError
        anchors.fill: parent
        anchors.margins: Style.spacing.md
        text: root.threadData ? String(root.threadData.sessionError || "") : ""
        color: Color.urgent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    ScrollView {
      id: conversation
      width: parent.width
      height: root.threadData
        ? parent.height - y - (composer.visible ? composer.height + parent.spacing : 0)
        : parent.height - y
      clip: true
      ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

      Column {
        width: conversation.availableWidth
        spacing: Style.spacing.lg

        Text {
          visible: root.threadData === null
          width: parent.width
          topPadding: Style.spacing.huge
          text: "Opening and subscribing to the thread…"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
        }

        Repeater {
          model: root.threadData ? root.threadData.messages : []
          Column {
            required property var modelData
            readonly property var diffData: root.diffForMessage(String(modelData.id))
            width: conversation.availableWidth
            spacing: Style.spacing.md

            MessageBubble { messageData: parent.modelData }
            ChangedFilesCard {
              id: changedFiles
              visible: parent.diffData !== null
              summaryData: parent.diffData || ({ files: [], status: "missing" })
              onRevealRequested: root.revealChangedFiles(changedFiles)
            }
          }
        }

        WorkingIndicator {
          width: conversation.availableWidth
          phase: root.threadData ? String(root.threadData.phase) : "idle"
          startedAt: root.threadData ? String(root.threadData.activeWorkStartedAt || "") : ""
        }

        Repeater {
          model: root.threadData ? root.threadData.approvals : []
          ApprovalCard { required property var modelData; approvalData: modelData; threadId: String(root.threadData.id); service: root.service }
        }

        Repeater {
          model: root.threadData ? root.threadData.inputs : []
          InputCard { required property var modelData; inputData: modelData; threadId: String(root.threadData.id); service: root.service }
        }
      }
    }

    Composer {
      id: composer
      visible: root.threadData !== null && !root.hasPendingInput
      service: root.service
      threadData: root.threadData || ({})
    }
  }

}
