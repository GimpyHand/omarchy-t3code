pragma ComponentBehavior: Bound

import QtQuick
import qs.Commons
import qs.Ui

BorderSurface {
  id: root
  required property var summaryData
  signal revealRequested()

  property bool expanded: false
  property var collapsedDirectories: ({})

  readonly property var files: summaryData && summaryData.files ? summaryData.files : []
  readonly property int fileCount: files.length
  readonly property int totalAdditions: sumStat("additions")
  readonly property int totalDeletions: sumStat("deletions")
  readonly property var treeRows: buildTreeRows()

  function stat(value) {
    var number = Number(value)
    return isFinite(number) && number > 0 ? Math.floor(number) : 0
  }

  function sumStat(key) {
    var total = 0
    for (var i = 0; i < files.length; i++) total += stat(files[i][key])
    return total
  }

  function directory(parent, name, path) {
    for (var i = 0; i < parent.directories.length; i++)
      if (parent.directories[i].name === name) return parent.directories[i]
    var created = { name: name, path: path, additions: 0, deletions: 0, directories: [], files: [] }
    parent.directories.push(created)
    return created
  }

  function sorted(items) {
    var copy = items.slice()
    copy.sort(function(left, right) { return String(left.name).localeCompare(String(right.name)) })
    return copy
  }

  function appendDirectoryRows(node, depth, rows) {
    var displayName = node.name
    var compacted = node
    while (compacted.files.length === 0 && compacted.directories.length === 1) {
      compacted = compacted.directories[0]
      displayName += "/" + compacted.name
    }
    var isExpanded = root.collapsedDirectories[String(compacted.path)] !== true
    rows.push({
      rowKind: "directory",
      name: displayName,
      path: compacted.path,
      depth: depth,
      additions: compacted.additions,
      deletions: compacted.deletions,
      expanded: isExpanded
    })
    if (!isExpanded) return
    var childDirectories = sorted(compacted.directories)
    for (var d = 0; d < childDirectories.length; d++) appendDirectoryRows(childDirectories[d], depth + 1, rows)
    var childFiles = sorted(compacted.files)
    for (var f = 0; f < childFiles.length; f++) {
      var file = childFiles[f]
      rows.push({
        rowKind: "file",
        name: file.name,
        path: file.path,
        depth: depth + 1,
        additions: file.additions,
        deletions: file.deletions,
        expanded: false
      })
    }
  }

  function buildTreeRows() {
    // Reading this property makes directory toggles invalidate the derived rows.
    var collapsed = root.collapsedDirectories
    var tree = { name: "", path: "", additions: 0, deletions: 0, directories: [], files: [] }
    for (var i = 0; i < files.length; i++) {
      var file = files[i]
      var segments = String(file.path || "").replace(/\\/g, "/").split("/").filter(function(segment) { return segment.length > 0 })
      if (segments.length === 0) continue
      var additions = stat(file.additions)
      var deletions = stat(file.deletions)
      var current = tree
      current.additions += additions
      current.deletions += deletions
      var path = ""
      for (var s = 0; s < segments.length - 1; s++) {
        path = path ? path + "/" + segments[s] : segments[s]
        current = directory(current, segments[s], path)
        current.additions += additions
        current.deletions += deletions
      }
      current.files.push({
        name: segments[segments.length - 1],
        path: segments.join("/"),
        additions: additions,
        deletions: deletions,
        kind: String(file.kind || "modified")
      })
    }

    var rows = []
    var topDirectories = sorted(tree.directories)
    for (var d = 0; d < topDirectories.length; d++) appendDirectoryRows(topDirectories[d], 0, rows)
    var topFiles = sorted(tree.files)
    for (var f = 0; f < topFiles.length; f++) {
      var topFile = topFiles[f]
      rows.push({
        rowKind: "file",
        name: topFile.name,
        path: topFile.path,
        depth: 0,
        additions: topFile.additions,
        deletions: topFile.deletions,
        expanded: false
      })
    }
    return rows
  }

  function toggleDirectory(path) {
    var next = {}
    for (var key in collapsedDirectories) next[key] = collapsedDirectories[key]
    next[String(path)] = next[String(path)] !== true
    collapsedDirectories = next
  }

  width: parent ? parent.width : implicitWidth
  height: content.implicitHeight + Style.spacing.md * 2
  visible: fileCount > 0 && summaryData && summaryData.status === "ready"
  radius: Style.cornerRadius
  color: Util.alpha(Color.foreground, 0.025)
  borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)

  Column {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.margins: Style.spacing.md
    spacing: root.expanded ? Style.spacing.sm : 0

    Row {
      id: header
      width: parent.width
      spacing: Style.spacing.sm

      Button {
        width: Math.max(0, parent.width - headerStats.implicitWidth - parent.spacing)
        leftAlign: true
        iconText: root.expanded ? "󰅀" : "󰅂"
        text: String(root.fileCount) + " changed file" + (root.fileCount === 1 ? "" : "s")
          + "  " + (root.expanded ? "Hide files" : "Show files")
        foreground: Color.foreground
        fontSize: Style.font.caption
        horizontalPadding: Style.spacing.xs
        tooltipText: root.expanded ? "Hide changed files" : "Show changed files"
        onClicked: {
          root.expanded = !root.expanded
          if (root.expanded) root.revealRequested()
        }
      }

      Row {
        id: headerStats
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.spacing.sm
        Text {
          visible: root.totalAdditions > 0
          text: "+" + String(root.totalAdditions)
          color: "#22c55e"
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
        Text {
          visible: root.totalDeletions > 0
          text: "−" + String(root.totalDeletions)
          color: Color.urgent
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }

    }

    Column {
      id: tree
      visible: root.expanded
      width: parent.width
      spacing: Style.spacing.xs

      Repeater {
        model: root.treeRows

        Item {
          id: treeRow
          required property var modelData
          width: tree.width
          height: Style.space(28)

          Rectangle {
            anchors.fill: parent
            color: rowMouse.containsMouse ? Util.alpha(Color.foreground, 0.055) : "transparent"
            radius: Style.cornerRadius
          }

          Row {
            id: rowLabel
            anchors.left: parent.left
            anchors.leftMargin: Style.spacing.sm + Number(treeRow.modelData.depth || 0) * Style.space(14)
            anchors.right: rowStats.left
            anchors.rightMargin: Style.spacing.sm
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.sm

            Text {
              width: Style.space(12)
              text: treeRow.modelData.rowKind === "directory" ? (treeRow.modelData.expanded ? "󰅀" : "󰅂") : ""
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
            Text {
              text: treeRow.modelData.rowKind === "directory" ? "󰉋" : "󰈔"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }
            Text {
              width: Math.max(0, rowLabel.width - Style.space(46))
              text: String(treeRow.modelData.name || "")
              color: treeRow.modelData.rowKind === "directory" ? Color.muted : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              elide: Text.ElideMiddle
            }
          }

          Row {
            id: rowStats
            anchors.right: parent.right
            anchors.rightMargin: Style.spacing.sm
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.sm
            Text {
              visible: Number(treeRow.modelData.additions || 0) > 0
              text: "+" + String(treeRow.modelData.additions || 0)
              color: "#22c55e"
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
            Text {
              visible: Number(treeRow.modelData.deletions || 0) > 0
              text: "−" + String(treeRow.modelData.deletions || 0)
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          MouseArea {
            id: rowMouse
            anchors.fill: parent
            enabled: treeRow.modelData.rowKind === "directory"
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.toggleDirectory(String(treeRow.modelData.path))
          }
        }
      }
    }
  }
}
