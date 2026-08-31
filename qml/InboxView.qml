import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

Item {
  id: root
  required property var service
  signal closeRequested()

  property bool creating: false
  property string filterEnvironmentId: ""
  property string filterProjectKey: ""
  property string createEnvironmentId: ""
  property string selectedProject: ""
  property string selectedModel: ""
  property var selectedModelOptions: []
  property string selectedModelOptionsFor: ""
  property string selectedRuntimeMode: "approval-required"
  property string pendingRuntimeMode: ""

  function environmentOptions() {
    var result = []
    var values = root.service.environments || []
    for (var i = 0; i < values.length; i++)
      result.push({ value: String(values[i].id), label: String(values[i].label) + (values[i].status ? " · " + values[i].status : "") })
    return result
  }

  function filterOptions() {
    var result = [{ value: "", label: "All systems" }]
    var values = environmentOptions()
    for (var i = 0; i < values.length; i++) result.push(values[i])
    return result
  }

  function projectFilterOptions() {
    var result = [{ value: "", label: "All projects" }]
    var values = root.service.inbox.projects || []
    var seen = {}
    for (var i = 0; i < values.length; i++) {
      if (filterEnvironmentId && String(values[i].environmentId || "") !== filterEnvironmentId) continue
      var key = String(values[i].projectKey || "")
      if (!key || seen[key]) continue
      seen[key] = true
      result.push({ value: key, label: String(values[i].title) })
    }
    return result
  }

  function projectFilterExists(projectKey) {
    var options = projectFilterOptions()
    for (var i = 0; i < options.length; i++)
      if (options[i].value === projectKey) return true
    return false
  }

  function filterThreads(items) {
    var result = []
    var values = items || []
    for (var i = 0; i < values.length; i++) {
      if (filterEnvironmentId && String(values[i].environmentId || "") !== filterEnvironmentId) continue
      if (filterProjectKey && String(values[i].projectKey || "") !== filterProjectKey) continue
      result.push(values[i])
    }
    return result
  }

  function projectOptions() {
    var result = []
    var values = root.service.inbox.projects || []
    for (var i = 0; i < values.length; i++) {
      if (!createEnvironmentId || String(values[i].environmentId || "") === createEnvironmentId)
        result.push({ value: String(values[i].id), label: String(values[i].title) })
    }
    return result
  }

  function modelOptions() {
    var result = []
    var values = root.service.models || []
    for (var i = 0; i < values.length; i++) {
      if (!values[i].available) continue
      if (createEnvironmentId && String(values[i].environmentId || "") !== createEnvironmentId) continue
      result.push({
        value: String(values[i].instanceId) + "\u001f" + String(values[i].model),
        label: String(values[i].providerLabel) + " · " + String(values[i].label),
        providerLabel: String(values[i].providerLabel),
        modelLabel: String(values[i].label)
      })
    }
    return result
  }

  function descriptorsForModel(value) {
    var models = root.service.models || []
    for (var i = 0; i < models.length; i++) {
      if (createEnvironmentId && String(models[i].environmentId || "") !== createEnvironmentId) continue
      var key = String(models[i].instanceId) + "\u001f" + String(models[i].model)
      if (key === value) return models[i].modelOptions || []
    }
    return []
  }

  function resetSelectedModelOptions() {
    var descriptors = descriptorsForModel(selectedModel)
    var result = []
    for (var i = 0; i < descriptors.length; i++) {
      var descriptor = descriptors[i]
      result.push({
        id: String(descriptor.id),
        label: String(descriptor.label || ""),
        description: descriptor.description || "",
        currentValue: String(descriptor.currentValue || ""),
        choices: descriptor.choices || []
      })
    }
    selectedModelOptions = result
    selectedModelOptionsFor = selectedModel
  }

  function selectModel(value) {
    selectedModel = value
    resetSelectedModelOptions()
  }

  function selectModelOption(optionId, value) {
    var descriptors = selectedModelOptions || []
    var result = []
    for (var i = 0; i < descriptors.length; i++) {
      var descriptor = descriptors[i]
      result.push({
        id: String(descriptor.id),
        label: String(descriptor.label || ""),
        description: descriptor.description || "",
        currentValue: String(descriptor.id) === optionId ? value : String(descriptor.currentValue || ""),
        choices: descriptor.choices || []
      })
    }
    selectedModelOptions = result
  }

  function selectedOptionValues() {
    var descriptors = selectedModelOptions || []
    var result = []
    for (var i = 0; i < descriptors.length; i++) {
      if (descriptors[i].currentValue)
        result.push({ id: String(descriptors[i].id), value: String(descriptors[i].currentValue) })
    }
    return result
  }

  function runtimeModeLabel(value) {
    if (value === "auto-accept-edits") return "Auto-accept edits"
    if (value === "auto") return "Auto"
    if (value === "full-access") return "Full access"
    return "Ask first"
  }

  function runtimeModeWarning(value) {
    if (value === "auto-accept-edits")
      return "File edits will be approved automatically; other actions still ask."
    if (value === "auto")
      return "Supported providers may approve routine actions automatically."
    if (value === "full-access")
      return "Commands and file changes can run without approval prompts."
    return "Commands and file changes require approval."
  }

  function resetNewTaskAccess() {
    selectedRuntimeMode = "approval-required"
    pendingRuntimeMode = ""
  }

  function requestRuntimeMode(value) {
    if (value === "approval-required") {
      resetNewTaskAccess()
      return
    }
    if (value === selectedRuntimeMode) {
      pendingRuntimeMode = ""
      return
    }
    pendingRuntimeMode = value
  }

  function confirmBroaderRuntimeMode() {
    if (!pendingRuntimeMode) return
    selectedRuntimeMode = pendingRuntimeMode
    pendingRuntimeMode = ""
  }

  function projectExists(projectId) {
    var projects = projectOptions()
    for (var i = 0; i < projects.length; i++)
      if (projects[i].value === projectId) return true
    return false
  }

  function resetSelectedProject() {
    selectedProject = ""
    selectedModel = ""
    selectedModelOptionsFor = ""
    ensureDefaults()
  }

  function ensureDefaults() {
    var envs = environmentOptions()
    if (!createEnvironmentId && envs.length > 0) createEnvironmentId = envs[0].value
    if (createEnvironmentId) {
      var found = false
      for (var e = 0; e < envs.length; e++) if (envs[e].value === createEnvironmentId) { found = true; break }
      if (!found && envs.length > 0) createEnvironmentId = envs[0].value
    }
    var projects = projectOptions()
    if (projects.length === 0) {
      selectedProject = ""
    } else if (!selectedProject || !projectExists(selectedProject)) {
      selectedProject = projects[0].value
    }
    var models = root.service.models || []
    var modelStillValid = false
    if (selectedModel) {
      var available = modelOptions()
      for (var m = 0; m < available.length; m++) if (available[m].value === selectedModel) { modelStillValid = true; break }
    }
    if (!selectedModel || !modelStillValid) {
      selectedModel = ""
      for (var i = 0; i < models.length; i++) {
        if (!models[i].available) continue
        if (createEnvironmentId && String(models[i].environmentId || "") !== createEnvironmentId) continue
        if (models[i].isDefault) {
          selectedModel = String(models[i].instanceId) + "\u001f" + String(models[i].model)
          break
        }
      }
      var availableModels = modelOptions()
      if (!selectedModel && availableModels.length > 0) selectedModel = availableModels[0].value
    }
    if (selectedModelOptionsFor !== selectedModel) resetSelectedModelOptions()
  }

  function submitNewThread() {
    var prompt = newPrompt.text.trim()
    if (!prompt || !selectedProject || !createEnvironmentId || pendingRuntimeMode) return
    var split = selectedModel.split("\u001f")
    root.service.createThread(
      createEnvironmentId,
      selectedProject,
      prompt,
      "",
      split[0] || "",
      split[1] || "",
      selectedOptionValues(),
      selectedRuntimeMode)
    newPrompt.text = ""
    creating = false
    resetNewTaskAccess()
  }

  function pin(threadId, environmentId, pinned) {
    pinned ? root.service.unpin(threadId, environmentId) : root.service.pin(threadId, environmentId)
  }
  function settle(threadId, environmentId, settled) {
    settled ? root.service.unsettle(threadId, environmentId) : root.service.settle(threadId, environmentId)
  }
  function snooze(threadId, environmentId, snoozed) {
    if (snoozed) root.service.unsnooze(threadId, environmentId)
    else root.service.snooze(threadId, environmentId, new Date(Date.now() + 86400000).toISOString())
  }

  Connections {
    target: root.service
    function onModelsChanged() {
      root.ensureDefaults()
      root.resetSelectedModelOptions()
    }
    function onInboxChanged() { root.ensureDefaults() }
    function onEnvironmentsChanged() { root.ensureDefaults() }
    function onConnectionPhaseChanged() {
      if (root.service.connectionPhase !== "connected") {
        root.creating = false
        root.resetNewTaskAccess()
      }
    }
  }

  Component.onCompleted: {
    ensureDefaults()
    if (root.service.connectionPhase === "connected") root.service.refreshInbox()
  }

  Column {
    anchors.fill: parent
    spacing: Style.spacing.panelGap

    Item {
      width: parent.width
      height: Math.max(mark.height, title.implicitHeight, controls.implicitHeight)

      T3Mark {
        id: mark
        width: Style.space(32)
        height: Style.space(20)
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        markColor: Color.foreground
      }
      Text {
        id: title
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.verticalCenter: parent.verticalCenter
        text: "Command Center"
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.heading
        font.bold: true
      }
      Row {
        id: controls
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.spacing.xs
        Button {
          iconText: "󰑐"
          tooltipText: root.service.connectionPhase === "connected" ? "Refresh T3 Command Center" : "Retry connection"
          onClicked: root.service.refreshConnection()
        }
        Button { iconText: "󰍃"; tooltipText: "Sign out"; onClicked: root.service.logout() }
        Button { iconText: "󰅖"; tooltipText: "Close"; onClicked: root.closeRequested() }
      }
    }

    Dropdown {
      visible: root.service.environments && root.service.environments.length > 0 && !root.creating
      width: parent.width
      showLabel: false
      options: root.filterOptions()
      value: root.filterEnvironmentId
      onChanged: function(value) {
        root.filterEnvironmentId = value
        if (root.filterProjectKey && !root.projectFilterExists(root.filterProjectKey))
          root.filterProjectKey = ""
      }
    }

    BorderSurface {
      visible: root.service.remoteAccess === "blockedByUpstream" || root.service.connectionPhase === "blocked"
      width: parent.width
      height: blockerText.implicitHeight + Style.spacing.rowPaddingX * 2
      color: Util.alpha(Color.urgent, 0.11)
      borderSpec: Border.controlSpec("normal", Color.urgent, Color.urgent)
      radius: Style.cornerRadius
      Text {
        id: blockerText
        anchors.fill: parent
        anchors.margins: Style.spacing.rowPaddingX
        text: root.service.connectionDetail || root.service.authDetail || "The selected environment cannot be authorized by this OAuth client."
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    Row {
      width: parent.width
      spacing: Style.spacing.md
      Dropdown {
        width: parent.width - (newButton.visible ? newButton.implicitWidth + parent.spacing : 0)
        showLabel: false
        visible: !root.creating
        options: root.projectFilterOptions()
        value: root.filterProjectKey
        onChanged: function(value) { root.filterProjectKey = value }
      }
      Button {
        id: newButton
        iconText: root.creating ? "󰅖" : "󰐕"
        text: root.creating ? "Cancel" : "New Thread"
        visible: root.service.connectionPhase === "connected"
        enabled: root.service.connectionPhase === "connected"
        active: enabled && !root.creating
        onClicked: {
          root.creating = !root.creating
          root.resetNewTaskAccess()
          if (root.creating) Qt.callLater(function() { newPrompt.forceActiveFocus() })
        }
      }
    }

    BorderSurface {
      visible: root.creating && root.service.connectionPhase === "connected"
      width: parent.width
      height: createColumn.implicitHeight + Style.spacing.rowPaddingX * 2
      radius: Style.cornerRadius
      color: Util.alpha(Color.foreground, 0.035)
      borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)

      Column {
        id: createColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.margins: Style.spacing.rowPaddingX
        spacing: Style.spacing.md

        Column {
          width: parent.width
          spacing: Style.spacing.labelGap
          Text {
            text: "System"
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
          }
          Dropdown {
            width: parent.width
            showLabel: false
            foreground: Color.foreground
            options: root.environmentOptions()
            value: root.createEnvironmentId
            onChanged: function(value) {
              if (value === root.createEnvironmentId) return
              root.createEnvironmentId = value
              root.resetSelectedProject()
            }
          }
        }
        Column {
          width: parent.width
          spacing: Style.spacing.labelGap
          Text {
            text: "Project"
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
          }
          Dropdown {
            width: parent.width
            showLabel: false
            foreground: Color.foreground
            options: root.projectOptions()
            value: root.selectedProject
            onChanged: function(value) { root.selectedProject = value }
          }
        }
        TextArea {
          id: newPrompt
          width: parent.width
          height: Style.space(86)
          placeholderText: "What should T3 work on?"
          color: Color.foreground
          placeholderTextColor: Color.muted
          selectionColor: Util.alpha(Color.accent, 0.4)
          selectedTextColor: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: TextEdit.Wrap
          padding: Style.spacing.controlPaddingX
          background: BorderSurface {
            color: Style.normalFillFor(Color.foreground, Color.accent)
            borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)
            radius: Style.cornerRadius
          }
          Keys.onPressed: function(event) {
            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
              root.submitNewThread()
              event.accepted = true
            }
          }
        }

        Row {
          id: createActionRow
          width: parent.width
          spacing: Style.spacing.sm
          readonly property int gapCount: 4
          readonly property real selectorCapacity: Math.max(0, width - createSendButton.width - spacing * gapCount)
          readonly property real selectorWidth: Math.min(selectorCapacity, Style.space(315))

          ModelDropdown {
            id: createModelDropdown
            width: createActionRow.selectorWidth * 0.36
            rowHeight: Style.space(24)
            triggerFontSize: Style.font.caption
            foreground: Color.foreground
            options: root.modelOptions()
            value: root.selectedModel
            onChanged: function(value) { root.selectModel(value) }
          }
          ModelOptionsPicker {
            id: createModelOptionsPicker
            width: createActionRow.selectorWidth * 0.30
            rowHeight: Style.space(24)
            triggerFontSize: Style.font.caption
            foreground: Color.foreground
            descriptors: root.selectedModelOptions
            onChanged: function(optionId, value) { root.selectModelOption(optionId, value) }
          }
          ModelDropdown {
            id: createRuntimeDropdown
            width: createActionRow.selectorWidth - createModelDropdown.width - createModelOptionsPicker.width
            rowHeight: Style.space(24)
            triggerFontSize: Style.font.caption
            foreground: Color.foreground
            showProviderColumn: false
            options: [
              { value: "approval-required", label: "Ask first" },
              { value: "auto-accept-edits", label: "Auto edits" },
              { value: "auto", label: "Auto" },
              { value: "full-access", label: "Full access" }
            ]
            value: root.selectedRuntimeMode
            onChanged: function(value) { root.requestRuntimeMode(value) }
          }
          Item {
            width: Math.max(0, createActionRow.selectorCapacity - createActionRow.selectorWidth)
            height: 1
          }
          Button {
            id: createSendButton
            width: Style.space(32)
            height: Style.space(24)
            iconText: "󰒊"
            tooltipText: root.selectedRuntimeMode === "approval-required"
              ? "Create with approval prompts"
              : "Create with " + root.runtimeModeLabel(root.selectedRuntimeMode)
            active: true
            enabled: newPrompt.text.trim().length > 0
              && root.selectedProject.length > 0
              && root.createEnvironmentId.length > 0
              && root.pendingRuntimeMode.length === 0
              && root.service.connectionPhase === "connected"
            horizontalPadding: Style.spacing.sm
            verticalPadding: Style.spacing.sm
            onClicked: root.submitNewThread()
          }
        }

        BorderSurface {
          visible: root.pendingRuntimeMode.length > 0 || root.selectedRuntimeMode !== "approval-required"
          width: parent.width
          height: runtimeAccessColumn.implicitHeight + Style.spacing.sm * 2
          radius: Style.cornerRadius
          color: Util.alpha(Color.urgent, 0.10)
          borderSpec: Border.controlSpec("normal", Color.urgent, Color.urgent)

          Column {
            id: runtimeAccessColumn
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.margins: Style.spacing.sm
            spacing: Style.spacing.sm

            Text {
              width: parent.width
              text: root.pendingRuntimeMode.length > 0
                ? "Enable " + root.runtimeModeLabel(root.pendingRuntimeMode) + " for this task? "
                  + root.runtimeModeWarning(root.pendingRuntimeMode)
                : root.runtimeModeLabel(root.selectedRuntimeMode) + " is enabled for this task. "
                  + root.runtimeModeWarning(root.selectedRuntimeMode)
              color: Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Row {
              visible: root.pendingRuntimeMode.length > 0
              spacing: Style.spacing.sm
              Button {
                text: "Keep Ask first"
                onClicked: root.resetNewTaskAccess()
              }
              Button {
                text: "Enable " + root.runtimeModeLabel(root.pendingRuntimeMode)
                foreground: Color.urgent
                onClicked: root.confirmBroaderRuntimeMode()
              }
            }

            Button {
              visible: root.pendingRuntimeMode.length === 0
              text: "Return to Ask first"
              onClicked: root.resetNewTaskAccess()
            }
          }
        }
      }
    }

    ScrollView {
      id: inboxScroll
      width: parent.width
      height: parent.height - y
      clip: true
      ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

      Column {
        width: inboxScroll.availableWidth
        spacing: Style.spacing.panelGap

        InboxSection {
          title: "PINNED"
          items: root.filterThreads(root.service.inbox.pinned || [])
          onThreadActivated: function(threadId, environmentId) { root.service.openThread(threadId, environmentId) }
          onPinRequested: function(threadId, environmentId, pinned) { root.pin(threadId, environmentId, pinned) }
          onSettleRequested: function(threadId, environmentId, settled) { root.settle(threadId, environmentId, settled) }
          onSnoozeRequested: function(threadId, environmentId, snoozed) { root.snooze(threadId, environmentId, snoozed) }
        }
        InboxSection {
          title: "INBOX / ACTIVE"
          items: root.filterThreads(root.service.inbox.active || [])
          onThreadActivated: function(threadId, environmentId) { root.service.openThread(threadId, environmentId) }
          onPinRequested: function(threadId, environmentId, pinned) { root.pin(threadId, environmentId, pinned) }
          onSettleRequested: function(threadId, environmentId, settled) { root.settle(threadId, environmentId, settled) }
          onSnoozeRequested: function(threadId, environmentId, snoozed) { root.snooze(threadId, environmentId, snoozed) }
        }
        InboxSection {
          title: "SNOOZED"
          items: root.filterThreads(root.service.inbox.snoozed || [])
          initiallyExpanded: false
          onThreadActivated: function(threadId, environmentId) { root.service.openThread(threadId, environmentId) }
          onPinRequested: function(threadId, environmentId, pinned) { root.pin(threadId, environmentId, pinned) }
          onSettleRequested: function(threadId, environmentId, settled) { root.settle(threadId, environmentId, settled) }
          onSnoozeRequested: function(threadId, environmentId, snoozed) { root.snooze(threadId, environmentId, snoozed) }
        }
        InboxSection {
          title: "SETTLED"
          items: root.filterThreads(root.service.inbox.settled || [])
          initiallyExpanded: false
          onThreadActivated: function(threadId, environmentId) { root.service.openThread(threadId, environmentId) }
          onPinRequested: function(threadId, environmentId, pinned) { root.pin(threadId, environmentId, pinned) }
          onSettleRequested: function(threadId, environmentId, settled) { root.settle(threadId, environmentId, settled) }
          onSnoozeRequested: function(threadId, environmentId, snoozed) { root.snooze(threadId, environmentId, snoozed) }
        }

        Text {
          visible: (root.service.inbox.pinned || []).length + (root.service.inbox.active || []).length + (root.service.inbox.snoozed || []).length + (root.service.inbox.settled || []).length === 0
            && root.service.connectionPhase === "connected"
          width: parent.width
          topPadding: Style.spacing.huge
          text: "T3 Command Center is clear."
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
        }
      }
    }
  }
}
