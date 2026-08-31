.pragma library

function threadPhase(inbox) {
  var phases = ["inputNeeded", "approvalNeeded", "failed", "working", "starting", "ready"]
  var groups = [inbox && inbox.pinned || [], inbox && inbox.active || [], inbox && inbox.snoozed || []]

  for (var p = 0; p < phases.length; p++)
    for (var g = 0; g < groups.length; g++)
      for (var i = 0; i < groups[g].length; i++)
        if (groups[g][i].phase === phases[p]) return phases[p]

  return "idle"
}

function phaseLabel(phase) {
  if (phase === "inputNeeded") return "Input"
  if (phase === "approvalNeeded") return "Approval"
  if (phase === "failed") return "Failed"
  if (phase === "working") return "Working"
  if (phase === "starting") return "Starting"
  if (phase === "ready") return "Ready"
  return "Idle"
}

function stateLabel(service) {
  if (!service || service.ready !== true) return "Starting"
  if (service.authPhase === "signedOut") return "Signed out"
  if (service.authPhase === "signingIn") return "Signing in"
  if (service.authPhase === "error") return "Error"

  if (service.connectionPhase === "discovering") return "Discovering"
  if (service.connectionPhase === "connecting") return "Connecting"
  if (service.connectionPhase === "reconnecting") return "Reconnecting"
  if (service.connectionPhase === "blocked") return "Blocked"
  if (service.connectionPhase === "error") return "Error"
  if (service.connectionPhase !== "connected") return "Offline"

  return phaseLabel(threadPhase(service.inbox))
}

function stateColor(service) {
  if (!service || service.ready !== true) return "#3b82f6"
  if (service.authPhase === "signedOut") return "#ef4444"
  if (service.authPhase === "signingIn") return "#3b82f6"
  if (service.authPhase === "error") return "#ef4444"

  if (service.connectionPhase === "discovering") return "#3b82f6"
  if (service.connectionPhase === "connecting") return "#3b82f6"
  if (service.connectionPhase === "reconnecting") return "#3b82f6"
  if (service.connectionPhase === "blocked") return "#ef4444"
  if (service.connectionPhase === "error") return "#ef4444"
  if (service.connectionPhase !== "connected") return "#ef4444"

  var phase = threadPhase(service.inbox)
  if (phase === "inputNeeded") return "#f59e0b"
  if (phase === "approvalNeeded") return "#ef4444"
  if (phase === "failed") return "#ef4444"
  if (phase === "working" || phase === "starting") return "#3b82f6"
  return "#22c55e"
}
