.pragma library

function durationLabel(startIso, nowMs) {
  var startedAtMs = Date.parse(String(startIso || ""))
  if (isNaN(startedAtMs) || !isFinite(nowMs)) return ""

  var elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  if (elapsedSeconds < 60) return String(elapsedSeconds) + "s"

  var hours = Math.floor(elapsedSeconds / 3600)
  var minutes = Math.floor((elapsedSeconds % 3600) / 60)
  var seconds = elapsedSeconds % 60
  if (hours > 0) return minutes > 0 ? String(hours) + "h " + String(minutes) + "m" : String(hours) + "h"
  return seconds > 0 ? String(minutes) + "m " + String(seconds) + "s" : String(minutes) + "m"
}

function statusLabel(phase, startIso, nowMs) {
  if (phase !== "working" && phase !== "starting") return ""
  var duration = durationLabel(startIso, nowMs)
  return duration ? "Working for " + duration : "Working..."
}
