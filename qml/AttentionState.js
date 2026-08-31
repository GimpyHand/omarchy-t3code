.pragma library

function inputColor() {
  return "#f59e0b"
}

function attentionColor(phase, urgentColor) {
  return phase === "inputNeeded" ? inputColor() : urgentColor
}
