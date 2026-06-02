import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App, { ShareView } from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import { readShareFromUrl } from "./lib/share";

// ── Native-app feel guards ──────────────────────────────────────────────────
// iOS Safari ignores `user-scalable=no`, so block the zoom gestures directly.
// These make the page behave like an installed app: no pinch-zoom, no
// double-tap-to-zoom, no accidental zoom from a two-finger touch.
if (typeof window !== "undefined") {
  // Pinch-zoom (Safari fires gesture* events for multi-touch zoom).
  ["gesturestart", "gesturechange", "gestureend"].forEach(evt =>
    document.addEventListener(evt, e => e.preventDefault(), { passive: false })
  );
  // Any touch involving 2+ fingers → prevent (kills pinch before it starts).
  document.addEventListener("touchmove", e => {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  // Double-tap-to-zoom: swallow only when the second tap lands at nearly the
  // same spot within 300ms (a real zoom gesture), so fast taps on different
  // controls still register normally.
  let lastTouchEnd = 0, lastX = 0, lastY = 0;
  document.addEventListener("touchend", e => {
    const now = Date.now();
    const t = e.changedTouches && e.changedTouches[0];
    const x = t ? t.clientX : 0, y = t ? t.clientY : 0;
    const samePlace = Math.abs(x - lastX) < 40 && Math.abs(y - lastY) < 40;
    if (now - lastTouchEnd <= 300 && samePlace) e.preventDefault();
    lastTouchEnd = now; lastX = x; lastY = y;
  }, { passive: false });
}

// If the URL carries a #share= payload, render the read-only shared card and
// nothing else — no app shell, no memory, no auth. Otherwise render the app.
const shared = readShareFromUrl();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      {shared ? <ShareView payload={shared} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
