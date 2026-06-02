import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App, { ShareView } from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import { readShareFromUrl } from "./lib/share";

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
