import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "CompactLabels.js" as CompactLabels

Item {
  id: root

  property string value: ""
  property var options: []
  property color foreground: Color.popups.text
  property color background: Color.popups.background
  property color popupBorder: Color.popups.border
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property real triggerFontSize: Style.font.body
  property int rowHeight: Style.spacing.controlHeight
  property int popupRowHeight: Style.spacing.popupRowHeight
  property bool showProviderColumn: true
  readonly property var popupBorderSpec: Border.localOrSurfaceSpec("popups", "border", popupBorder, Color.popups.border, Style.normalBorderWidth)
  readonly property bool popupOpen: popup.opened

  signal changed(string value)

  function optionValue(option) {
    return option && typeof option === "object" ? String(option.value) : String(option)
  }

  function optionLabel(option) {
    return option && typeof option === "object" ? String(option.label) : String(option)
  }

  function optionProvider(option) {
    return option && typeof option === "object" ? String(option.providerLabel || "") : ""
  }

  function optionModel(option) {
    return option && typeof option === "object" ? String(option.modelLabel || option.label) : String(option)
  }

  function currentModelLabel() {
    for (var i = 0; i < options.length; i++) {
      if (optionValue(options[i]) === value)
        return CompactLabels.modelName(optionModel(options[i]), optionProvider(options[i]))
    }
    return value
  }

  function open() { popup.open() }
  function close() { popup.close() }
  function toggle() { popup.opened ? popup.close() : popup.open() }

  implicitWidth: Style.spacing.dropdownWidth
  implicitHeight: rowHeight

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
    activeFocusOnTab: true

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
      text: root.currentModelLabel()
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
      cursorShape: Qt.PointingHandCursor
      onClicked: {
        trigger.forceActiveFocus()
        root.toggle()
      }
    }
  }

  Popup {
    id: popup
    x: 0
    y: trigger.height + Style.spacing.xxs
    width: Math.max(root.width, root.showProviderColumn ? Style.space(420) : Style.space(225))
    implicitHeight: Math.min(
      root.options.length * root.popupRowHeight
        + Math.max(0, root.options.length - 1) * Style.spacing.labelGap
        + Style.spacing.xxs,
      root.popupRowHeight * 8 + 7 * Style.spacing.labelGap + Style.spacing.xxs)
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

    onOpened: {
      optionList.currentIndex = Math.max(0, optionList.indexOfValue(root.value))
      optionList.forceActiveFocus()
    }

    contentItem: ListView {
      id: optionList
      spacing: Style.spacing.labelGap
      implicitHeight: contentHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      model: root.options
      currentIndex: -1

      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          popup.close()
          event.accepted = true
        } else if (event.key === Qt.Key_Down || event.text === "j") {
          optionList.currentIndex = Math.min(root.options.length - 1, optionList.currentIndex + 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Up || event.text === "k") {
          optionList.currentIndex = Math.max(0, optionList.currentIndex - 1)
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          optionList.selectCurrent()
          event.accepted = true
        }
      }

      function indexOfValue(candidate) {
        for (var i = 0; i < root.options.length; i++)
          if (root.optionValue(root.options[i]) === candidate) return i
        return -1
      }

      function selectCurrent() {
        if (currentIndex < 0 || currentIndex >= root.options.length) return
        var selectedValue = root.optionValue(root.options[currentIndex])
        root.changed(selectedValue)
        popup.close()
      }

      delegate: Rectangle {
        id: optionRow
        required property var modelData
        required property int index
        readonly property bool selected: root.optionValue(modelData) === root.value
        width: optionList.width
        height: root.popupRowHeight
        radius: Style.cornerRadius
        color: index === optionList.currentIndex
          ? Style.hoverFillFor(root.foreground, root.accent)
          : (selected ? Style.selectedFillFor(root.foreground, root.accent) : "transparent")

        Row {
          anchors.fill: parent
          anchors.leftMargin: Style.spacing.controlPaddingX
          anchors.rightMargin: Style.spacing.controlPaddingX
          spacing: root.showProviderColumn ? Style.spacing.md : 0

          Text {
            visible: root.showProviderColumn
            width: visible ? Style.space(110) : 0
            anchors.verticalCenter: parent.verticalCenter
            text: root.optionProvider(optionRow.modelData)
            color: Color.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }

          Text {
            width: Math.max(0, parent.width - x)
            anchors.verticalCenter: parent.verticalCenter
            text: root.optionModel(optionRow.modelData)
            color: optionRow.index === optionList.currentIndex
              ? Style.hoverStateColor(root.foreground, root.accent)
              : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onPositionChanged: optionList.currentIndex = optionRow.index
          onClicked: optionList.selectCurrent()
        }
      }
    }
  }
}
