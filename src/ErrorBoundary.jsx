import React from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Global error boundary. Without this, a single render throw anywhere in the
// tree blanks the entire app (which is exactly what the History "i is not
// defined" bug did). With it, a crash degrades to a recoverable screen instead
// of a white void — the user can reload or go back to a safe state, and their
// saved decisions (in localStorage / cloud) are untouched.
// ─────────────────────────────────────────────────────────────────────────────
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface for debugging without crashing; no external logging by default.
    try { console.error("[vestige] render error:", error, info?.componentStack); } catch {}
  }

  handleReload = () => {
    try { window.location.reload(); } catch { this.setState({ error: null }); }
  };

  handleReset = () => {
    // Soft recovery: clear the error and re-render from scratch. Data is intact.
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#08080d", padding: 24, fontFamily: "'Inter', -apple-system, sans-serif",
        textAlign: "center"
      }}>
        <div style={{ maxWidth: 420 }}>
          <svg width="44" height="44" viewBox="0 0 32 32" fill="none" style={{ marginBottom: 20, opacity: 0.9 }}>
            <path d="M3 5 L16 27 L29 5" stroke="#9B7FD4" strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
            <circle cx="16" cy="16" r="3.2" fill="#9B7FD4" />
          </svg>
          <h1 style={{
            fontFamily: "'Instrument Serif', Georgia, serif", fontWeight: 400, fontSize: 28,
            color: "#fff", margin: "0 0 12px", letterSpacing: "-0.02em"
          }}>Something broke on screen.</h1>
          <p style={{ fontSize: 14, color: "#888", lineHeight: 1.7, margin: "0 0 24px" }}>
            Vestige hit an unexpected error rendering this view. Your saved decisions are safe — this is just the display. Reloading usually clears it.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button onClick={this.handleReload} style={{
              background: "linear-gradient(135deg, #7C5CBF, #9B7FD4)", border: "none",
              color: "#fff", fontSize: 14, fontWeight: 600, padding: "12px 22px",
              borderRadius: 10, cursor: "pointer", fontFamily: "inherit"
            }}>Reload Vestige</button>
            <button onClick={this.handleReset} style={{
              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
              color: "#aaa", fontSize: 14, fontWeight: 500, padding: "12px 22px",
              borderRadius: 10, cursor: "pointer", fontFamily: "inherit"
            }}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}
