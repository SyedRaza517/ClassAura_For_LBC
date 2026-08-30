import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { AuthProvider } from "./auth";
import { loadBranding } from "./branding";
import { API_BASE, currentTenant } from "./api";
import App from "./App";

// Ask the server which institution this is and what it looks like. Started here
// rather than in a component so it is in flight before React mounts, and deliberately
// not awaited — the app renders in the neutral palette and repaints when the answer
// arrives. Blocking first paint on a decorative fetch would trade a colour for a
// blank screen on a slow connection.
loadBranding(API_BASE, currentTenant);

// A reload lands at the top of the screen, not where the last one was left.
//
// Browsers restore the previous scroll offset on a refresh, which is right for a
// document and wrong here: the app decides what to render AFTER the restore, so the
// offset gets applied to whichever screen comes back — often a shorter one, or a
// different one entirely. Turning it off is the whole fix; each screen puts itself at
// the top, and the browser stops arguing about it.
if (typeof window !== "undefined" && window.history && "scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

// Catches any render/runtime error in the tree so a single crashing component
// shows a friendly, recoverable screen instead of a blank white page.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
    // Keep the component stack so the details panel can name the screen that failed.
    this.setState({ info: (info?.componentStack || "").split("\n").slice(0, 8).join("\n").trim() });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", background: "#eef1f6", color: "#1a2332" }}>
        <div style={{ maxWidth: 420, width: "100%", background: "#fff", borderRadius: 16, padding: 28, textAlign: "center", boxShadow: "0 2px 16px rgba(15,23,42,.1)" }}>
          <div style={{ width: 56, height: 56, margin: "0 auto 14px", borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>⚠️</div>
          <h1 style={{ margin: "0 0 6px", fontSize: 19, fontWeight: 800 }}>Something went wrong</h1>
          <p style={{ margin: "0 0 20px", fontSize: 14, color: "#64748b", lineHeight: 1.5 }}>The app hit an unexpected error on this screen. Reloading usually fixes it.</p>
          <button onClick={() => window.location.reload()} style={{ background: "var(--brand-primary, #334155)", color: "#fff", border: 0, borderRadius: 12, padding: "12px 22px", fontSize: 14, fontWeight: 700, cursor: "pointer", width: "100%" }}>Reload the app</button>
          {/* The message itself, collapsed. Without it a crash report is just "something
              went wrong", which is impossible to act on — this makes it reportable. */}
          <details style={{ marginTop: 14, textAlign: "left" }}>
            <summary style={{ fontSize: 12, color: "#94a3b8", cursor: "pointer" }}>Show technical details</summary>
            <pre style={{ marginTop: 8, maxHeight: 180, overflow: "auto", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#475569" }}>
              {String(this.state.error?.message || this.state.error)}
              {this.state.info ? `\n\n${this.state.info}` : ""}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
