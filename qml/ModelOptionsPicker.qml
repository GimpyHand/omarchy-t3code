import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

Item {
  id: root

  property var descriptors: []
  property color foreground: Color.popups.text
  property color background: Color.popups.background
  property color popupBorder: Color.popups.border
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property real triggerFontSize: Style.font.body
  property int rowHeight: Style.spacing.controlHeight
  readonly property var popupBorderSpec: Border.localOrSurfaceSpec("popups", "border", popupBorder, Color.popups.border, Style.normalBorderWidth)
  readonly property bool popupOpen: popup.opened

  signal changed(string optionId, string value)

  function currentLabel(descriptor) {
    var choices = descriptor && descriptor.choices ? descriptor.choices : []
    var currentValue = String(descriptor && descriptor.currentValue || "")
    for (var i = 0; i < choices.length; i++)
      if (String(choices[i].id) === currentValue) return String(choices[i].label)
    return currentValue
  }

  function summary() {
    var values = descriptors || []
    for (var i = 0; i < values.length; i++) {
      var label = currentLabel(values[i])
      if (label) return label
    }
    return "Options"
  }

  function open() { if (descriptors.length > 0) popup.open() }
  function close() { popup.close() }
  function toggle() { popup.opened ? popup.close() : open() }

  implicitWidth: Style.spacing.dropdownWidth
  implicitHeight: rowHeight
  enabled: descriptors.length > 0

  BorderSurface {
    id: trigger
    anchors.fill: parent
    radius: Style.cornerRadius

    readonly property bool hot: triggerHover.hovered
    readonly property var controlBorderSpec: Border.controlSpec(
      activeFocus ? "focus" : (hot ? "hover-cursor" : "normal"),
      root.foreground,
      root.accent)

    color: Style.controlFill(activeFocus, hot, root.foreground, root.accent)
    borderSpec: controlBorderSpec
    opacity: root.enabled ? 1 : 0.55
    activeFocusOnTab: root.enabled

    HoverHandler { id: triggerHover }

    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
          || event.key === Qt.Key_Space || event.key === Qt.Key_Down) {
        root.toggle()
        event.accepted = true
      } else if (event.key === Qt.Key_Escape && popup.opened) {
        popup.close()
        event.accepted = true
      }
    }

    Text {
      anchors.left: parent.left
      anchors.right: chevron.left
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: trigger.borderLeft + Style.spacing.controlPaddingX
      anchors.rightMargin: trigger.borderRight + Style.spacing.md
      text: root.summary()
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.triggerFontSize
      elide: Text.ElideRight
    }

    Text {
      id: chevron
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.rightMargin: trigger.borderRight + Style.spacing.controlGap
      text: "󰅀"
      color: Qt.darker(root.foreground, 1.2)
      font.family: root.fontFamily
      font.pixelSize: root.triggerFontSize
    }

    MouseArea {
      anchors.fill: parent
      enabled: root.enabled
      cursorShape: Qt.PointingHandCursor
      onClicked: {
        trigger.forceActiveFocus()
        root.toggle()
      }
    }
  }

  Popup {
    id: popup
    x: (root.width - width) / 2
    y: trigger.height + Style.spacing.xxs
    width: Math.max(root.width, Style.space(225))
    implicitHeight: Math.min(menuColumn.implicitHeight + topPadding + bottomPadding, Style.space(360))
    padding: Style.spacing.hairline
    leftPadding: Border.left(root.popupBorderSpec) + Style.spacing.hairline
    rightPadding: Border.right(root.popupBorderSpec) + Style.spacing.hairline
    topPadding: Border.top(root.popupBorderSpec) + Style.spacing.hairline
    bottomPadding: Border.bottom(root.popupBorderSpec) + Style.spacing.hairline
    focus: true

    background: BorderSurface {
      color: root.background
      borderSpec: root.popupBorderSpec
      radius: Style.cornerRadius
    }

    Keys.onEscapePressed: popup.close()

    contentItem: Flickable {
      implicitHeight: Math.min(contentHeight, Style.space(356))
      contentWidth: width
      contentHeight: menuColumn.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: menuColumn
        width: parent.width

        Repeater {
          model: root.descriptors

          delegate: Column {
            id: descriptorSection
            required property var modelData
            required property int index
            readonly property var descriptorData: modelData
            width: menuColumn.width

            Rectangle {
              visible: descriptorSection.index > 0
              width: parent.width
              height: visible ? Style.spacing.hairline : 0
              color: Util.alpha(root.foreground, 0.14)
            }

            Text {
              width: parent.width
              leftPadding: Style.spacing.controlPaddingX
              rightPadding: Style.spacing.controlPaddingX
              topPadding: Style.spacing.lg
              bottomPadding: Style.spacing.sm
              text: String(descriptorSection.descriptorData.label || "")
              color: Color.muted
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              visible: text.length > 0
              width: parent.width
              leftPadding: Style.spacing.controlPaddingX
              rightPadding: Style.spacing.controlPaddingX
              bottomPadding: Style.spacing.sm
              text: String(descriptorSection.descriptorData.description || "")
              color: Color.muted
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
            }

            Repeater {
              model: descriptorSection.descriptorData.choices || []

              delegate: Rectangle {
                id: choiceRow
                required property var modelData
                readonly property var choiceData: modelData
                readonly property bool selected: String(descriptorSection.descriptorData.currentValue) === String(choiceData.id)
                width: descriptorSection.width
                height: choiceContents.implicitHeight + Style.spacing.md * 2
                radius: Style.cornerRadius
                color: selected
                  ? Style.selectedFillFor(root.foreground, root.accent)
                  : (choiceMouse.containsMouse ? Style.hoverFillFor(root.foreground, root.accent) : "transparent")

                Column {
                  id: choiceContents
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.spacing.controlPaddingX
                  anchors.rightMargin: Style.spacing.controlPaddingX
                  spacing: Style.spacing.xxs

                  Row {
                    width: parent.width
                    spacing: Style.spacing.sm

                    Text {
                      width: Math.max(0, parent.width - (defaultBadge.visible ? defaultBadge.width + parent.spacing : 0))
                      text: String(choiceRow.choiceData.label || choiceRow.choiceData.id || "")
                      color: choiceRow.selected
                        ? Style.selectedStateColor(root.foreground, root.accent)
                        : root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      elide: Text.ElideRight
                    }

                    BorderSurface {
                      id: defaultBadge
                      visible: choiceRow.choiceData.isDefault === true
                      width: defaultText.implicitWidth + Style.spacing.md * 2
                      height: defaultText.implicitHeight + Style.spacing.xxs * 2
                      radius: height / 2
                      color: Util.alpha(root.foreground, 0.07)
                      borderSpec: Border.controlSpec("normal", root.foreground, root.accent)

                      Text {
                        id: defaultText
                        anchors.centerIn: parent
                        text: "Default"
                        color: Color.muted
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                      }
                    }
                  }

                  Text {
                    visible: text.length > 0
                    width: parent.width
                    text: String(choiceRow.choiceData.description || "")
                    color: Color.muted
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.Wrap
                  }
                }

                MouseArea {
                  id: choiceMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    root.changed(String(descriptorSection.descriptorData.id), String(choiceRow.choiceData.id))
                    popup.close()
                  }
                }
              }
            }

            Item { width: parent.width; height: Style.spacing.sm }
          }
        }
      }
    }
  }
}
