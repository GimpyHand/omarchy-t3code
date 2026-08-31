.pragma library

function routeForOpen(authPhase, requestedRoute, hasThread) {
  if (requestedRoute === "thread" && hasThread) return "thread"
  return authPhase === "signedIn" ? "inbox" : "login"
}

function routeAfterAuthentication(authPhase) {
  return authPhase === "signedIn" ? "inbox" : "login"
}
