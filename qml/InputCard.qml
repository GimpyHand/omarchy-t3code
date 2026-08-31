pragma ComponentBehavior: Bound

import QtQuick
import qs.Commons
import qs.Ui
import "AttentionState.js" as AttentionState

BorderSurface {
  id: root
  required property var inputData
  required property string threadId
  required property var service
  readonly property string environmentId: service && service.thread ? String(service.thread.environmentId || "") : ""
  property var answers: ({})
  readonly property color inputColor: AttentionState.inputColor()
  readonly property color secondaryText: Util.alpha(Color.foreground, 0.70)

  function valueFor(questionId) { return answers[String(questionId)] }
  function isSelected(questionId, label) {
    var value = valueFor(questionId)
    return Array.isArray(value) ? value.indexOf(label) >= 0 : value === label
  }
  function setOption(question, label) {
    var next = {}
    for (var key in answers) next[key] = answers[key]
    var id = String(question.id)
    if (question.multiSelect) {
      var values = Array.isArray(next[id]) ? next[id].slice() : []
      var index = values.indexOf(label)
      if (index >= 0) values.splice(index, 1)
      else values.push(label)
      next[id] = values
    } else next[id] = label
    answers = next
  }
  function setCustom(questionId, value) {
    var trimmed = String(value).trim()
    if (!trimmed) return
    var next = {}
    for (var key in answers) next[key] = answers[key]
    next[String(questionId)] = trimmed
    answers = next
  }
  function complete() {
    var questions = inputData.questions || []
    for (var i = 0; i < questions.length; i++) {
      var value = valueFor(questions[i].id)
      if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || String(value).length === 0) return false
    }
    return questions.length > 0
  }

  width: parent ? parent.width : implicitWidth
  height: content.implicitHeight + Style.spacing.rowPaddingX * 2
  radius: Style.cornerRadius
  color: Util.alpha(root.inputColor, 0.055)
  borderSpec: Border.controlSpec("normal", root.inputColor, root.inputColor)

  Column {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.margins: Style.spacing.rowPaddingX
    spacing: Style.spacing.lg

    Text {
      text: "T3 needs your input"
      color: root.inputColor
      font.family: Style.font.family
      font.pixelSize: Style.font.subtitle
      font.bold: true
    }

    Repeater {
      model: root.inputData.questions || []
      Column {
        id: questionBlock
        required property var modelData
        width: content.width
        spacing: Style.spacing.md

        Text {
          width: parent.width
          text: String(parent.modelData.header || "Question")
          color: root.secondaryText
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          font.bold: true
          wrapMode: Text.WordWrap
        }
        Text {
          width: parent.width
          text: String(parent.modelData.question || "")
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }
        Text {
          visible: parent.modelData.multiSelect === true
          width: parent.width
          text: "Select one or more options."
          color: root.secondaryText
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
        Column {
          width: parent.width
          spacing: Style.spacing.xs
          Repeater {
            model: questionBlock.modelData.options || []
            Button {
              id: optionButton
              required property var modelData
              readonly property string optionLabel: String(modelData.label || "")
              readonly property string optionDescription: {
                var description = String(modelData.description || "")
                return description !== optionLabel ? description : ""
              }

              width: questionBlock.width
              height: Math.max(optionCopy.implicitHeight, selectionMark.height) + Style.spacing.controlPaddingY * 2 + Style.space(2)
              active: root.isSelected(questionBlock.modelData.id, optionLabel)
              accent: root.inputColor
              background: Util.alpha(Color.foreground, 0.035)
              bordered: false
              focusable: true
              onClicked: root.setOption(questionBlock.modelData, optionLabel)

              Column {
                id: optionCopy
                anchors.left: parent.left
                anchors.right: selectionMark.left
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.spacing.controlPaddingX + Style.space(1)
                anchors.rightMargin: Style.spacing.sm
                spacing: Style.spacing.xs

                Text {
                  width: parent.width
                  text: optionButton.optionLabel
                  color: Color.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  font.bold: true
                  wrapMode: Text.WordWrap
                }
                Text {
                  visible: optionButton.optionDescription.length > 0
                  width: parent.width
                  text: optionButton.optionDescription
                  color: root.secondaryText
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }
              }

              BorderSurface {
                id: selectionMark
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.controlPaddingX + Style.space(1)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(16)
                height: width
                radius: questionBlock.modelData.multiSelect ? Style.space(3) : width / 2
                color: optionButton.active ? root.inputColor : "transparent"
                borderSpec: Border.flat(optionButton.active ? root.inputColor : root.secondaryText, 1)

                Text {
                  anchors.centerIn: parent
                  visible: optionButton.active
                  text: "✓"
                  color: Color.background
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }
            }
          }
        }
        TextField {
          width: parent.width
          placeholderText: "Or type another answer"
          placeholderTextColor: root.secondaryText
          accent: root.inputColor
          onEditingFinished: root.setCustom(parent.modelData.id, text)
        }
      }
    }

    Button {
      anchors.right: parent.right
      text: (root.inputData.questions || []).length > 1 ? "Submit answers" : "Submit answer"
      iconText: "󰒊"
      accent: root.inputColor
      active: true
      enabled: root.complete()
      onClicked: root.service.respondInput(root.threadId, root.environmentId, String(root.inputData.requestId), root.answers)
    }
  }
}
